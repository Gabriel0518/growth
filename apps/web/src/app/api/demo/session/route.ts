import { clearDemoSessionCookie, readDemoSession } from '@/lib/demo/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/demo/session：刷新页面后恢复登录态（cookie 是 httpOnly，前端只能这样问）。 */
export function GET(request: Request): Response {
  const session = readDemoSession(request);
  if (session === null) return Response.json({ authenticated: false });
  return Response.json({
    authenticated: true,
    username: session.username,
    company: session.company,
  });
}

/** DELETE /api/demo/session：登出，清 cookie。幂等，未登录也返回 200。 */
export function DELETE(): Response {
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearDemoSessionCookie() } });
}
