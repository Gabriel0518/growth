/**
 * GET    /api/ad/tokens —— 列表
 * POST   /api/ad/tokens —— 新增
 * PATCH  /api/ad/tokens?id=xxx —— 更新
 * DELETE /api/ad/tokens?id=xxx —— 删除
 * POST   /api/ad/tokens/refresh?id=xxx —— 刷新（重新拉取 BM/账户/Pages）
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import {
  createFbToken,
  deleteFbToken,
  listFbTokens,
  updateFbToken,
} from '@/lib/dashboard/ad/token';
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
        const tokens = await listFbTokens();
        return Response.json(tokens);
      } catch (error) {
        logger.exception(error, '/api/ad/tokens');
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
        const body = await request.json();
        if (!body.token || !body.app_id || !body.app_secret) {
          return Response.json({ error: 'token、app_id 和 app_secret 为必填项' }, { status: 400 });
        }

        try {
          const input: { token: string; app_id: string; app_secret: string; name?: string } = {
            token: String(body.token),
            app_id: String(body.app_id),
            app_secret: String(body.app_secret),
          };
          if (typeof body.name === 'string' && body.name.length > 0) {
            input.name = body.name;
          }
          const created = await createFbToken(input);
          return Response.json(created, { status: 201 });
        } catch (error) {
          const message = error instanceof Error ? error.message : '验证失败';
          return Response.json({ error: `Token 新增失败：${message}` }, { status: 400 });
        }
      } catch (error) {
        logger.exception(error, '/api/ad/tokens');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}

export async function PATCH(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  const perm = await requireAdOperator(auth);
  if (perm instanceof Response) return perm;

  return withGuard(request, auth, async () =>
    withTrace(async () => {
      try {
        const q = new URL(request.url).searchParams;
        const idParam = q.get('id');
        if (!idParam) return Response.json({ error: '缺少 id 参数' }, { status: 400 });
        const id = Number.parseInt(idParam, 10);

        const body = await request.json();

        try {
          const updated = await updateFbToken(id, body);
          return Response.json(updated);
        } catch (error) {
          const message = error instanceof Error ? error.message : '更新失败';
          return Response.json({ error: `Token 更新失败：${message}` }, { status: 400 });
        }
      } catch (error) {
        logger.exception(error, '/api/ad/tokens');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}

export async function DELETE(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  const perm = await requireAdOperator(auth);
  if (perm instanceof Response) return perm;

  return withGuard(request, auth, async () =>
    withTrace(async () => {
      try {
        const q = new URL(request.url).searchParams;
        const idParam = q.get('id');
        if (!idParam) return Response.json({ error: '缺少 id 参数' }, { status: 400 });
        const id = Number.parseInt(idParam, 10);

        try {
          await deleteFbToken(id);
          return Response.json({ ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : '删除失败';
          return Response.json({ error: `Token 删除失败：${message}` }, { status: 400 });
        }
      } catch (error) {
        logger.exception(error, '/api/ad/tokens');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
