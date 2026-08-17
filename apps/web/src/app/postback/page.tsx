import type { ReactNode } from 'react';

import { renderGuardedPanel } from '@/lib/dashboard/guarded-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** API接收数据面板路由（/postback）。未认证跳登录。 */
export default function PostbackPage(): Promise<ReactNode> {
  return renderGuardedPanel('postback');
}
