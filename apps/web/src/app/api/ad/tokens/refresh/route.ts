/**
 * POST /api/ad/tokens/refresh?id=xxx —— 刷新 token
 * 重新验证 token 有效性并拉取最新的 BM/广告账户/Pages 写回 DB。
 */

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import { refreshFbToken } from '@/lib/dashboard/ad/token';
import { requireApiAuth } from '@/lib/dashboard/auth';
import { withGuard } from '@/lib/dashboard/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  const perm = await requireAdOperator(auth);
  if (perm instanceof Response) return perm;

  return withGuard(request, auth, async () =>
    withTrace(async () => {
      try {
        const q = new URL(request.url).searchParams;
        const idParam = q.get('id');
        if (!idParam) return Response.json({ error: '缺少 id 参数' }, { status: 400 });
        const id = Number.parseInt(idParam, 10);

        const updated = await refreshFbToken(id);
        return Response.json(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : '刷新失败';
        logger.exception(error, '/api/ad/tokens/refresh');
        return Response.json({ error: `Token 刷新失败：${message}` }, { status: 400 });
      }
    }),
  );
}
