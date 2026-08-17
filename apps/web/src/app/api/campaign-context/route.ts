import { requireApiAuth } from '@/lib/dashboard/auth';
import { computeCampaignContext } from '@/lib/dashboard/campaign-context';
import { withGuard } from '@/lib/dashboard/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/campaign-context：为投放大师 AI 组装某 campaign×product×channel 的近 7 日数据包（HTML 摘要 + 结构化输入 + prompt messages）。 */
export function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return Promise.resolve(auth);

  return withGuard(request, auth, async () => {
    const q = new URL(request.url).searchParams;
    const campaign = q.get('campaign');
    const product = q.get('product');
    const channel = q.get('channel');
    if (!campaign || !product || !channel) {
      return Response.json({ error: 'campaign, product, channel required' }, { status: 400 });
    }

    const operator = q.get('operator');
    const date = q.get('date');
    const result = await computeCampaignContext({
      campaign,
      product,
      channel,
      ...(operator == null ? {} : { operator }),
      ...(date == null ? {} : { date }),
    });
    return Response.json(result);
  });
}
