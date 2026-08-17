#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性数据迁移：旧 SQLite(data.db) + athena_data/*.json → PostgreSQL。

用法：
    export DATABASE_URL=postgresql://user:pass@host:5432/agentic_ug
    python migrate_sqlite_to_pg.py \
        --sqlite /home/admin/dataserver/data.db \
        --athena-dir /home/admin/dataserver/athena_data

幂等：records_* 用 id 冲突跳过；athena 按 date upsert 覆盖。
先在目标库跑 schema（app.py 启动会自动建表；或先启动一次服务）。
"""

import argparse
import asyncio
import glob
import json
import os
import sqlite3

import asyncpg

import db as dbmod

RECORD_COLS = list(dbmod.RECORD_COLUMNS)


async def migrate_records(sqlite_path: str, pool: asyncpg.Pool) -> None:
    if not os.path.exists(sqlite_path):
        print(f"[records] 跳过：{sqlite_path} 不存在")
        return
    src = sqlite3.connect(sqlite_path)
    src.row_factory = sqlite3.Row
    tables = [
        r[0] for r in src.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' ORDER BY name"
        ).fetchall()
    ]
    async with pool.acquire() as conn:
        for tbl in tables:
            await dbmod.ensure_record_table(conn, tbl)
            rows = src.execute(f"SELECT {', '.join(RECORD_COLS)} FROM {tbl}").fetchall()
            batch = [tuple(r[c] for c in RECORD_COLS) for r in rows]
            if not batch:
                print(f"[records] {tbl}: 空")
                continue
            cols = ", ".join(RECORD_COLS)
            ph = ", ".join(f"${i}" for i in range(1, len(RECORD_COLS) + 1))
            await conn.executemany(f"INSERT INTO {tbl} ({cols}) VALUES ({ph})", batch)
            print(f"[records] {tbl}: 迁移 {len(batch)} 行")

        # user_lookup
        has_ul = src.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='user_lookup'"
        ).fetchone()
        if has_ul:
            ul = src.execute(
                "SELECT user_id, app_id, event_time, install_time, payload, table_name FROM user_lookup"
            ).fetchall()
            ul_batch = [tuple(r) for r in ul]
            if ul_batch:
                await conn.executemany(
                    "INSERT INTO user_lookup (user_id, app_id, event_time, install_time, payload, table_name) "
                    "VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO NOTHING",
                    ul_batch,
                )
                print(f"[user_lookup] 迁移 {len(ul_batch)} 行")
    src.close()


async def migrate_athena(athena_dir: str, pool: asyncpg.Pool) -> None:
    if not athena_dir or not os.path.isdir(athena_dir):
        print(f"[athena] 跳过：{athena_dir} 不存在")
        return
    async with pool.acquire() as conn:
        for fp in sorted(glob.glob(os.path.join(athena_dir, "*.json"))):
            date_str = os.path.splitext(os.path.basename(fp))[0]
            with open(fp, "r", encoding="utf-8") as f:
                try:
                    items = json.load(f)
                except json.JSONDecodeError:
                    items = []
            if not isinstance(items, list):
                items = [items]
            await conn.execute(
                "INSERT INTO athena_revenue (date, items, updated_at) VALUES ($1, $2::jsonb, now()) "
                "ON CONFLICT (date) DO UPDATE SET items = EXCLUDED.items, updated_at = now()",
                date_str, json.dumps(items, ensure_ascii=False),
            )
            print(f"[athena] {date_str}: {len(items)} 条")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sqlite", default="/home/admin/dataserver/data.db")
    ap.add_argument("--athena-dir", default="/home/admin/dataserver/athena_data")
    args = ap.parse_args()

    pool = await dbmod.init_pool()
    async with pool.acquire() as conn:
        await dbmod.ensure_shared_tables(conn)
    await migrate_records(args.sqlite, pool)
    await migrate_athena(args.athena_dir, pool)
    await dbmod.close_pool()
    print("迁移完成")


if __name__ == "__main__":
    asyncio.run(main())
