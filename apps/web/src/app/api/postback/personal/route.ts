import { requireApiAuth } from '@/lib/dashboard/auth';
import { todayBeijing } from '@/lib/dashboard/dates';
import { withGuard } from '@/lib/dashboard/guard';
import { computePersonal } from '@/lib/dashboard/personal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/postback/personal：个人面板日报（单/多日，operator→…→ad 九指标含修正收入）。 */
export function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return Promise.resolve(auth);

  return withGuard(request, auth, () => {
    const q = new URL(request.url).searchParams;
    const date = (q.get('date') ?? todayBeijing()).trim();
    const startDate = (q.get('startDate') ?? date).trim();
    const endDate = (q.get('endDate') ?? date).trim();
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      return Promise.resolve(
        Response.json({ error: 'Invalid or missing date parameter (YYYY-MM-DD)' }, { status: 400 }),
      );
    }
    return computePersonal({ startDate, endDate }).then((body) => Response.json(body));
  });
}
