import crypto from 'node:crypto';

import { stateCookie } from '@/lib/dashboard/auth';
import { buildAuthUrl } from '@/lib/feishu/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /auth/start：生成 state 并种签名 cookie（防 CSRF）→ 302 到飞书 OAuth 授权页。 */
export function GET(): Response {
  const state = crypto.randomBytes(16).toString('hex');
  return new Response(null, {
    status: 302,
    headers: new Headers({
      Location: buildAuthUrl(state),
      'Set-Cookie': stateCookie(state),
    }),
  });
}
