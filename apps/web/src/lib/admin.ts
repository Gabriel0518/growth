import { query, queryOne } from '@agentic-ug/db';

import { todayBeijing } from '@/lib/dashboard/dates';

/** athena_revenue.items（JSONB）归一为数组：node-pg 已解析则直接用，字符串则解析。 */
function normalizeItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** POST /datacenter/admin：接收雅典娜收入，按日期合并 upsert 到 athena_revenue。 */
export async function receiveAthena(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json({ status: 'error', message: 'Invalid JSON' });
  }

  const dateStr = 'date' in body ? String(body['date']) : todayBeijing();
  const dataField: unknown = body['data'];
  const newItems: unknown[] = Array.isArray(dataField) ? (dataField as unknown[]) : [body];

  const existingRow = await queryOne<{ items: unknown }>(
    'SELECT items FROM athena_revenue WHERE date = $1',
    [dateStr],
  );
  const merged = [...normalizeItems(existingRow?.items), ...newItems];

  await query(
    `INSERT INTO athena_revenue (date, items, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (date) DO UPDATE SET items = EXCLUDED.items, updated_at = now()`,
    [dateStr, JSON.stringify(merged)],
  );

  return Response.json({ status: 'ok', date: dateStr, total_items: merged.length });
}

/** GET /datacenter/admin：查询某日期已接收的雅典娜数据。 */
export async function getAthena(request: Request): Promise<Response> {
  const dateParam = new URL(request.url).searchParams.get('date');
  const dateStr = dateParam === null || dateParam === '' ? todayBeijing() : dateParam;
  const row = await queryOne<{ items: unknown }>(
    'SELECT items FROM athena_revenue WHERE date = $1',
    [dateStr],
  );
  return Response.json({ status: 'ok', date: dateStr, data: normalizeItems(row?.items) });
}
