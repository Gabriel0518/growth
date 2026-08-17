import { clearPendingCookie, readPending, sessionCookie } from '@/lib/dashboard/auth';
import { getChallenge } from '@/lib/feishu/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /login/status：网页端轮询。读 pending cookie 的 nonce → 查挑战状态。
 * confirmed 时就地种正式 session（含 openId/name 审计）并清 pending，返回 {status}。
 */
export async function GET(request: Request): Promise<Response> {
  const pending = readPending(request);
  if (!pending) return Response.json({ status: 'none' });

  const challenge = await getChallenge(pending.nonce);
  if (!challenge) return Response.json({ status: 'none' });

  if (challenge.status === 'confirmed') {
    const headers = new Headers();
    headers.append(
      'Set-Cookie',
      sessionCookie({
        authenticated: true,
        panelAccess: false,
        openId: pending.openId,
        name: pending.name,
      }),
    );
    headers.append('Set-Cookie', clearPendingCookie());
    return Response.json({ status: 'confirmed' }, { headers });
  }

  return Response.json({ status: challenge.status });
}
