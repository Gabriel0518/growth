import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { WaitingClient } from './waiting-client';

import { readPending } from '@/lib/dashboard/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 等待确认页：无 pending cookie 直接回登录页；否则渲染轮询组件。 */
export default async function WaitingPage(): Promise<ReactNode> {
  const hdrs = await headers();
  const cookie = hdrs.get('cookie');
  const request = new Request('http://internal/login/waiting', {
    headers: cookie ? { cookie } : {},
  });
  const pending = readPending(request);
  if (!pending) redirect('/login');

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-dark">
      <div className="w-[420px] rounded-xl border border-white/10 bg-[#12122a] p-10 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <WaitingClient name={pending.name} />
      </div>
    </main>
  );
}
