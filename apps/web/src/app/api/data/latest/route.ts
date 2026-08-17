import { requireApiAuth } from '@/lib/dashboard/auth';
import { formatDate, loadDayData } from '@/lib/dashboard/snapshots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/data/latest：今天最新快照，无则回退昨天，再无则 null。 */
export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  const today = formatDate(new Date());
  const data = await loadDayData(today);
  if (data.snapshots.length > 0) {
    return Response.json({ date: today, snapshot: data.snapshots.at(-1) });
  }

  // 昨天：直接退 24h（北京无 DST，等价于日历减一天），再由 formatDate 归到北京自然日。
  const yesterday = new Date(Date.now() - 86_400_000);
  const yesterdayStr = formatDate(yesterday);
  const yData = await loadDayData(yesterdayStr);
  if (yData.snapshots.length > 0) {
    return Response.json({ date: yesterdayStr, snapshot: yData.snapshots.at(-1) });
  }

  return Response.json({ date: today, snapshot: null });
}
