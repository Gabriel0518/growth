/**
 * GET  /api/ad/adgroups?campaign_id=xxx —— 广告组列表
 * POST /api/ad/adgroups —— 创建广告组
 */

import { createAdSet, listAdSets, updateAdSet } from '@/lib/dashboard/ad/adset';
import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
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
        const campaignId = q.get('campaign_id');
        if (!campaignId) {
          return Response.json({ error: '缺少 campaign_id 参数' }, { status: 400 });
        }
        const adgroups = await listAdSets(campaignId);
        return Response.json(adgroups);
      } catch (error) {
        logger.exception(error, '/api/ad/adgroups');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}

export async function POST(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  const perm = await requireAdOperator(auth);
  if (perm instanceof Response) return perm;

  return withGuard(request, auth, async () =>
    withTrace(async () => {
      try {
        const body = (await request.json()) as {
          name?: string;
          campaign_id?: string;
          status?: 'ACTIVE' | 'PAUSED';
          optimization_goal?: string;
          billing_event?: string;
          daily_budget?: number;
          bid_strategy?: string;
          targeting?: Record<string, unknown>;
          destination_type?: string;
          is_skadnetwork_attribution?: boolean;
          is_dynamic_creative?: boolean;
          promoted_object?: Record<string, unknown>;
          attribution_spec?: Record<string, unknown>[];
        };
        if (!body.name || !body.campaign_id || !body.optimization_goal) {
          return Response.json(
            { error: 'name、campaign_id 和 optimization_goal 为必填项' },
            { status: 400 },
          );
        }
        const qa = new URL(request.url).searchParams;
        const accountId = qa.get('accountId');
        if (!accountId) return Response.json({ error: '缺少 accountId 参数，请在右上角选择广告账户' }, { status: 400 });
        const created = await createAdSet({
          name: body.name,
          local_campaign_id: body.campaign_id,
          status: body.status ?? 'PAUSED',
          optimization_goal: body.optimization_goal,
          ...(body.billing_event ? { billing_event: body.billing_event } : {}),
          ...(body.daily_budget === undefined ? {} : { daily_budget: body.daily_budget }),
          ...(body.bid_strategy ? { bid_strategy: body.bid_strategy } : {}),
          accountId,
          ...(auth.name ? { creator: auth.name } : {}),
          ...(body.destination_type ? { destination_type: body.destination_type } : {}),
          ...(body.is_skadnetwork_attribution ? { is_skadnetwork_attribution: true } : {}),
          ...(body.is_dynamic_creative ? { is_dynamic_creative: true } : {}),
          ...(body.promoted_object ? { promoted_object: body.promoted_object } : {}),
          ...(body.attribution_spec && body.attribution_spec.length > 0 ? { attribution_spec: body.attribution_spec } : {}),
          ...(body.targeting ? { targeting: body.targeting } : {}),
        });
        return Response.json(created, { status: 201 });
      } catch (error) {
        logger.exception(error, '/api/ad/adgroups');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}

/** PATCH /api/ad/adsets?id=xxx —— 更新广告组（预算/状态/名称） */
export async function PATCH(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  const perm = await requireAdOperator(auth);
  if (perm instanceof Response) return perm;

  return withGuard(request, auth, async () =>
    withTrace(async () => {
      try {
        const q = new URL(request.url).searchParams;
        const id = q.get('id');
        if (!id) return Response.json({ error: '缺少 id 参数' }, { status: 400 });
        const accountId = q.get('accountId');
        if (!accountId) return Response.json({ error: '缺少 accountId 参数，请在右上角选择广告账户' }, { status: 400 });

        const body = (await request.json()) as {
          daily_budget?: number;
          status?: 'ACTIVE' | 'PAUSED';
          name?: string;
        };
        const updated = await updateAdSet(accountId, id, body);
        return Response.json(updated);
      } catch (error) {
        logger.exception(error, '/api/ad/adgroups');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
