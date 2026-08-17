/**
 * POST /api/ad/sync/ads?accountId=xxx&adset_id=xxx
 * 只同步指定 AdSet 下的 Ad。
 */

import { queryOne } from '@agentic-ug/db';
import { createFbAdapter } from '@agentic-ug/fetcher';

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import { syncAdsForAdGroup } from '@/lib/dashboard/ad/sync';
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
        const adsetId = q.get('adset_id'); // FB adset_id (not local)
        if (!adsetId) {
          return Response.json({ error: '缺少 adset_id 参数' }, { status: 400 });
        }
        const config = await getAdAccountConfig(accountId);
        if (!config) {
          return Response.json(
            { error: `未找到广告账户配置: ${accountId}` },
            { status: 400 },
          );
        }
        const local = await queryOne<{ id: number }>(
          `SELECT id FROM ad_set WHERE channel_adset_id = $1`,
          [adsetId],
        );
        if (!local) {
          return Response.json(
            { error: '广告组尚未同步，请先在广告组页面选择 Campaign 后点击刷新' },
            { status: 400 },
          );
        }
        const adapter = await createFbAdapter(config.token);
        const count = await syncAdsForAdGroup(adapter, adsetId, local.id);
        return Response.json({ count });
      } catch (error) {
        logger.exception(error, '/api/ad/sync/ads');
        return Response.json(
          { error: error instanceof Error ? error.message : '同步失败' },
          { status: 500 },
        );
      }
    }),
  );
}
