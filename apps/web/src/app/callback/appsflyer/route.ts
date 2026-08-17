import { ingestCallbackBatch } from '../../../lib/callback';
import { queryParams, readCallbackParams } from '../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 旧 dataserver：GET 与 POST 的 source 候选键不同（POST 多一个 af_channel）。
const GET_KEYS = ['media_source', 'platform'] as const;
const POST_KEYS = ['media_source', 'af_channel', 'platform'] as const;

export function GET(request: Request): Promise<Response> {
  return ingestCallbackBatch([queryParams(request)], GET_KEYS, 'appsflyer', 'af');
}

export async function POST(request: Request): Promise<Response> {
  return ingestCallbackBatch(await readCallbackParams(request), POST_KEYS, 'appsflyer', 'af');
}
