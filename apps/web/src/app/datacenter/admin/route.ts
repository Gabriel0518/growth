import { getAthena, receiveAthena } from '../../../lib/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return getAthena(request);
}

export function POST(request: Request): Promise<Response> {
  return receiveAthena(request);
}
