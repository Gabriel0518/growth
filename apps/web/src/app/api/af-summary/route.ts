import { computeAfSummary } from '@/lib/dashboard/af-summary';
import { requireApiAuth } from '@/lib/dashboard/auth';
import { withGuard } from '@/lib/dashboard/guard';
import { getRangeCache, rangeCacheTtl, setRangeCache } from '@/lib/dashboard/range-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/af-summary：单/多日 AF 实际/LTV 收入与安装数（多日走区间缓存）。 */
export function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return Promise.resolve(auth);

  return withGuard(request, auth, async () => {
    const q = new URL(request.url).searchParams;
    const startDate = q.get('startDate') ?? q.get('date');
    const endDate = q.get('endDate') ?? q.get('date');
    if (!startDate || !endDate || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      return Response.json({ error: 'Invalid date' }, { status: 400 });
    }

    const cacheKey = `af-summary|${startDate}|${endDate}`;
    if (startDate !== endDate) {
      const hit = getRangeCache(cacheKey, '');
      if (hit !== undefined) return Response.json(hit);
    }

    const products = await computeAfSummary(startDate, endDate);
    const response = { startDate, endDate, date: endDate, products };
    if (startDate !== endDate) setRangeCache(cacheKey, response, '', rangeCacheTtl(endDate));
    return Response.json(response);
  });
}
