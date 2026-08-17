#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AF Purchase 断崖检测脚本（PostgreSQL 版）

检测逻辑：
  1. af_purchase: 过去60分钟事件数 ≤ 前一天全天平均每小时的 2% → 触发警报
     - 前置条件：前一天同时段(该小时) af_purchase ≥ 100，否则跳过
  2. 总事件健康检查: 过去60分钟总事件数 < 前一天全天平均每小时的 5% → 触发警报
     - 用于排查 AF 回传/接收端自身问题

运行时间: 22:00-08:00（cron 每20分钟）
防重复: 触发后写 lockfile，30分钟内不重复报警

连接参数来自环境变量（DATABASE_URL 或 DATABASE_HOST/PORT/... ），禁止硬编码。
锁目录可用 ALERT_LOCK_DIR 覆盖。
"""

import os
import sys
import time
import json
from datetime import datetime, timedelta

import psycopg
from psycopg.rows import dict_row

# ── 配置 ──────────────────────────────────────────────────
LOCK_DIR = os.getenv(
    "ALERT_LOCK_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".alert_locks"),
)
LOCK_COOLDOWN = 30 * 60  # 30分钟冷却

PURCHASE_THRESHOLD_PCT = 0.02   # 2%
TOTAL_THRESHOLD_PCT = 0.05      # 5%
MIN_BASELINE_PURCHASE = 100     # 昨天同时段最低基数


def _conninfo() -> str:
    url = os.getenv("DATABASE_URL")
    if url:
        return url
    host = os.getenv("DATABASE_HOST") or os.getenv("PGHOST", "localhost")
    port = os.getenv("DATABASE_PORT") or os.getenv("PGPORT", "5432")
    user = os.getenv("DATABASE_USERNAME") or os.getenv("PGUSER", "postgres")
    password = os.getenv("DATABASE_PASSWORD") or os.getenv("PGPASSWORD", "")
    name = os.getenv("DATABASE_NAME") or os.getenv("PGDATABASE", "agentic_ug")
    return f"postgresql://{user}:{password}@{host}:{port}/{name}"


def get_db():
    return psycopg.connect(_conninfo(), row_factory=dict_row)


def current_table():
    return "records_" + datetime.now().strftime("%Y%m")


def yesterday_table():
    yesterday = datetime.now() - timedelta(days=1)
    return "records_" + yesterday.strftime("%Y%m")


def table_exists(conn, table_name):
    cur = conn.execute(
        "SELECT 1 FROM pg_tables WHERE tablename = %s",
        (table_name,),
    )
    return cur.fetchone() is not None


def check_lock(alert_type):
    """检查是否在冷却期内"""
    os.makedirs(LOCK_DIR, exist_ok=True)
    lock_file = os.path.join(LOCK_DIR, f"{alert_type}.lock")
    if os.path.exists(lock_file):
        mtime = os.path.getmtime(lock_file)
        if time.time() - mtime < LOCK_COOLDOWN:
            return True  # 还在冷却
    return False


def set_lock(alert_type):
    """设置冷却锁"""
    os.makedirs(LOCK_DIR, exist_ok=True)
    lock_file = os.path.join(LOCK_DIR, f"{alert_type}.lock")
    with open(lock_file, "w") as f:
        f.write(datetime.now().isoformat())


def get_yesterday_hourly_avg(conn, event_name=None):
    """获取前一天全天平均每小时事件数"""
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    yt = yesterday_table()
    ct = current_table()

    # 可能跨月，两个表都查
    tables_to_query = []
    if table_exists(conn, yt):
        tables_to_query.append(yt)
    if yt != ct and table_exists(conn, ct):
        tables_to_query.append(ct)

    if not tables_to_query:
        return 0

    total = 0
    for tbl in tables_to_query:
        if event_name:
            cur = conn.execute(
                f"SELECT COUNT(*) AS cnt FROM {tbl} "
                f"WHERE created_at::date = %s AND event_name = %s",
                (yesterday, event_name),
            )
        else:
            cur = conn.execute(
                f"SELECT COUNT(*) AS cnt FROM {tbl} "
                f"WHERE created_at::date = %s",
                (yesterday,),
            )
        total += cur.fetchone()["cnt"]

    return total / 24.0


def get_yesterday_same_hour_count(conn, event_name):
    """获取前一天同一小时的事件数（用于最低基数判断）"""
    now = datetime.now()
    yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    current_hour = now.strftime("%H")
    yt = yesterday_table()
    ct = current_table()

    total = 0
    for tbl in [yt, ct]:
        if tbl and table_exists(conn, tbl):
            cur = conn.execute(
                f"SELECT COUNT(*) AS cnt FROM {tbl} "
                f"WHERE created_at::date = %s "
                f"AND to_char(created_at::timestamp, 'HH24') = %s AND event_name = %s",
                (yesterday, current_hour, event_name),
            )
            total += cur.fetchone()["cnt"]
    return total


def get_last_hour_count(conn, event_name=None):
    """获取过去60分钟的事件数"""
    cutoff = (datetime.now() - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")
    ct = current_table()

    if not table_exists(conn, ct):
        return 0

    if event_name:
        cur = conn.execute(
            f"SELECT COUNT(*) AS cnt FROM {ct} "
            f"WHERE created_at >= %s AND event_name = %s",
            (cutoff, event_name),
        )
    else:
        cur = conn.execute(
            f"SELECT COUNT(*) AS cnt FROM {ct} "
            f"WHERE created_at >= %s",
            (cutoff,),
        )
    return cur.fetchone()["cnt"]


def run_check():
    conn = get_db()
    alerts = []

    # ── 检查1: af_purchase 断崖 ──
    if not check_lock("purchase"):
        yesterday_same_hour = get_yesterday_same_hour_count(conn, "af_purchase")

        if yesterday_same_hour >= MIN_BASELINE_PURCHASE:
            avg_hourly_purchase = get_yesterday_hourly_avg(conn, "af_purchase")
            last_hour_purchase = get_last_hour_count(conn, "af_purchase")
            threshold = avg_hourly_purchase * PURCHASE_THRESHOLD_PCT

            if last_hour_purchase <= threshold and avg_hourly_purchase > 0:
                alerts.append({
                    "type": "purchase_cliff",
                    "severity": "critical",
                    "message": (
                        f"af_purchase 断崖警报!\n"
                        f"过去60分钟: {last_hour_purchase} 条\n"
                        f"前一天平均每小时: {avg_hourly_purchase:.0f} 条\n"
                        f"阈值 (2%): {threshold:.0f} 条\n"
                        f"昨天同时段: {yesterday_same_hour} 条"
                    ),
                    "data": {
                        "last_hour": last_hour_purchase,
                        "yesterday_avg": round(avg_hourly_purchase, 1),
                        "threshold": round(threshold, 1),
                        "yesterday_same_hour": yesterday_same_hour,
                    }
                })
                set_lock("purchase")
        else:
            # 昨天同时段基数不足，跳过
            pass

    # ── 检查2: 总事件健康检查 ──
    if not check_lock("total"):
        avg_hourly_total = get_yesterday_hourly_avg(conn)
        last_hour_total = get_last_hour_count(conn)
        total_threshold = avg_hourly_total * TOTAL_THRESHOLD_PCT

        if last_hour_total < total_threshold and avg_hourly_total > 0:
            alerts.append({
                "type": "total_events_low",
                "severity": "critical",
                "message": (
                    f"总事件量异常警报!\n"
                    f"过去60分钟: {last_hour_total} 条\n"
                    f"前一天平均每小时: {avg_hourly_total:.0f} 条\n"
                    f"阈值 (5%): {total_threshold:.0f} 条"
                ),
                "data": {
                    "last_hour": last_hour_total,
                    "yesterday_avg": round(avg_hourly_total, 1),
                    "threshold": round(total_threshold, 1),
                }
            })
            set_lock("total")

    conn.close()

    # ── 输出 ──
    if alerts:
        output = {
            "status": "alert",
            "time": datetime.now().isoformat(),
            "alerts": alerts,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        # TODO: 在这里添加警报发送逻辑（飞书/日志等）
        return 1
    else:
        print(json.dumps({
            "status": "ok",
            "time": datetime.now().isoformat(),
        }, ensure_ascii=False))
        return 0


if __name__ == "__main__":
    sys.exit(run_check())
