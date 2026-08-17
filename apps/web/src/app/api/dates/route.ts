import { requireApiAuth } from '@/lib/dashboard/auth';
import { getAvailableDates } from '@/lib/dashboard/snapshots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/dates：已入库的可用日期（倒序）。 */
export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  return Response.json(await getAvailableDates());
}
