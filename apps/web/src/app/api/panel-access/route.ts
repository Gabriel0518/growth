import { requireApiAuth, sessionCookie } from '@/lib/dashboard/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/panel-access：二级菜单解锁，code 正确则置 panelAccess。 */
export async function POST(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  let code: unknown;
  try {
    const body: unknown = await request.json();
    if (body !== null && typeof body === 'object') code = (body as Record<string, unknown>)['code'];
  } catch {
    code = undefined;
  }

  if (code === '47251') {
    return Response.json(
      { ok: true },
      {
        headers: {
          'Set-Cookie': sessionCookie({ authenticated: auth.authenticated, panelAccess: true }),
        },
      },
    );
  }
  return Response.json({ ok: false, error: '密码错误' }, { status: 403 });
}

/** GET /api/panel-access：查询解锁状态。 */
export function GET(request: Request): Response {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  return Response.json({ unlocked: auth.panelAccess });
}
