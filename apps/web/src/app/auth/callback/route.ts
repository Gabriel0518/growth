export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 飞书 OAuth 回调已停用，避免旧授权链接继续创建登录挑战。 */
export function GET(): Response {
  return new Response(null, {
    status: 302,
    headers: new Headers({ Location: '/login' }),
  });
}
