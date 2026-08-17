/**
 * POST /api/ad/sync/adsets?accountId=xxx&campaign_id=xxx
 * 只同步指定 Campaign 下的 AdSet。
 */

import { createFbAdapter } from '@agentic-ug/fetcher';

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import { syncAdSetsForCampaign } from '@/lib/dashboard/ad/sync';
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
        const campaignId = q.get('campaign_id');
        if (!campaignId) {
          return Response.json({ error: '缺少 campaign_id 参数' }, { status: 400 });
        }
        const config = await getAdAccountConfig(accountId);
        if (!config) {
          return Response.json(
            { error: `未找到广告账户配置: ${accountId}` },
            { status: 400 },
          );
        }
        const adapter = await createFbAdapter(config.token);
        // 从本地库查 campaign 的内部 id（FK 需要）
        const { queryOne } = await import('@agentic-ug/db');
        const localCampaign = await queryOne<{ id: number }>(
          `SELECT id FROM ad_campaign WHERE channel_campaign_id = $1`,
          [campaignId],
        );
        if (!localCampaign) {
          return Response.json(
            { error: '广告系列尚未同步，请先在广告系列页面点击刷新' },
            { status: 400 },
          );
        }
        const map = await syncAdSetsForCampaign(adapter, campaignId, localCampaign.id);
        return Response.json({ count: map.size });
      } catch (error) {
        logger.exception(error, '/api/ad/sync/adsets');
        return Response.json(
          { error: error instanceof Error ? error.message : '同步失败' },
          { status: 500 },
        );
      }
    }),
  );
}
