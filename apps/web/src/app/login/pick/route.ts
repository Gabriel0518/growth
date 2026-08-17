import { pendingCookie } from '@/lib/dashboard/auth';
import { sendConfirmCard } from '@/lib/feishu/client';
import { createChallenge, getUser } from '@/lib/feishu/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /login/pick：二次登录（选人）。表单带 open_id →
 * 校验已授权 → 建挑战 → 推卡片 → 种 pending → 跳 waiting。无需再走 OAuth。
 */
export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const raw = form.get('open_id');
  const openId = typeof raw === 'string' ? raw : '';

  const user = openId === '' ? undefined : await getUser(openId);
  if (!user) {
    return new Response(null, { status: 302, headers: new Headers({ Location: '/login' }) });
  }

  const nonce = await createChallenge(user.openId, 'login');
  await sendConfirmCard(user.openId, { nonce, purpose: 'login', name: user.name });

  return new Response(null, {
    status: 302,
    headers: new Headers({
      Location: '/login/waiting',
      'Set-Cookie': pendingCookie({ nonce, openId: user.openId, name: user.name }),
    }),
  });
}
