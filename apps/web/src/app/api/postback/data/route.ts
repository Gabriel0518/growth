import { requireApiAuth } from '@/lib/dashboard/auth';
import { loadPostbackRange } from '@/lib/dashboard/postback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/postback/data?startDate=&endDate=（或单个 date=）：区间 af/ad 产品×渠道收入笔数汇总。 */
export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  const q = new URL(request.url).searchParams;
  const date = q.get('date');
  const startDate = (q.get('startDate') ?? date ?? '').trim();
  const endDate = (q.get('endDate') ?? date ?? startDate).trim();
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return Response.json(
      { error: 'Invalid or missing date parameters (YYYY-MM-DD)' },
      { status: 400 },
    );
  }
  return Response.json(await loadPostbackRange(startDate, endDate));
}
