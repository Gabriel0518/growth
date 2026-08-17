import { requireApiAuth } from '@/lib/dashboard/auth';
import {
  computeChannelSummary,
  loadChannelSummaryXmp,
  xmpRangeFingerprint,
} from '@/lib/dashboard/channel-summary';
import { getDateRange } from '@/lib/dashboard/dates';
import { withGuard } from '@/lib/dashboard/guard';
import { getRangeCache, rangeCacheTtl, setRangeCache } from '@/lib/dashboard/range-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/channel-summary：FB/GG/TT 渠道 cost/收入/安装/新用户/D7 聚合（多日走区间缓存，指纹用 XMP fetchedAt）。 */
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

    const xmpMap = await loadChannelSummaryXmp(startDate, endDate);
    const fp = xmpRangeFingerprint(getDateRange(startDate, endDate), xmpMap);
    const cacheKey = `channel-summary|${startDate}|${endDate}`;
    if (startDate !== endDate) {
      const hit = getRangeCache(cacheKey, fp);
      if (hit !== undefined) return Response.json(hit);
    }

    const response = await computeChannelSummary({ startDate, endDate, xmpMap });
    if (startDate !== endDate) setRangeCache(cacheKey, response, fp, rangeCacheTtl(endDate));
    return Response.json(response);
  });
}
