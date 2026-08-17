import { readFetchStatus } from '@agentic-ug/fetcher';

import { requireApiAuth } from '@/lib/dashboard/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/status：返回抓取状态（复刻旧 fetcher.getStatus()），改由 PG fetch_status 读取。 */
export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  return Response.json(await readFetchStatus('main'));
}
