/**
 * GET  /api/ad/materials —— 素材库列表
 * POST /api/ad/materials —— 注册素材 URL
 */

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import { listMaterials, registerMaterial } from '@/lib/dashboard/ad/material';
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
        const materials = await listMaterials(channel);
        return Response.json(materials);
      } catch (error) {
        logger.exception(error, '/api/ad/materials');
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
          file_url?: string;
          name?: string;
          app_product?: string;
        };
        if (!body.file_url || !body.name) {
          return Response.json({ error: 'file_url 和 name 为必填项' }, { status: 400 });
        }
        const created = await registerMaterial({
          file_url: body.file_url,
          name: body.name,
          ...(auth.name ? { creator: auth.name } : {}),
          ...(body.app_product === undefined ? {} : { app_product: body.app_product }),
        });
        return Response.json(created, { status: 201 });
      } catch (error) {
        logger.exception(error, '/api/ad/materials');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
