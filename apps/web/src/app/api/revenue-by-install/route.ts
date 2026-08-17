import { requireApiAuth } from '@/lib/dashboard/auth';
import { todayBeijing } from '@/lib/dashboard/dates';
import { withGuard } from '@/lib/dashboard/guard';
import { computeRevenueByInstall } from '@/lib/dashboard/revenue-by-install';
import type { RevByInstallLevel } from '@/lib/dashboard/revenue-by-install';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEVELS = new Set<RevByInstallLevel>(['campaign', 'channel', 'product', 'operator']);

/** GET /api/revenue-by-install：按安装日的修正收入曲线（level=campaign|channel|product|operator）。 */
export function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return Promise.resolve(auth);

  return withGuard(request, auth, () => {
    const q = new URL(request.url).searchParams;
    const level = (q.get('level') ?? 'campaign').trim() as RevByInstallLevel;
    if (!LEVELS.has(level)) {
      return Promise.resolve(
        Response.json(
          { error: 'level must be campaign|channel|product|operator' },
          { status: 400 },
        ),
      );
    }
    const date = (q.get('date') ?? todayBeijing()).trim();
    if (!DATE_RE.test(date)) {
      return Promise.resolve(
        Response.json({ error: 'Invalid date (YYYY-MM-DD)' }, { status: 400 }),
      );
    }
    let days = Number.parseInt(q.get('days') ?? '', 10);
    if (!Number.isFinite(days) || days <= 0) days = 99;
    if (days > 180) days = 180;

    const campaign = (q.get('campaign') ?? '').trim();
    const channel = (q.get('channel') ?? '').trim();
    const product = (q.get('product') ?? '').trim();
    const operator = (q.get('operator') ?? '').trim();

    if (level === 'campaign' && (!campaign || !product || !channel)) {
      return Promise.resolve(
        Response.json(
          { error: 'campaign level requires campaign, product, channel' },
          { status: 400 },
        ),
      );
    }
    if (level === 'channel' && (!product || !channel)) {
      return Promise.resolve(
        Response.json({ error: 'channel level requires product, channel' }, { status: 400 }),
      );
    }
    if (level === 'product' && !product) {
      return Promise.resolve(
        Response.json({ error: 'product level requires product' }, { status: 400 }),
      );
    }
    if (level === 'operator' && !operator) {
      return Promise.resolve(
        Response.json({ error: 'operator level requires operator' }, { status: 400 }),
      );
    }

    return computeRevenueByInstall({
      level,
      date,
      days,
      campaign,
      channel,
      product,
      operator,
    }).then((body) => Response.json(body));
  });
}
