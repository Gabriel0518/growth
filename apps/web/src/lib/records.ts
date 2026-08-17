import { currentTable } from '@agentic-ug/core';
import type { RawParams } from '@agentic-ug/core';
import { query, queryOne } from '@agentic-ug/db';

import { queryParams } from './http';
import { enqueue, popFirst, queueSize } from './ingest';

/** 仅允许月表标识（records_YYYYMM），杜绝表名注入。 */
const TABLE_RE = /^records_\d{6}$/;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(asString(value), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** POST /datacenter/data：通用入队。source = body.source or query.source or 'unknown'。 */
export async function ingestData(request: Request): Promise<Response> {
  let body: RawParams;
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    body = parsed as RawParams;
  } catch {
    return Response.json({ detail: '请求体必须是合法的 JSON' }, { status: 400 });
  }

  const q = queryParams(request);
  const bodySource = popFirst(body, ['source'], '');
  const source = bodySource || asString(q['source']) || 'unknown';
  if (!(await enqueue(source, body))) {
    return Response.json({ detail: '队列已满' }, { status: 503 });
  }
  return Response.json(
    { status: 'queued', source, queue_size: await queueSize() },
    { status: 202 },
  );
}

/** GET /datacenter/data：按 source/app_id/event_name/date 过滤查询月表。 */
export async function queryData(request: Request): Promise<Response> {
  const q = queryParams(request);
  const rawTable = asString(q['table']);
  const table = rawTable ? (TABLE_RE.test(rawTable) ? rawTable : undefined) : currentTable();
  if (table === undefined) {
    return Response.json({ detail: `invalid table: ${rawTable}` }, { status: 400 });
  }

  const limit = Math.min(asInt(q['limit'], 100), 1000);
  const offset = asInt(q['offset'], 0);

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  const addFilter = (column: string, key: string, wrap?: (v: string) => string): void => {
    const value = asString(q[key]);
    if (!value) return;
    conditions.push(`${column} ${wrap ? 'LIKE' : '='} $${idx.toString()}`);
    values.push(wrap ? wrap(value) : value);
    idx += 1;
  };
  addFilter('source', 'source');
  addFilter('app_id', 'app_id');
  addFilter('event_name', 'event_name');
  addFilter('event_time', 'date', (v) => `${v}%`);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const rows = await query(
      `SELECT * FROM ${table} ${where} ORDER BY id DESC LIMIT $${idx.toString()} OFFSET $${(idx + 1).toString()}`,
      [...values, limit, offset],
    );
    const totalRow = await queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${table} ${where}`,
      values,
    );
    const data = rows.map((row) => ({ ...row, payload: parsePayload(row['payload']) }));
    return Response.json({ total: totalRow?.count ?? 0, table, limit, offset, data });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'query failed';
    return Response.json({ detail }, { status: 400 });
  }
}

/** GET /datacenter/stats：库大小、各月表计数、当前月最新与来源 TOP20。 */
export async function stats(): Promise<Response> {
  const sizeRow = await queryOne<{ size: number }>(
    'SELECT pg_database_size(current_database())::float8 AS size',
  );
  const dbSize = sizeRow?.size ?? 0;

  const tables = await query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE tablename LIKE 'records_%' ORDER BY tablename",
  );

  const tableStats: { table: string; count: number }[] = [];
  let total = 0;
  for (const { tablename } of tables) {
    if (!TABLE_RE.test(tablename)) continue;
    const row = await queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${tablename}`,
    );
    const count = row?.count ?? 0;
    total += count;
    tableStats.push({ table: tablename, count });
  }

  const current = currentTable();
  let latest: string | null = null;
  let sources: { source: string; count: number }[] = [];
  if (TABLE_RE.test(current)) {
    try {
      const latestRow = await queryOne<{ created_at: string | null }>(
        `SELECT created_at FROM ${current} ORDER BY id DESC LIMIT 1`,
      );
      latest = latestRow?.created_at ?? null;
    } catch {
      latest = null;
    }
    try {
      const rows = await query<{ source: string; cnt: number }>(
        `SELECT source, COUNT(*)::int AS cnt FROM ${current} GROUP BY source ORDER BY cnt DESC LIMIT 20`,
      );
      sources = rows.map((r) => ({ source: r.source, count: r.cnt }));
    } catch {
      sources = [];
    }
  }

  return Response.json({
    total_records: total,
    db_size_mb: Number((dbSize / 1024 / 1024).toFixed(1)),
    queue_size: await queueSize(),
    tables: tableStats,
    latest,
    sources_this_month: sources,
  });
}
