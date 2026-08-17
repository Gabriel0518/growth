import { clearStateCookie, pendingCookie, readState } from '@/lib/dashboard/auth';
import { exchangeCode, sendConfirmCard } from '@/lib/feishu/client';
import { createChallenge, upsertOperatorProfile, upsertUser } from '@/lib/feishu/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 统一 302，可附带一个 Set-Cookie（用于清 state）。 */
function redirect302(location: string, setCookie?: string): Response {
  const headers = new Headers({ Location: location });
  if (setCookie !== undefined) headers.set('Set-Cookie', setCookie);
  return new Response(null, { status: 302, headers });
}

/**
 * GET /auth/callback：OAuth 回调。
 * 验 state → code 换身份 → upsert 名录 → 建 login 挑战 → 推确认卡片 →
 * 种 pending 签名 cookie（无状态，供 /login/status 轮询）→ 跳 /login/waiting。
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = readState(request);

  // state 缺失/不符 → 疑似 CSRF 或链接失效，打回登录页。
  if (code === null || state === null || expected === undefined || state !== expected) {
    return redirect302('/login?error=oauth', clearStateCookie());
  }

  try {
    const identity = await exchangeCode(code);
    await upsertUser(identity);
    // 同步投手信息到独立新表（email + departments 用于权限校验）
    await upsertOperatorProfile({
      openId: identity.openId,
      email: identity.email,
      departments: identity.departments,
    });
    const nonce = await createChallenge(identity.openId, 'login');
    await sendConfirmCard(identity.openId, { nonce, purpose: 'login', name: identity.name });

    const headers = new Headers({ Location: '/login/waiting' });
    // 先清 state，再种 pending：两条 Set-Cookie 用 append 分别下发。
    headers.append('Set-Cookie', clearStateCookie());
    headers.append(
      'Set-Cookie',
      pendingCookie({ nonce, openId: identity.openId, name: identity.name }),
    );
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.error('[auth/callback] 处理失败：', error);
    return redirect302('/login?error=oauth', clearStateCookie());
  }
}
