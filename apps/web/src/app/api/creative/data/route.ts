import { requireApiAuth } from '@/lib/dashboard/auth';
import { computeCreative, parseDaysParam } from '@/lib/dashboard/creative';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/creative/data：素材 N 日窗口（days∈{3,7,14}）FB/TT 成本/曝光/点击/新用户收入聚合。 */
export function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return Promise.resolve(auth);

  const days = parseDaysParam(new URL(request.url).searchParams.get('days'));
  return computeCreative(days).then((body) => Response.json(body));
}
