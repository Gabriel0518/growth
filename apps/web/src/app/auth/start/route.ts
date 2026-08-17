export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 飞书登录入口已停用，旧链接统一返回普通账号登录页。 */
export function GET(): Response {
  return new Response(null, {
    status: 302,
    headers: new Headers({ Location: '/login' }),
  });
}
