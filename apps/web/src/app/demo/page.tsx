/**
 * /demo —— sitin.ai 客户门户入口（完全独立于主站看板账号鉴权）。
 * 服务端组件仅设置页面标题并挂载客户端门户组件。
 */

import type { Metadata } from 'next';

import { SitinPortal } from './demo-portal';

export const metadata: Metadata = {
  title: 'sitin.ai · 客户控制台',
  description: 'sitin.ai —— AI 创作者合创投放控制台',
};

export default function DemoPage(): React.ReactElement {
  return <SitinPortal />;
}
