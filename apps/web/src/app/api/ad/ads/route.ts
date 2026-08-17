/**
 * GET  /api/ad/ads?adgroup_id=xxx —— 广告列表
 * POST /api/ad/ads —— 创建广告
 */

import { createAd, listAds } from '@/lib/dashboard/ad/ad';
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
        const adgroupId = q.get('adset_id');
        if (!adgroupId) {
          return Response.json({ error: '缺少 adset_id 参数' }, { status: 400 });
        }
        const ads = await listAds(adgroupId);
        return Response.json(ads);
      } catch (error) {
        logger.exception(error, '/api/ad/ads');
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
          adset_id?: string;
          local_creative_id?: string;
          status?: 'ACTIVE' | 'PAUSED';
          page_id?: string;
          // 内联 creative
          material_id?: number;
          creative_name?: string;
          titles?: string[];
          bodies?: string[];
          optimization_type?: string;
          link_url?: string;
          call_to_action_type?: string;
          link_description?: string;
          url_tags?: string;
          ig_user_id?: string;
          instagram_branded_content?: Record<string, unknown>;
        };
        const hasMaterial = typeof body.material_id === 'number';
        if (!body.name || !body.adset_id) {
          return Response.json(
            { error: 'name 和 adset_id 为必填项' },
            { status: 400 },
          );
        }
        if (!hasMaterial && !body.local_creative_id) {
          return Response.json(
            { error: '请选择素材（material_id）或已有创意（local_creative_id）' },
            { status: 400 },
          );
        }
        const qu = new URL(request.url).searchParams;
        const accountId = qu.get('accountId');
        if (!accountId) return Response.json({ error: '缺少 accountId 参数，请在右上角选择广告账户' }, { status: 400 });

        const created = await createAd({
          name: body.name,
          adset_id: body.adset_id,
          ...(auth.name ? { creator: auth.name } : {}),
          ...(body.local_creative_id ? { local_creative_id: body.local_creative_id } : {}),
          status: body.status ?? 'PAUSED',
          ...(body.page_id ? { page_id: body.page_id } : {}),
          accountId,
          ...(hasMaterial ? { material_id: body.material_id } : {}),
          ...(body.creative_name ? { creative_name: body.creative_name } : {}),
          ...(body.titles?.length ? { titles: body.titles } : {}),
          ...(body.bodies?.length ? { bodies: body.bodies } : {}),
          ...(body.optimization_type ? { optimization_type: body.optimization_type } : {}),
          ...(body.link_url ? { link_url: body.link_url } : {}),
          ...(body.call_to_action_type ? { call_to_action_type: body.call_to_action_type } : {}),
          ...(body.link_description ? { link_description: body.link_description } : {}),
          ...(body.url_tags ? { url_tags: body.url_tags } : {}),
          ...(body.ig_user_id ? { ig_user_id: body.ig_user_id } : {}),
          ...(body.instagram_branded_content ? { instagram_branded_content: body.instagram_branded_content } : {}),
        });
        return Response.json(created, { status: 201 });
      } catch (error) {
        logger.exception(error, '/api/ad/ads');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
