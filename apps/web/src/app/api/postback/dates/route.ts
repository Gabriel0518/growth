import { requireApiAuth } from '@/lib/dashboard/auth';
import { listPostbackDates } from '@/lib/dashboard/postback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/postback/dates：所有月表中出现过 af_purchase 的北京日期（倒序）。 */
export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  return Response.json(await listPostbackDates());
}
