/**
 * /api/ext/records 的原始 postback 行查询 —— 复刻旧 server.js 的 M2M 明细/聚合接口。
 * 月表 records_YYYYMM：AF 行的时间列存 UTC 字符串（'YYYY-MM-DD HH:MM:SS'），
 * AD 行存 unix 秒字符串。用 CASE 分支避免把 AF 字符串误 CAST 成 bigint 报错。
 */

import { query, queryOne } from '@agentic-ug/db';

import { beijingDayBounds, getTablesForRange } from './dates';

/** 明细/聚合可返回、可 groupBy 的列白名单（复刻旧 EXT_COLUMNS）。 */
export const EXT_COLUMNS = [
  'source',
  'app_id',
  'event_name',
  'event_time',
  'revenue',
  'currency',
  'campaign',
  'media_source',
  'ad_id',
  'adset',
  'country',
  'device_id',
  'install_time',
  'is_retargeting',
  'created_at',
] as const;

/** 精确等值过滤允许的列（复刻旧白名单）。 */
export const EXT_FILTER_COLUMNS = [
  'event_name',
  'app_id',
  'media_source',
  'campaign',
  'adset',
  'country',
  'source',
] as const;

export interface ExtRecordsParams {
  startDate: string;
  endDate: string;
  dateField: 'event_time' | 'install_time';
  filters: { col: string; value: string }[];
  groupBy: string[];
  limit: number;
  includePayload: boolean;
}

interface ExtMeta {
  startDate: string;
  endDate: string;
  dateField: string;
  tables: string[];
}

export interface ExtAggregateResponse {
  ok: true;
  mode: 'aggregate';
  data: Record<string, unknown>[];
  meta: ExtMeta & { groupBy: string[]; rows: number };
}

export interface ExtRawResponse {
  ok: true;
  mode: 'raw';
  data: Record<string, unknown>[];
  meta: ExtMeta & { rows: number; limit: number; truncated: boolean };
}

async function tableExists(tbl: string): Promise<boolean> {
  const row = await queryOne<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE tablename = $1',
    [tbl],
  );
  return row != null;
}

/** 时间列范围谓词：AF（字符串）按字典序比较，AD（epoch 秒字符串）按 bigint 比较。 */
function dateClause(field: string, p: number): string {
  return `CASE
    WHEN ${field} LIKE '____-%' THEN (${field} >= $${p.toString()} AND ${field} < $${(p + 1).toString()})
    WHEN ${field} ~ '^-?[0-9]+$' THEN (${field}::bigint >= $${(p + 2).toString()} AND ${field}::bigint < $${(p + 3).toString()})
    ELSE false
  END`;
}

/** 计算北京日 [startDate, endDate] 的 UTC 字符串上下界与 epoch 秒上下界（含头不含尾）。 */
function rangeBounds(
  startDate: string,
  endDate: string,
): {
  strLo: string;
  strHi: string;
  epLo: number;
  epHi: number;
} {
  const lo = beijingDayBounds(startDate);
  const hi = beijingDayBounds(endDate);
  return { strLo: lo.strLo, strHi: hi.strHi, epLo: lo.epLo, epHi: hi.epHi };
}

/** /api/ext/records 主逻辑：无 groupBy 出明细，有 groupBy 出聚合（跨月表累加）。 */
export async function queryExtRecords(
  params: ExtRecordsParams,
): Promise<ExtAggregateResponse | ExtRawResponse> {
  const { startDate, endDate, dateField, filters, groupBy, limit, includePayload } = params;
  const tables = getTablesForRange(startDate, endDate);
  const { strLo, strHi, epLo, epHi } = rangeBounds(startDate, endDate);
  const boundParams = [strLo, strHi, epLo, epHi];

  const filterSql = filters.map((f, i) => `${f.col} = $${(5 + i).toString()}`).join(' AND ');
  const filterParams = filters.map((f) => f.value);
  const whereClause = `${dateClause(dateField, 1)}${filterSql ? ` AND ${filterSql}` : ''}`;

  if (groupBy.length > 0) {
    const gb = groupBy.join(', ');
    const agg = new Map<
      string,
      { keys: Record<string, string | number | null>; count: number; revenue: number }
    >();
    for (const tbl of tables) {
      if (!(await tableExists(tbl))) continue;
      const sql = `SELECT ${gb}, COUNT(*)::int AS cnt, ROUND(SUM(revenue)::numeric, 4)::float8 AS revenue
        FROM ${tbl} WHERE ${whereClause} GROUP BY ${gb}`;
      const rows = await query<Record<string, string | number | null>>(sql, [
        ...boundParams,
        ...filterParams,
      ]);
      for (const r of rows) {
        const key = groupBy.map((c) => String(r[c] ?? '')).join('\u0001');
        let entry = agg.get(key);
        if (!entry) {
          const keys: Record<string, string | number | null> = {};
          for (const c of groupBy) keys[c] = r[c] ?? null;
          entry = { keys, count: 0, revenue: 0 };
          agg.set(key, entry);
        }
        entry.count += Number(r['cnt'] ?? 0);
        entry.revenue += Number(r['revenue'] ?? 0);
      }
    }
    const out = [...agg.values()].map((e) => ({
      ...e.keys,
      count: e.count,
      revenue: Math.round(e.revenue * 10_000) / 10_000,
    }));
    out.sort((a, b) => b.revenue - a.revenue);
    return {
      ok: true,
      mode: 'aggregate',
      data: out,
      meta: { startDate, endDate, dateField, groupBy, tables, rows: out.length },
    };
  }

  const cols = includePayload ? [...EXT_COLUMNS, 'payload'] : [...EXT_COLUMNS];
  const selectCols = cols.join(', ');
  const rows: Record<string, unknown>[] = [];
  for (const tbl of tables) {
    if (rows.length >= limit) break;
    if (!(await tableExists(tbl))) continue;
    const remaining = limit - rows.length;
    const sql = `SELECT ${selectCols} FROM ${tbl} WHERE ${whereClause}
      ORDER BY ${dateField} DESC LIMIT $${(5 + filters.length).toString()}`;
    const part = await query<Record<string, unknown>>(sql, [
      ...boundParams,
      ...filterParams,
      remaining,
    ]);
    rows.push(...part);
  }
  return {
    ok: true,
    mode: 'raw',
    data: rows,
    meta: {
      startDate,
      endDate,
      dateField,
      tables,
      rows: rows.length,
      limit,
      truncated: rows.length >= limit,
    },
  };
}
