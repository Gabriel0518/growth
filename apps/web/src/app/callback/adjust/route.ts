import { ingestCallbackBatch } from '../../../lib/callback';
import { queryParams, readCallbackParams } from '../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_KEYS = ['network', 'platform'] as const;

export function GET(request: Request): Promise<Response> {
  return ingestCallbackBatch([queryParams(request)], SOURCE_KEYS, 'adjust', 'ad');
}

export async function POST(request: Request): Promise<Response> {
  return ingestCallbackBatch(await readCallbackParams(request), SOURCE_KEYS, 'adjust', 'ad');
}
