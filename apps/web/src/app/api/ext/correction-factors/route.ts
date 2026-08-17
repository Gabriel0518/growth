import { requireApiAuth } from '@/lib/dashboard/auth';
import { loadPersistedCorrectionFactors } from '@/lib/dashboard/correction-factors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/ext/correction-factors?date=YYYY-MM-DD —— 该日（前一天口径）修正系数。
 * **只读每日 job 写入的持久化（daily_snapshots kind='correction'），绝不现算/触发上游**。
 * 缺失时返回 ok:true + cached:false + 空 data，明确标记「该日尚未持久化」。
 * data 为 { [product]: number | { fb, other } }：Android 标量、iOS 分 fb/other 渠道。
 */
export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  const date = new URL(request.url).searchParams.get('date');
  if (!date || !DATE_RE.test(date)) {
    return Response.json(
      { ok: false, error: 'Invalid or missing date (YYYY-MM-DD)' },
      { status: 400 },
    );
  }

  try {
    const factors = await loadPersistedCorrectionFactors(date);
    if (!factors) {
      return Response.json({
        ok: true,
        cached: false,
        data: {},
        meta: { date, products: 0, source: 'daily_snapshots' },
      });
    }
    return Response.json({
      ok: true,
      cached: true,
      data: factors,
      meta: { date, products: Object.keys(factors).length, source: 'daily_snapshots' },
    });
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
