import { currentTable } from '@agentic-ug/core';
import {
  closePool,
  ensureAdTables,
  ensureAuthTables,
  ensureDashboardTables,
  ensureDemoUserTable,
  ensureIngestInbox,
  ensureRecordTable,
  ensureSharedTables,
  getPool,
} from '@agentic-ug/db';

/**
 * 统一 PG schema 迁移器 —— 幂等应用所有建表/索引 DDL。
 * 覆盖：user_lookup / athena_revenue、ingest_inbox（上报缓冲）、
 * daily_snapshots / xmp_cache / eltv_cache（看板存储）、当前月表 records_YYYYMM、
 * fs_user / login_challenge（飞书登录）。
 * 可反复执行（全部 CREATE ... IF NOT EXISTS）。
 */
async function main(): Promise<void> {
  const pool = getPool();
  const table = currentTable();

  console.log('[migrate] applying unified PG schema …');
  await ensureSharedTables(pool);
  console.log('[migrate] shared tables ready: user_lookup, athena_revenue');
  await ensureIngestInbox(pool);
  console.log('[migrate] ingest buffer ready: ingest_inbox');
  await ensureDashboardTables(pool);
  console.log('[migrate] dashboard tables ready: daily_snapshots, xmp_cache, eltv_cache');
  await ensureAuthTables(pool);
  console.log('[migrate] auth tables ready: fs_user, login_challenge');
  await ensureDemoUserTable(pool);
  console.log('[migrate] demo portal table ready: demo_portal_user (seed: sitin)');
  await ensureAdTables(pool);
  console.log('[migrate] ad tables ready: ad_material, ad_material_upload, ad_creative');
  await ensureRecordTable(pool, table);
  console.log(`[migrate] record table ready: ${table}`);

  await closePool();
  console.log('[migrate] done');
}

try {
  await main();
} catch (error) {
  console.error('[migrate] failed:', error);
  process.exitCode = 1;
  // 释放连接池，否则事件循环不退出 → 进程挂起。
  await closePool();
}
