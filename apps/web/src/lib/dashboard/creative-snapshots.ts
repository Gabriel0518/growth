/**
 * 素材（creative）与 AIGC 按日快照的读写 —— 复刻旧 dashboard/data/creative-{date}.json、aigc-{date}.json。
 * 文件 → PG：统一存入 daily_snapshots(kind='creative'|'aigc')，payload = { date, fetchedAt, creatives }。
 * 实际抓取（XMP AD 报表 + AF/AD 新用户收入）由 P5 定时任务写入；此处仅负责读写与范围指纹。
 */

import { query, queryOne } from '@agentic-ug/db';

/** 素材行：命名解析出 designer/series/number/date（旧文件可能只有 key 无 name）。 */
export interface CreativeRow {
  name?: string;
  key?: string;
  product?: string;
  designer?: string;
  series?: string;
  number?: string;
  date?: string;
  channel: string;
  cost?: number;
  impressions?: number;
  clicks?: number;
  newUserRevenue?: number;
}

/** AIGC 行：仅 name + product（无 designer/series/number）。 */
export interface AigcRow {
  name: string;
  product?: string;
  channel: string;
  cost?: number;
  impressions?: number;
  clicks?: number;
  newUserRevenue?: number;
}

export interface CreativeSnapshot {
  date: string;
  fetchedAt: number;
  creatives: CreativeRow[];
}

export interface AigcSnapshot {
  date: string;
  fetchedAt: number;
  creatives: AigcRow[];
}

export interface CreativeDayCache<Row> {
  fetchedAt: number;
  creatives: Row[];
}

/** disk-only 批量读某区间各北京日的 creative 快照（不触发 live fetch）。 */
export async function loadCreativeRange(
  dates: readonly string[],
): Promise<Map<string, CreativeDayCache<CreativeRow>>> {
  return loadSnapshotRange<CreativeRow>('creative', dates);
}

/** disk-only 批量读某区间各北京日的 aigc 快照（不触发 live fetch）。 */
export async function loadAigcRange(
  dates: readonly string[],
): Promise<Map<string, CreativeDayCache<AigcRow>>> {
  return loadSnapshotRange<AigcRow>('aigc', dates);
}

async function loadSnapshotRange<Row>(
  kind: 'creative' | 'aigc',
  dates: readonly string[],
): Promise<Map<string, CreativeDayCache<Row>>> {
  const map = new Map<string, CreativeDayCache<Row>>();
  if (dates.length === 0) return map;
  const rows = await query<{ date: string; payload: { fetchedAt?: number; creatives?: Row[] } }>(
    'SELECT date, payload FROM daily_snapshots WHERE kind = $1 AND date = ANY($2)',
    [kind, dates],
  );
  for (const row of rows) {
    map.set(row.date, {
      fetchedAt: row.payload.fetchedAt ?? 0,
      creatives: row.payload.creatives ?? [],
    });
  }
  return map;
}

/** 写 creative 快照（供 P5 抓取任务调用）。 */
export async function saveCreativeSnapshot(
  date: string,
  snapshot: CreativeSnapshot,
): Promise<void> {
  await saveSnapshot('creative', date, snapshot);
}

/** 写 aigc 快照（供 P5 抓取任务调用）。 */
export async function saveAigcSnapshot(date: string, snapshot: AigcSnapshot): Promise<void> {
  await saveSnapshot('aigc', date, snapshot);
}

async function saveSnapshot(
  kind: 'creative' | 'aigc',
  date: string,
  snapshot: CreativeSnapshot | AigcSnapshot,
): Promise<void> {
  await query(
    `INSERT INTO daily_snapshots (kind, date, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (kind, date) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [kind, date, JSON.stringify(snapshot)],
  );
}

/** 单日 creative 快照（含 fetchedAt），无则 null。 */
export async function loadCreativeSnapshot(date: string): Promise<CreativeSnapshot | null> {
  const row = await queryOne<{ payload: CreativeSnapshot }>(
    "SELECT payload FROM daily_snapshots WHERE kind = 'creative' AND date = $1",
    [date],
  );
  return row?.payload ?? null;
}

/** 单日 aigc 快照（含 fetchedAt），无则 null。 */
export async function loadAigcSnapshot(date: string): Promise<AigcSnapshot | null> {
  const row = await queryOne<{ payload: AigcSnapshot }>(
    "SELECT payload FROM daily_snapshots WHERE kind = 'aigc' AND date = $1",
    [date],
  );
  return row?.payload ?? null;
}
