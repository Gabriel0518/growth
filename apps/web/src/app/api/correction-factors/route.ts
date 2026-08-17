import { requireApiAuth } from '@/lib/dashboard/auth';
import { getCorrectionFactors } from '@/lib/dashboard/correction-factors';
import type { FactorMap } from '@/lib/dashboard/correction-factors';
import { getDateRange, todayBeijing, yesterdayBeijing } from '@/lib/dashboard/dates';
import { withGuard } from '@/lib/dashboard/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/correction-factors：单日 {date,dataDate,factors}；多日 {startDate,endDate,dailyFactors}。 */
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

    const todayStr = todayBeijing();
    const yesterdayStr = yesterdayBeijing();

    // 单日：保留原始返回结构
    if (startDate === endDate) {
      const date = startDate;
      const dataDate = date >= todayStr ? yesterdayStr : date;
      const factors = await getCorrectionFactors(dataDate);
      return Response.json({ date, dataDate, factors });
    }

    // 多日：逐日返回（当天首次算/当天内复用同一套缓存）
    const dailyFactors: Record<string, FactorMap> = {};
    for (const d of getDateRange(startDate, endDate)) {
      const dataDate = d >= todayStr ? yesterdayStr : d;
      dailyFactors[d] = await getCorrectionFactors(dataDate);
    }
    return Response.json({ startDate, endDate, dailyFactors });
  });
}
