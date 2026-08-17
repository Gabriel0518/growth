import { requireDemoAuth } from '@/lib/demo/auth';
import { getPartnershipOverview } from '@/lib/demo/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/demo/overview：客户门户的全部只读数据（合创真实投放）。
 * 数据每小时刷新一次（按区间分别缓存），命中缓存时 fromCache=true；?refresh=1 强制重算。
 * 可选 ?start=YYYY-MM-DD&end=YYYY-MM-DD 指定聚合区间；缺省为「今天往前 14 天」。
 * 非法/越界的区间由服务端 resolveRange 收敛，绝不因脏输入报错。
 */
export async function GET(request: Request): Promise<Response> {
  const auth = requireDemoAuth(request);
  if (auth instanceof Response) return auth;

  const params = new URL(request.url).searchParams;
  const force = params.get('refresh') === '1';
  const start = params.get('start');
  const end = params.get('end');
  const range = start !== null && end !== null ? { start, end } : undefined;
  try {
    const { data, cachedAt, fromCache } = await getPartnershipOverview(force, range);
    return Response.json({ ...data, cachedAt, fromCache });
  } catch (error) {
    return Response.json({ error: `数据获取失败：${(error as Error).message}` }, { status: 502 });
  }
}
