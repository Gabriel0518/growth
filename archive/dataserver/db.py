#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PostgreSQL 连接与 schema 管理（asyncpg 连接池）。

所有连接参数来自环境变量，禁止硬编码。优先级：
  1. DATABASE_URL —— 完整 DSN（postgresql://user:pass@host:port/db）
  2. 分量变量 —— DATABASE_HOST / DATABASE_PORT / DATABASE_USERNAME /
     DATABASE_PASSWORD / DATABASE_NAME（与 dora-k8s-config 的
     features.databases 注入的 secret key 对齐；也兼容 libpq 的 PG* 变量）

月表沿用 records_YYYYMM 命名（与 dashboard 查询保持一致），并额外维护
user_lookup 与 athena_revenue 两张常驻表。
"""

import os
import asyncpg

_pool: asyncpg.Pool | None = None


def _dsn() -> str:
    url = os.getenv("DATABASE_URL")
    if url:
        return url
    host = os.getenv("DATABASE_HOST") or os.getenv("PGHOST", "localhost")
    port = os.getenv("DATABASE_PORT") or os.getenv("PGPORT", "5432")
    user = os.getenv("DATABASE_USERNAME") or os.getenv("PGUSER", "postgres")
    password = os.getenv("DATABASE_PASSWORD") or os.getenv("PGPASSWORD", "")
    name = os.getenv("DATABASE_NAME") or os.getenv("PGDATABASE", "agentic_ug")
    return f"postgresql://{user}:{password}@{host}:{port}/{name}"


def pool_size() -> tuple[int, int]:
    return (
        int(os.getenv("DB_POOL_MIN", "2")),
        int(os.getenv("DB_POOL_MAX", "10")),
    )


async def init_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        mn, mx = pool_size()
        _pool = await asyncpg.create_pool(dsn=_dsn(), min_size=mn, max_size=mx)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("连接池未初始化，请先 await init_pool()")
    return _pool


# ── Schema ──────────────────────────────────────────────────────
RECORD_COLUMNS = (
    "source", "app_id", "event_name", "event_time", "revenue", "currency",
    "campaign", "media_source", "ad_id", "adset", "country", "device_id",
    "install_time", "is_retargeting", "payload", "created_at",
)


async def ensure_record_table(conn: asyncpg.Connection, table_name: str) -> None:
    """确保月表存在（PostgreSQL 版本，列语义与旧 SQLite 表保持一致）。"""
    await conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
            id              BIGSERIAL PRIMARY KEY,
            source          TEXT NOT NULL,
            app_id          TEXT,
            event_name      TEXT,
            event_time      TEXT,
            revenue         DOUBLE PRECISION,
            currency        TEXT DEFAULT 'USD',
            campaign        TEXT,
            media_source    TEXT,
            ad_id           TEXT,
            adset           TEXT,
            country         TEXT,
            device_id       TEXT,
            install_time    TEXT,
            is_retargeting  INTEGER DEFAULT 0,
            payload         TEXT,
            created_at      TEXT
        )
    """)
    # 复合 range 索引：支撑 dashboard 单日查询的范围扫描（event_name, event_time/
    # install_time）。缺了会退化成全表扫，曾把 dashboard 事件循环堵死，勿删。
    for stmt in (
        f"CREATE INDEX IF NOT EXISTS idx_{table_name}_source ON {table_name}(source)",
        f"CREATE INDEX IF NOT EXISTS idx_{table_name}_app ON {table_name}(app_id)",
        f"CREATE INDEX IF NOT EXISTS idx_{table_name}_event ON {table_name}(event_name)",
        f"CREATE INDEX IF NOT EXISTS idx_{table_name}_time ON {table_name}(event_time)",
        f"CREATE INDEX IF NOT EXISTS idx_{table_name}_created ON {table_name}(created_at)",
        f"CREATE INDEX IF NOT EXISTS idx_{table_name}_evt_time_range ON {table_name}(event_name, event_time)",
        f"CREATE INDEX IF NOT EXISTS idx_{table_name}_evt_inst_range ON {table_name}(event_name, install_time)",
    ):
        await conn.execute(stmt)


async def ensure_shared_tables(conn: asyncpg.Connection) -> None:
    """user_lookup 与 athena_revenue 常驻表。"""
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS user_lookup (
            user_id      BIGINT PRIMARY KEY,
            app_id       TEXT,
            event_time   TEXT,
            install_time TEXT,
            payload      TEXT,
            table_name   TEXT
        )
    """)
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS athena_revenue (
            date       TEXT PRIMARY KEY,
            items      JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
