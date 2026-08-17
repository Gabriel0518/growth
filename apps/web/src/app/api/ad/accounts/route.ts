/**
 * GET /api/ad/accounts —— 从 Token 内存服务中获取所有可用的广告账户配置列表。
 * 前端下拉选择器和多选查询器使用。
 */

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import { getAdAccountConfigs } from '@/lib/dashboard/ad/token-service';
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
        const accounts = await getAdAccountConfigs();
        return Response.json(accounts);
      } catch (error) {
        logger.exception(error, '/api/ad/accounts');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
