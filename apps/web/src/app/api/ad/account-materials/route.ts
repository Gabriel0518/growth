/**
 * GET /api/ad/account-materials?accountId=xxx —— 广告账户素材库列表
 */

import { listAccountMaterials } from '@/lib/dashboard/ad/account-material';
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
        const accountId = q.get('accountId');
        if (!accountId) {
          return Response.json({ error: '缺少 accountId 参数' }, { status: 400 });
        }
        const page = Number.parseInt(q.get('page') ?? '1', 10);
        const pageSize = Number.parseInt(q.get('pageSize') ?? '24', 10);
        const materials = await listAccountMaterials(accountId, page, pageSize);
        return Response.json(materials);
      } catch (error) {
        logger.exception(error, '/api/ad/account-materials');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
