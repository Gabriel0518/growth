import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { Dashboard } from '@/components/dashboard';
import { readSession } from '@/lib/dashboard/auth';
import type { PanelName } from '@/lib/panels';

/**
 * 面板路由公共渲染：校验会话（未认证跳登录），再以固定初始面板直出 Dashboard。
 * 各路径路由（/、/personal、/creative、/aigc、/postback）复用此函数，避免重复鉴权逻辑。
 */
export async function renderGuardedPanel(initialPanel: PanelName): Promise<ReactNode> {
  const hdrs = await headers();
  const cookie = hdrs.get('cookie');
  const request = new Request('http://internal/', {
    headers: cookie ? { cookie } : {},
  });
  if (!readSession(request).authenticated) redirect('/login');
  return <Dashboard initialPanel={initialPanel} />;
}
