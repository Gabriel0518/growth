import { stats } from '../../../lib/records';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return stats();
}
