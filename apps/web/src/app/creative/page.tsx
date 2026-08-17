import type { ReactNode } from 'react';

import { renderGuardedPanel } from '@/lib/dashboard/guarded-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 素材面板路由（/creative）。未认证跳登录。 */
export default function CreativePage(): Promise<ReactNode> {
  return renderGuardedPanel('creative');
}
