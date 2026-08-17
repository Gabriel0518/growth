import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { closePool, ensureDashboardTables, getPool, query } from '@agentic-ug/db';

/**
 * 历史 JSON 一次性导入 —— 把旧 dashboard/data/ 下的按日快照与 eLTV 缓存
 * 原样（JSONB passthrough）灌入统一 PG，实现历史日期零差异。
 *
 * 覆盖：
 *   {date}.json          → daily_snapshots(kind='main')
 *   personal-{date}.json → daily_snapshots(kind='personal')
 *   creative-{date}.json → daily_snapshots(kind='creative')
 *   aigc-{date}.json     → daily_snapshots(kind='aigc')
 *   eltv-cache.json      → eltv_cache(key='cache')
 *   eltv-hwm.json        → eltv_cache(key='hwm')
 * 跳过：xmp-cache/*（TTL ≤30min，历史全部过期，运行时自动重建）。
 */

interface SnapshotPattern {
  readonly kind: string;
  readonly re: RegExp;
}

const SNAPSHOT_PATTERNS: readonly SnapshotPattern[] = [
  { kind: 'main', re: /^(\d{4}-\d{2}-\d{2})\.json$/ },
  { kind: 'personal', re: /^personal-(\d{4}-\d{2}-\d{2})\.json$/ },
  { kind: 'creative', re: /^creative-(\d{4}-\d{2}-\d{2})\.json$/ },
  { kind: 'aigc', re: /^aigc-(\d{4}-\d{2}-\d{2})\.json$/ },
];

function classify(fileName: string): { kind: string; date: string } | undefined {
  for (const { kind, re } of SNAPSHOT_PATTERNS) {
    const match = re.exec(fileName);
    if (match?.[1] !== undefined) return { kind, date: match[1] };
  }
  return undefined;
}

/** 校验为合法 JSON 后返回原文；非法则返回 undefined（跳过并告警）。 */
function readJsonText(filePath: string): string | undefined {
  const text = readFileSync(filePath, 'utf8');
  try {
    JSON.parse(text);
  } catch {
    console.warn(`[import] skip invalid JSON: ${filePath}`);
    return undefined;
  }
  return text;
}

async function upsertSnapshot(kind: string, date: string, payload: string): Promise<void> {
  await query(
    `INSERT INTO daily_snapshots (kind, date, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (kind, date) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [kind, date, payload],
  );
}

async function upsertEltv(key: string, payload: string): Promise<void> {
  await query(
    `INSERT INTO eltv_cache (key, payload)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [key, payload],
  );
}

async function importSnapshots(dataDir: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const fileName of readdirSync(dataDir)) {
    const hit = classify(fileName);
    if (!hit) continue;
    const text = readJsonText(path.join(dataDir, fileName));
    if (text === undefined) continue;
    await upsertSnapshot(hit.kind, hit.date, text);
    counts[hit.kind] = (counts[hit.kind] ?? 0) + 1;
  }
  return counts;
}

async function importEltv(dataDir: string): Promise<number> {
  let imported = 0;
  const sources: readonly { key: string; file: string }[] = [
    { key: 'cache', file: 'eltv-cache.json' },
    { key: 'hwm', file: 'eltv-hwm.json' },
  ];
  for (const { key, file } of sources) {
    const filePath = path.join(dataDir, file);
    if (!existsSync(filePath)) continue;
    const text = readJsonText(filePath);
    if (text === undefined) continue;
    await upsertEltv(key, text);
    imported += 1;
  }
  return imported;
}

async function main(): Promise<void> {
  const dataDir = path.resolve(process.env['DASHBOARD_DATA_DIR'] ?? 'dashboard/data');
  console.log(`[import] source dir: ${dataDir}`);

  const pool = getPool();
  await ensureDashboardTables(pool);

  if (!existsSync(dataDir)) {
    console.warn('[import] data dir not found — nothing to import');
    await closePool();
    return;
  }

  const snapshotCounts = await importSnapshots(dataDir);
  const eltvCount = await importEltv(dataDir);

  console.log('[import] snapshots:', JSON.stringify(snapshotCounts));
  console.log(`[import] eltv rows: ${eltvCount.toString()}`);
  console.log('[import] note: xmp-cache/* skipped (expired, rebuilt at runtime)');

  await closePool();
  console.log('[import] done');
}

try {
  await main();
} catch (error) {
  console.error('[import] failed:', error);
  process.exitCode = 1;
}
