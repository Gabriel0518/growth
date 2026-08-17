import type { ReactNode } from 'react';

import { renderGuardedPanel } from '@/lib/dashboard/guarded-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 首页 = 汇总面板（/）。未认证跳登录。 */
export default function HomePage(): Promise<ReactNode> {
  return renderGuardedPanel('summary');
}
