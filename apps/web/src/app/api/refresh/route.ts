import { fetchAll, isFetchLockStale, readFetchStatus } from '@agentic-ug/fetcher';

import { requireApiAuth } from '@/lib/dashboard/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/refresh：手动触发 fetchAll（复刻旧 /api/refresh），fetching 中返回 409。 */
export async function POST(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  const status = await readFetchStatus('main');
  // 抓取进行中且锁未超时才拦截；锁已陈旧（崩溃残留）则放行，fetchAll 会抢锁重跑。
  if (status.isFetching && !isFetchLockStale(status)) {
    return Response.json({ error: 'Fetch already in progress' }, { status: 409 });
  }

  void fetchAll()
    .then(() => {
      console.log('[Server] Manual fetch completed');
    })
    .catch((error: unknown) => {
      console.error(`[Server] Manual fetch error: ${(error as Error).message}`);
    });

  return Response.json({ message: 'Fetch started' });
}
