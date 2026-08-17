export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 飞书二次确认登录已停用，旧表单提交统一返回普通账号登录页。 */
export function POST(): Response {
  return new Response(null, {
    status: 302,
    headers: new Headers({ Location: '/login' }),
  });
}
