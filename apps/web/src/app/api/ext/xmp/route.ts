import { requireApiAuth } from '@/lib/dashboard/auth';
import { readXmpCacheForDate } from '@/lib/dashboard/xmp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/ext/xmp?date=YYYY-MM-DD —— 该北京日 adgroup 级 XMP 消耗。
 * **只读 xmp_cache，绝不触发 XMP OPEN API / 任何上游 live fetch**：
 * 当天=活缓存最新每小时值（由整点 job 刷新），历史=永久留存值。缓存缺失时
 * 返回 ok:true + cached:false + 空 data，明确标记「库内暂无该日缓存」。
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
    const entry = await readXmpCacheForDate(date);
    if (!entry) {
      return Response.json({
        ok: true,
        cached: false,
        data: [],
        meta: { date, rows: 0, source: 'xmp_cache' },
      });
    }
    return Response.json({
      ok: true,
      cached: true,
      data: entry.data,
      meta: {
        date,
        rows: entry.data.length,
        complete: entry.complete,
        fetchedAt: new Date(entry.fetchedAt).toISOString(),
        source: 'xmp_cache',
      },
    });
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
}
