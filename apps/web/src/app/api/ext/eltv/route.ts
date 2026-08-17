import { requireApiAuth } from '@/lib/dashboard/auth';
import { readCachedEltvMultipliers } from '@/lib/dashboard/eltv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/ext/eltv?date=YYYY-MM-DD —— 该日 eLTV D30 倍数（产品×渠道）。
 * **只读 eltv_cache 按日期分桶的结果，绝不触发现算/写库/上游 fetch**。
 * 缺失时返回 ok:true + cached:false + 空 data，明确标记「该日尚未有缓存」。
 * data 为 { [product]: { FB|GG|TT: { d180, confidence, ... } } }（复用现有 eLTV 结构）。
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
    const entry = await readCachedEltvMultipliers(date);
    if (!entry) {
      return Response.json({
        ok: true,
        cached: false,
        data: {},
        meta: { date, products: 0, source: 'eltv_cache' },
      });
    }
    return Response.json({
      ok: true,
      cached: true,
      data: entry.multipliers,
      meta: { date, products: Object.keys(entry.multipliers).length, source: 'eltv_cache' },
    });
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
