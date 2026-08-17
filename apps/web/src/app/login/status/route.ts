export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 飞书确认轮询已停用，旧客户端收到 none 后会停止轮询。 */
export function GET(): Response {
  return Response.json({ status: 'none' });
}
