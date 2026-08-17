/**
 * GET  /api/ad/campaigns —— 广告系列列表
 * POST /api/ad/campaigns —— 创建广告系列
 */

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { createCampaign, listCampaigns, updateCampaign } from '@/lib/dashboard/ad/campaign';
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
        const accountId = q.get('accountId');
        if (!accountId) return Response.json({ error: '缺少 accountId 参数，请在右上角选择广告账户' }, { status: 400 });
        const campaigns = await listCampaigns(accountId);
        return Response.json(campaigns);
      } catch (error) {
        logger.exception(error, '/api/ad/campaigns');
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
          objective?: string;
          status?: 'ACTIVE' | 'PAUSED';
          daily_budget?: number;
          special_ad_categories?: string[];
          buying_type?: string;
          bid_strategy?: string;
          product?: string;
        };
        if (!body.name || !body.objective) {
          return Response.json({ error: 'name 和 objective 为必填项' }, { status: 400 });
        }
        const acctId = new URL(request.url).searchParams.get('accountId');
        if (!acctId) return Response.json({ error: '缺少 accountId 参数，请在右上角选择广告账户' }, { status: 400 });
        const created = await createCampaign(acctId, {
          name: body.name,
          objective: body.objective,
          status: body.status ?? 'PAUSED',
          ...(body.daily_budget === undefined ? {} : { daily_budget: body.daily_budget }),
          ...(body.special_ad_categories === undefined
            ? {}
            : { special_ad_categories: body.special_ad_categories }),
          ...(auth.name ? { creator: auth.name } : {}),
          ...(body.buying_type ? { buying_type: body.buying_type } : {}),
          ...(body.bid_strategy ? { bid_strategy: body.bid_strategy } : {}),
          ...(body.product ? { product: body.product } : {}),
        });
        return Response.json(created, { status: 201 });
      } catch (error) {
        logger.exception(error, '/api/ad/campaigns');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}

/** PATCH /api/ad/campaigns?id=xxx —— 更新 campaign（状态/预算/名称） */
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

        const body = (await request.json()) as {
          name?: string;
          status?: 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';
          daily_budget?: number;
        };
        const acctId2 = q.get('accountId');
        if (!acctId2) return Response.json({ error: '缺少 accountId 参数，请在右上角选择广告账户' }, { status: 400 });
        const updated = await updateCampaign(acctId2, id, body);
        return Response.json(updated);
      } catch (error) {
        logger.exception(error, '/api/ad/campaigns');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
