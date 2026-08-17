import { requireApiAuth } from '@/lib/dashboard/auth';
import { lookupUser } from '@/lib/dashboard/user-lookup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const USER_ID_RE = /^\d{5,10}$/;

/** GET /api/user-lookup：按 5-10 位数字用户 ID 查其全部广告归因事件（产品/平台/campaign/adset/ad）。 */
export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  const userId = new URL(request.url).searchParams.get('userId');
  if (!userId || !USER_ID_RE.test(userId)) {
    return Response.json({ error: '请输入5-10位数字的用户ID' }, { status: 400 });
  }

  try {
    const results = await lookupUser(Number.parseInt(userId, 10));
    return Response.json({ userId, results });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
