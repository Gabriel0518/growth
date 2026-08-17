'use strict';

// PostgreSQL 连接池（node-postgres）。替代原先直接打开 dataserver 的
// SQLite 文件（better-sqlite3）。dataserver 是唯一写入方，dashboard 只读
// 同一批 records_YYYYMM 月表。
//
// 迁移注意（SQLite → PostgreSQL）：
//   - 占位符 `?` → `$1,$2,...`；better-sqlite3 同步 API → pg 异步（await）。
//   - 月表发现：`sqlite_master` → `pg_tables`（见 listRecordTables）。
//   - 日期数学 `julianday(a)-julianday(b)`（天）
//       → `EXTRACT(EPOCH FROM (a::timestamp - b::timestamp))/86400.0`。
//   - `datetime('now','localtime')` → `now() AT TIME ZONE 'Asia/Shanghai'`。
//   - `strftime('%H', x)` → `to_char(x::timestamp,'HH24')`。
//   - `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`。
// 这些分析型查询（server.js 中约 85 处，含大量 julianday）需在 dev 环境
// 连真实 PostgreSQL 做集成回归后逐个切换，helper 与约定见此文件。

const { Pool } = require('pg');
const config = require('./config');

const pool = config.db.connectionString
  ? new Pool({ connectionString: config.db.connectionString, max: config.db.poolMax })
  : new Pool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      max: config.db.poolMax,
    });

pool.on('error', (err) => {
  console.error('[db] pg pool error', err);
});

// 执行查询，返回 rows。
async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

// 单行查询。
async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows[0];
}

// 列出所有 records_YYYYMM 月表（替代 sqlite_master 扫描）。
async function listRecordTables(minTable) {
  if (minTable) {
    const rows = await query(
      "SELECT tablename FROM pg_tables WHERE tablename LIKE 'records_%' AND tablename >= $1 ORDER BY tablename",
      [minTable],
    );
    return rows.map((r) => r.tablename);
  }
  const rows = await query(
    "SELECT tablename FROM pg_tables WHERE tablename LIKE 'records_%' ORDER BY tablename",
  );
  return rows.map((r) => r.tablename);
}

async function tableExists(tableName) {
  const row = await queryOne('SELECT 1 FROM pg_tables WHERE tablename = $1', [tableName]);
  return !!row;
}

module.exports = { pool, query, queryOne, listRecordTables, tableExists };
