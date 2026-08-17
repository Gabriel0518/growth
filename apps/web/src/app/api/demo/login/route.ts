import { demoSessionCookie, verifyCredentials } from '@/lib/demo/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/demo/login：门户账密登录，成功种 httpOnly cookie。口令绝不回传前端。 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '请求体格式错误' }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const username = typeof obj['username'] === 'string' ? obj['username'] : '';
  const password = typeof obj['password'] === 'string' ? obj['password'] : '';
  if (username === '' || password === '') {
    return Response.json({ error: '请输入用户名和密码' }, { status: 400 });
  }

  let session: Awaited<ReturnType<typeof verifyCredentials>>;
  try {
    session = await verifyCredentials(username, password);
  } catch (error) {
    return Response.json({ error: `登录校验失败：${(error as Error).message}` }, { status: 500 });
  }
  if (session === null) {
    // 不区分「用户名不存在」与「密码错误」，避免枚举账号。
    return Response.json({ error: '用户名或密码错误' }, { status: 401 });
  }

  return Response.json(
    { username: session.username, company: session.company },
    { headers: { 'Set-Cookie': demoSessionCookie(session) } },
  );
}
