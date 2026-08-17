#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
数据接收服务 v3 — 结构化存储 + 自动归档
技术栈：FastAPI + uvicorn(uvloop) + asyncpg(PostgreSQL) + 写入缓冲队列

生产化改造（vs SQLite 版）：
  1. 存储切换到 PostgreSQL，连接参数全部来自环境变量（见 db.py）
  2. 雅典娜收入数据从本地 JSON 文件迁移到 athena_revenue 表
  3. 按月分表 records_YYYYMM 与复合索引保持不变，dashboard 查询无需改动
  4. 内存写入缓冲队列保护：队列满时丢弃而非阻塞
"""

import asyncio
import json
import os
import time
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Request

import db as dbmod

# ── 配置 ────────────────────────────────────────────────────────
QUEUE_MAXSIZE  = int(os.getenv("QUEUE_MAXSIZE", "20000"))
BATCH_SIZE     = int(os.getenv("BATCH_SIZE", "500"))
FLUSH_INTERVAL = float(os.getenv("FLUSH_INTERVAL", "1.0"))  # 秒

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

# ── FastAPI 应用 ────────────────────────────────────────────────
app = FastAPI(title="数据接收服务", version="3.0.0")

write_queue: asyncio.Queue = None
writer_task = None
maintenance_task = None

# ── 辅助函数 ────────────────────────────────────────────────────
def current_table():
    """当前月份的表名"""
    return "records_" + datetime.now().strftime("%Y%m")

def table_for_date(dt_str):
    """根据日期字符串推断表名"""
    try:
        dt = datetime.strptime(dt_str[:10], "%Y-%m-%d")
        return "records_" + dt.strftime("%Y%m")
    except Exception:
        return current_table()

def extract_fields(source: str, params: dict):
    """从 payload 中提取关键结构化字段"""
    app_id = params.get("app_id") or params.get("bundle_id") or params.get("app_name") or ""
    event_name = params.get("event_name") or params.get("event") or ""
    event_time = params.get("event_time") or params.get("created_at") or ""
    # 优先使用已转换的 USD 值，避免非美元币种原始值被当 USD 计算
    raw_currency = params.get("event_revenue_currency") or params.get("currency") or "USD"
    event_revenue_usd = params.get("event_revenue_usd")
    event_revenue_raw = params.get("event_revenue") or params.get("revenue") or ""

    if event_revenue_usd is not None and str(event_revenue_usd).strip():
        revenue_str = str(event_revenue_usd)
        currency = "USD"
    else:
        revenue_str = str(event_revenue_raw) if event_revenue_raw else ""
        currency = raw_currency
    campaign = params.get("campaign") or ""
    media_source = source
    ad_id = params.get("af_ad_id") or params.get("adgroup_id") or ""
    adset = params.get("af_adset") or params.get("adset") or ""
    country = params.get("country_code") or params.get("country") or ""
    device_id = params.get("advertising_id") or params.get("idfa") or params.get("gps_adid") or ""
    install_time = params.get("install_time") or ""
    is_retargeting = params.get("is_retargeting", False)

    # Parse revenue to float
    try:
        revenue = float(revenue_str) if revenue_str else None
    except (ValueError, TypeError):
        revenue = None

    return {
        "app_id": app_id,
        "event_name": event_name,
        "event_time": event_time,
        "revenue": revenue,
        "currency": currency,
        "campaign": campaign,
        "media_source": media_source,
        "ad_id": ad_id,
        "adset": adset,
        "country": country,
        "device_id": device_id,
        "install_time": install_time,
        "is_retargeting": 1 if is_retargeting else 0,
    }

# ── 数据库初始化 ────────────────────────────────────────────────
async def init_db():
    pool = await dbmod.init_pool()
    async with pool.acquire() as conn:
        await dbmod.ensure_shared_tables(conn)
        await dbmod.ensure_record_table(conn, current_table())
    logger.info("PostgreSQL 初始化完成（月表: %s）", current_table())

# ── 后台批量写入 Worker ─────────────────────────────────────────
_INSERT_SQL_CACHE: dict[str, str] = {}

def _insert_sql(table: str) -> str:
    if table not in _INSERT_SQL_CACHE:
        cols = ", ".join(dbmod.RECORD_COLUMNS)
        ph = ", ".join(f"${i}" for i in range(1, len(dbmod.RECORD_COLUMNS) + 1))
        _INSERT_SQL_CACHE[table] = f"INSERT INTO {table} ({cols}) VALUES ({ph})"
    return _INSERT_SQL_CACHE[table]

async def batch_writer():
    buffer = []
    last_flush = time.monotonic()
    last_table = current_table()

    pool = dbmod.get_pool()
    async with pool.acquire() as conn:
        await dbmod.ensure_record_table(conn, last_table)

        while True:
            try:
                timeout = max(0.05, FLUSH_INTERVAL - (time.monotonic() - last_flush))
                item = await asyncio.wait_for(write_queue.get(), timeout=timeout)
                if item is None:
                    break
                buffer.append(item)
                write_queue.task_done()
            except asyncio.TimeoutError:
                pass

            # Drain queue up to batch size
            while not write_queue.empty() and len(buffer) < BATCH_SIZE:
                try:
                    item = write_queue.get_nowait()
                    if item is None:
                        break
                    buffer.append(item)
                    write_queue.task_done()
                except asyncio.QueueEmpty:
                    break

            now = time.monotonic()
            should_flush = (
                len(buffer) >= BATCH_SIZE or
                (buffer and (now - last_flush) >= FLUSH_INTERVAL)
            )

            if should_flush and buffer:
                tbl = current_table()
                if tbl != last_table:
                    await dbmod.ensure_record_table(conn, tbl)
                    last_table = tbl

                try:
                    await conn.executemany(_insert_sql(tbl), buffer)
                    # Sync user_lookup for af_complete_registration events with user_id
                    ul_rows = []
                    for row in buffer:
                        # buffer format 同 RECORD_COLUMNS 顺序：
                        # (source, app_id, event_name, event_time, revenue, currency,
                        #  campaign, media_source, ad_id, adset, country, device_id,
                        #  install_time, is_retargeting, payload, created_at)
                        if row[2] == 'af_complete_registration' and row[14]:  # event_name, payload
                            try:
                                p = json.loads(row[14])
                                ev = p.get('event_value', '')
                                if ev and 'user_id' in ev:
                                    uid = json.loads(ev).get('user_id')
                                    if uid and isinstance(uid, int):
                                        ul_rows.append((uid, row[1], row[3], row[12], row[14], tbl))
                            except Exception:
                                pass
                    if ul_rows:
                        await conn.executemany(
                            "INSERT INTO user_lookup (user_id, app_id, event_time, install_time, payload, table_name) "
                            "VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO NOTHING",
                            ul_rows
                        )
                    logger.debug("批量写入 %d 条 → %s", len(buffer), tbl)
                    buffer.clear()
                    last_flush = time.monotonic()
                except Exception as e:
                    logger.error("批量写入失败: %s", e)
                    await asyncio.sleep(0.5)

        # Flush remaining on shutdown
        if buffer:
            tbl = current_table()
            await dbmod.ensure_record_table(conn, tbl)
            await conn.executemany(_insert_sql(tbl), buffer)
            logger.info("关闭前最终写入 %d 条", len(buffer))

# ── 定期维护 ────────────────────────────────────────────────────
async def maintenance_loop():
    """每天 4:00 记录一次库表规模（PostgreSQL 由 autovacuum 自动清理碎片）"""
    while True:
        now = datetime.now()
        target = now.replace(hour=4, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        wait_secs = (target - now).total_seconds()
        await asyncio.sleep(wait_secs)

        logger.info("[Maintenance] 开始每日维护")
        try:
            pool = dbmod.get_pool()
            async with pool.acquire() as conn:
                size = await conn.fetchval("SELECT pg_database_size(current_database())")
                logger.info("[Maintenance] 数据库大小 %.1f GB", (size or 0) / 1024**3)
        except Exception as e:
            logger.error("[Maintenance] 维护失败: %s", e)

# ── 生命周期事件 ────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    global write_queue, writer_task, maintenance_task
    write_queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
    await init_db()
    writer_task = asyncio.ensure_future(batch_writer())
    maintenance_task = asyncio.ensure_future(maintenance_loop())
    logger.info("服务启动，Writer + Maintenance 已就绪")

@app.on_event("shutdown")
async def shutdown():
    global write_queue, writer_task, maintenance_task
    if maintenance_task:
        maintenance_task.cancel()
    if write_queue:
        await write_queue.join()
        write_queue.put_nowait(None)
    if writer_task:
        await writer_task
    await dbmod.close_pool()
    logger.info("服务已关闭，所有数据已落盘")

# ── 通用入队函数 ────────────────────────────────────────────────
def enqueue_record(source: str, params: dict):
    """提取字段 + 入队，返回队列是否成功"""
    fields = extract_fields(source, params)
    payload_json = json.dumps(params, ensure_ascii=False) if params else "{}"
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    row = (
        source,
        fields["app_id"],
        fields["event_name"],
        fields["event_time"],
        fields["revenue"],
        fields["currency"],
        fields["campaign"],
        fields["media_source"],
        fields["ad_id"],
        fields["adset"],
        fields["country"],
        fields["device_id"],
        fields["install_time"],
        fields["is_retargeting"],
        payload_json,
        ts,
    )

    if write_queue.full():
        return False
    write_queue.put_nowait(row)
    return True

# ── 接收 Adjust GET ─────────────────────────────────────────────
@app.get("/adjust", status_code=202)
async def receive_adjust(request: Request):
    params = dict(request.query_params)
    source = params.pop("network", None) or params.pop("platform", None) or "adjust"
    params["_platform"] = "ad"
    if not enqueue_record(source, params):
        raise HTTPException(status_code=503, detail="队列已满")
    return {"status": "queued", "source": source}

# ── 接收 Adjust POST ────────────────────────────────────────────
@app.post("/adjust", status_code=202)
async def receive_adjust_post(request: Request):
    try:
        body: Dict[str, Any] = await request.json()
    except Exception:
        body = dict(request.query_params)

    source = body.pop("network", None) \
             or body.pop("platform", None) \
             or "adjust"
    body["_platform"] = "ad"
    if not enqueue_record(source, body):
        raise HTTPException(status_code=503, detail="队列已满")
    return {"status": "queued", "source": source}

# ── 接收 AppsFlyer GET ──────────────────────────────────────────
@app.get("/appsflyer", status_code=202)
async def receive_appsflyer_get(request: Request):
    params = dict(request.query_params)
    source = params.pop("media_source", None) \
             or params.pop("platform", None) \
             or "appsflyer"
    params["_platform"] = "af"
    if not enqueue_record(source, params):
        raise HTTPException(status_code=503, detail="队列已满")
    return {"status": "queued", "source": source}

# ── 接收 AppsFlyer POST ─────────────────────────────────────────
@app.post("/appsflyer", status_code=202)
async def receive_appsflyer_post(request: Request):
    try:
        body: Dict[str, Any] = await request.json()
    except Exception:
        body = dict(request.query_params)

    source = body.pop("media_source", None) \
             or body.pop("af_channel", None) \
             or body.pop("platform", None) \
             or "appsflyer"
    body["_platform"] = "af"
    if not enqueue_record(source, body):
        raise HTTPException(status_code=503, detail="队列已满")
    return {"status": "queued", "source": source}

# ── 通用 POST ───────────────────────────────────────────────────
@app.post("/data", status_code=202)
async def receive_data_post(request: Request):
    try:
        body: Dict[str, Any] = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="请求体必须是合法的 JSON")

    source = body.pop("source", None) or request.query_params.get("source", "unknown")
    if not enqueue_record(source, body):
        raise HTTPException(status_code=503, detail="队列已满")
    return {"status": "queued", "source": source, "queue_size": write_queue.qsize()}

# ── 查询数据 ────────────────────────────────────────────────────
@app.get("/data")
async def query_data(
    source: Optional[str] = None,
    app_id: Optional[str] = None,
    event_name: Optional[str] = None,
    date: Optional[str] = None,
    table: Optional[str] = None,
    limit: int = 100,
    offset: int = 0
):
    """
    查询数据。table 参数可指定月表（如 records_202605），
    不指定则查当前月。date 参数按 event_time 过滤。
    """
    limit = min(limit, 1000)
    tbl = table or current_table()

    conditions = []
    values = []
    idx = 1
    if source:
        conditions.append(f"source = ${idx}"); values.append(source); idx += 1
    if app_id:
        conditions.append(f"app_id = ${idx}"); values.append(app_id); idx += 1
    if event_name:
        conditions.append(f"event_name = ${idx}"); values.append(event_name); idx += 1
    if date:
        conditions.append(f"event_time LIKE ${idx}"); values.append(f"{date}%"); idx += 1

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    pool = dbmod.get_pool()
    async with pool.acquire() as conn:
        try:
            rows = await conn.fetch(
                f"SELECT * FROM {tbl} {where} ORDER BY id DESC LIMIT ${idx} OFFSET ${idx+1}",
                *values, limit, offset
            )
            total = await conn.fetchval(
                f"SELECT COUNT(*) FROM {tbl} {where}", *values
            )
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    data = []
    for row in rows:
        r = dict(row)
        try:
            r["payload"] = json.loads(r["payload"])
        except Exception:
            pass
        data.append(r)

    return {"total": total, "table": tbl, "limit": limit, "offset": offset, "data": data}

# ── 统计 ────────────────────────────────────────────────────────
@app.get("/stats")
async def stats():
    pool = dbmod.get_pool()
    async with pool.acquire() as conn:
        db_size = await conn.fetchval("SELECT pg_database_size(current_database())") or 0
        tables = await conn.fetch(
            "SELECT tablename FROM pg_tables WHERE tablename LIKE 'records_%' ORDER BY tablename"
        )
        table_stats = []
        total = 0
        for rec in tables:
            tname = rec["tablename"]
            c = await conn.fetchval(f"SELECT COUNT(*) FROM {tname}")
            total += c
            table_stats.append({"table": tname, "count": c})

        tbl = current_table()
        try:
            latest_time = await conn.fetchval(
                f"SELECT created_at FROM {tbl} ORDER BY id DESC LIMIT 1"
            )
        except Exception:
            latest_time = None

        try:
            sources = await conn.fetch(
                f"SELECT source, COUNT(*) as cnt FROM {tbl} GROUP BY source ORDER BY cnt DESC LIMIT 20"
            )
        except Exception:
            sources = []

    return {
        "total_records": total,
        "db_size_mb": round(db_size / 1024 / 1024, 1),
        "queue_size": write_queue.qsize() if write_queue else 0,
        "tables": table_stats,
        "latest": latest_time,
        "sources_this_month": [{"source": r["source"], "count": r["cnt"]} for r in sources],
    }

# ── 健康检查 ────────────────────────────────────────────────────
@app.get("/")
async def health():
    return {
        "status": "ok",
        "version": "3.0.0",
        "queue_size": write_queue.qsize() if write_queue else 0,
        "current_table": current_table(),
    }

# ── 雅典娜收入数据接收（存 athena_revenue 表）──────────────────────
@app.post("/admin", status_code=200)
async def receive_athena(request: Request):
    """接收雅典娜推送的收入数据，按日期合并存入 athena_revenue 表"""
    try:
        body = await request.json()
    except Exception:
        return {"status": "error", "message": "Invalid JSON"}

    date_str = body.get("date", datetime.now().strftime("%Y-%m-%d"))
    new_items = body["data"] if isinstance(body.get("data"), list) else [body]

    pool = dbmod.get_pool()
    async with pool.acquire() as conn:
        existing_raw = await conn.fetchval(
            "SELECT items FROM athena_revenue WHERE date = $1", date_str
        )
        existing = json.loads(existing_raw) if isinstance(existing_raw, str) else (existing_raw or [])
        existing.extend(new_items)
        await conn.execute(
            "INSERT INTO athena_revenue (date, items, updated_at) VALUES ($1, $2::jsonb, now()) "
            "ON CONFLICT (date) DO UPDATE SET items = EXCLUDED.items, updated_at = now()",
            date_str, json.dumps(existing, ensure_ascii=False)
        )

    logger.info("[Athena] 收到数据推送 date=%s, items=%d", date_str, len(existing))
    return {"status": "ok", "date": date_str, "total_items": len(existing)}

@app.get("/admin")
async def get_athena(date: str = None):
    """查询已接收的雅典娜数据"""
    if not date:
        date = datetime.now().strftime("%Y-%m-%d")
    pool = dbmod.get_pool()
    async with pool.acquire() as conn:
        raw = await conn.fetchval("SELECT items FROM athena_revenue WHERE date = $1", date)
    data = json.loads(raw) if isinstance(raw, str) else (raw or [])
    return {"status": "ok", "date": date, "data": data}
