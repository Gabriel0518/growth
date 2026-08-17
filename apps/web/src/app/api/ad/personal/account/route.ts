/**
 * GET /api/ad/personal/account?campaign_id=xxx —— 解析 FB campaign id 归属的广告账户。
 * 个人面板拿到 campaign id 后，用此端点确定 toggle/预算需要传哪个 accountId。
 */

import { queryOne } from '@agentic-ug/db';
import { requireApiAuth } from '@/lib/dashboard/auth';
import { withGuard } from '@/lib/dashboard/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  return withGuard(request, auth, async () => {
    try {
      const q = new URL(request.url).searchParams;
      const campaignId = q.get('campaign_id');
      const adsetId = q.get('adset_id');

      let row: { channel_account_id: string | null; status: string | null; daily_budget: number | null } | undefined;
      if (campaignId) {
        row = await queryOne<{ channel_account_id: string | null; status: string | null; daily_budget: number | null }>(
          'SELECT channel_account_id, status, daily_budget FROM ad_campaign WHERE channel_campaign_id = $1',
          [campaignId],
        );
      } else if (adsetId) {
        row = await queryOne<{ channel_account_id: string | null; status: string | null; daily_budget: number | null }>(
          'SELECT c.channel_account_id, s.status, (s.channel_extra->>\'daily_budget\')::int AS daily_budget FROM ad_set s JOIN ad_campaign c ON c.id = s.campaign_id WHERE s.channel_adset_id = $1',
          [adsetId],
        );
      } else {
        return Response.json({ error: '缺少 campaign_id 或 adset_id 参数' }, { status: 400 });
      }

      if (!row?.channel_account_id) {
        return Response.json({ error: '未找到该对象对应的广告账户' }, { status: 404 });
      }
      return Response.json({
        accountId: row.channel_account_id,
        status: row.status ?? 'PAUSED',
        daily_budget: row.daily_budget,
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : '内部错误' },
        { status: 500 },
      );
    }
  });
}
