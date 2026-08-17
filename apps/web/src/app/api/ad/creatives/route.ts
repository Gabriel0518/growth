/**
 * GET  /api/ad/creatives —— 已创建创意列表
 * POST /api/ad/creatives —— 创建创意
 */

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { createCreative, listCreatives } from '@/lib/dashboard/ad/creative';
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
        const channel = q.get('channel') ?? undefined;
        const creatives = await listCreatives(channel);
        return Response.json(creatives);
      } catch (error) {
        logger.exception(error, '/api/ad/creatives');
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
          material_upload_id?: string;
          page_id?: string;
          ig_account_id?: string;
        };
        if (!body.material_upload_id || !body.page_id) {
          return Response.json(
            { error: 'material_upload_id 和 page_id 为必填项' },
            { status: 400 },
          );
        }
        const created = await createCreative({
          material_upload_id: body.material_upload_id,
          page_id: body.page_id,
          ...(body.ig_account_id === undefined ? {} : { ig_account_id: body.ig_account_id }),
        });
        return Response.json(created, { status: 201 });
      } catch (error) {
        logger.exception(error, '/api/ad/creatives');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
