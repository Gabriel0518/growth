import type { ReactNode } from 'react';

import { renderGuardedPanel } from '@/lib/dashboard/guarded-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 投放管理面板路由（/ad-manager）。未认证跳登录。 */
export default function AdManagerPage(): Promise<ReactNode> {
  return renderGuardedPanel('ad-manager');
}
