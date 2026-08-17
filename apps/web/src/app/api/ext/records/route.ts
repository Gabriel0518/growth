import { requireApiAuth } from '@/lib/dashboard/auth';
import {
  EXT_COLUMNS,
  EXT_FILTER_COLUMNS,
  queryExtRecords,
  type ExtRecordsParams,
} from '@/lib/dashboard/ext-records';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/ext/records：M2M 原始 postback 行查询（可按列等值过滤、groupBy 聚合，raw 模式带 limit/payload）。 */
export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  const q = new URL(request.url).searchParams;
  const startDate = q.get('startDate') ?? q.get('date');
  const endDate = q.get('endDate') ?? q.get('date');
  if (!startDate || !endDate || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return Response.json(
      { ok: false, error: 'Invalid or missing startDate/endDate (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  const dateField = q.get('dateField') === 'install_time' ? 'install_time' : 'event_time';

  const filters: ExtRecordsParams['filters'] = [];
  for (const col of EXT_FILTER_COLUMNS) {
    const value = q.get(col);
    if (value != null && value !== '') filters.push({ col, value });
  }

  const groupBy = (q.get('groupBy') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((c) => (EXT_COLUMNS as readonly string[]).includes(c));

  let limit = Number.parseInt(q.get('limit') ?? '', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 1000;
  if (limit > 50_000) limit = 50_000;

  const includePayload = q.get('includePayload') === '1';

  try {
    const result = await queryExtRecords({
      startDate,
      endDate,
      dateField,
      filters,
      groupBy,
      limit,
      includePayload,
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
