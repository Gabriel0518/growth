import { requireApiAuth } from '@/lib/dashboard/auth';
import { getEltvMultipliers } from '@/lib/dashboard/eltv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/eltv-multipliers?date=：产品×渠道 D30 倍率（缓存优先）。 */
export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  const date = new URL(request.url).searchParams.get('date');
  if (!date || !DATE_RE.test(date)) {
    return Response.json({ error: 'Invalid date' }, { status: 400 });
  }
  return Response.json(await getEltvMultipliers(date));
}
