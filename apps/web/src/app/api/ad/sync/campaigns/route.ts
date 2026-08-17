/**
 * POST /api/ad/sync/campaigns?accountId=xxx
 * 只同步当前广告账户下的 Campaign，不下钻 AdSet/Ad。
 */

import { createFbAdapter } from '@agentic-ug/fetcher';

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import { syncCampaignsFromFb } from '@/lib/dashboard/ad/sync';
import { getAdAccountConfig } from '@/lib/dashboard/ad/token-service';
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
        const accountId = q.get('accountId');
        if (!accountId) return Response.json({ error: '缺少 accountId 参数' }, { status: 400 });
        const config = await getAdAccountConfig(accountId);
        if (!config) {
          return Response.json(
            { error: `未找到广告账户配置: ${accountId}` },
            { status: 400 },
          );
        }
        const adapter = await createFbAdapter(config.token);
        const map = await syncCampaignsFromFb(adapter, accountId);
        return Response.json({ count: map.size });
      } catch (error) {
        logger.exception(error, '/api/ad/sync/campaigns');
        return Response.json(
          { error: error instanceof Error ? error.message : '同步失败' },
          { status: 500 },
        );
      }
    }),
  );
}
