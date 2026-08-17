/**
 * POST /api/ad/materials/[id]/sync —— 同步素材到指定平台
 */

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import { syncMaterialToChannel } from '@/lib/dashboard/ad/material';
import { requireApiAuth } from '@/lib/dashboard/auth';
import { withGuard } from '@/lib/dashboard/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  const perm = await requireAdOperator(auth);
  if (perm instanceof Response) return perm;

  return withGuard(request, auth, async () =>
    withTrace(async () => {
      try {
        const { id: rawId } = await params;
        const id = Number.parseInt(rawId, 10);
        const body = (await request.json()) as { channel?: string };
        const channel = body.channel ?? 'fb';

        const q = new URL(request.url).searchParams;
        const accountId = q.get('accountId') ?? undefined;
        const result = await syncMaterialToChannel(id, channel, accountId);
        return Response.json(result, { status: 201 });
      } catch (error) {
        logger.exception(error, '/api/ad/materials/[id]/sync');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
