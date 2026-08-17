/**
 * GET /api/ad/branded-content-permissions?accountId=xxx&brandIgId=xxx
 * 查询品牌方 IG 商业账户已 Approved 的共创创作者列表
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
        if (!accountId) return Response.json({ error: '缺少 accountId 参数' }, { status: 400 });
        const brandIgId = q.get('brandIgId');
        if (!brandIgId) return Response.json({ error: '缺少 brandIgId 参数' }, { status: 400 });

        const config = await getAdAccountConfig(accountId);
        if (!config) {
          return Response.json(
            { error: `未找到广告账户配置: ${accountId}` },
            { status: 400 },
          );
        }
        const adapter = await createFbAdapter(config.token);
        const permissions = await adapter.listBrandedContentPermissions(brandIgId);
        return Response.json(permissions);
      } catch (error) {
        logger.exception(error, '/api/ad/branded-content-permissions');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
