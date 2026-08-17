/**
 * GET /api/ad/pages?accountId=xxx —— 获取指定 token 能访问的 FB Page 列表
 */

import { createFbAdapter } from '@agentic-ug/fetcher';

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import { getAdAccountConfig } from '@/lib/dashboard/ad/token-service';
import { requireApiAuth } from '@/lib/dashboard/auth';
import { withGuard } from '@/lib/dashboard/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  const perm = await requireAdOperator(auth);
  if (perm instanceof Response) return perm;

  return withGuard(request, auth, async () =>
    withTrace(async () => {
      try {
        const q = new URL(request.url).searchParams;
        const accountId = q.get('accountId');
        if (!accountId) return Response.json({ error: '缺少 accountId 参数，请在右上角选择广告账户' }, { status: 400 });
        const config = await getAdAccountConfig(accountId);
        if (!config) {
          return Response.json(
            { error: `未找到广告账户配置: ${accountId}，请先在 Token 管理页面添加` },
            { status: 400 },
          );
        }
        const adapter = await createFbAdapter(config.token);
        const pages = await adapter.listAvailablePages();
        return Response.json(pages);
      } catch (error) {
        logger.exception(error, '/api/ad/pages');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
