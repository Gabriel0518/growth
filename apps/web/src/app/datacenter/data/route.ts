import { ingestData, queryData } from '../../../lib/records';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return queryData(request);
}

export function POST(request: Request): Promise<Response> {
  return ingestData(request);
}
