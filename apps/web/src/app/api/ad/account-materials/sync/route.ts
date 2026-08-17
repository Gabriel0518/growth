/**
 * POST /api/ad/account-materials/sync?accountId=xxx —— 从 FB 同步素材库到本地
 */

import { syncAccountMaterials } from '@/lib/dashboard/ad/account-material';
import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
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
        if (!accountId) {
          return Response.json({ error: '缺少 accountId 参数' }, { status: 400 });
        }
        const result = await syncAccountMaterials(accountId);
        return Response.json(result);
      } catch (error) {
        logger.exception(error, '/api/ad/account-materials/sync');
        return Response.json(
          { error: error instanceof Error ? error.message : '同步失败' },
          { status: 500 },
        );
      }
    }),
  );
}
