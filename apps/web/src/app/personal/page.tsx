import type { ReactNode } from 'react';

import { renderGuardedPanel } from '@/lib/dashboard/guarded-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 个人面板路由（/personal）。未认证跳登录。 */
export default function PersonalPage(): Promise<ReactNode> {
  return renderGuardedPanel('pb-personal');
}
