import { clearSessionCookie } from '@/lib/dashboard/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(null, {
    status: 302,
    headers: new Headers({ Location: '/login', 'Set-Cookie': clearSessionCookie() }),
  });
}
