import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 飞书确认页已停用，旧链接统一返回普通账号登录页。 */
export default function WaitingPage(): ReactNode {
  redirect('/login');
}
