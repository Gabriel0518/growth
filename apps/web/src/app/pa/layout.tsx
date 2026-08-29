import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { PaStoreProvider, ToastProvider } from '@/components/pa';

export const metadata: Metadata = {
  title: 'Sitin.ai · Partnership ADS',
  description: 'Cross-platform KOL advertising — campaigns, creators, creative and reporting.',
};

/**
 * /pa 的主题隔离层。
 *
 * 根 layout 把 `<html data-theme="dark">` 写死、`body` 也是深色（那是现有投放看板的
 * 默认主题）。Partnership ADS 是**浅色单主题**，与明暗切换无关，所以这里用一个铺满
 * 视口的容器把背景与文字色盖过去 —— 与 /demo 用 `.root` 作用域隔离是同一个套路，
 * 不去动全局，现有看板不受影响。
 *
 * ⚠️ 不要试图在这里改 <html> 的 data-theme：嵌套 layout 拿不到 <html>，
 * 而且改了会把现有看板的主题一起带偏。
 */
export default function PaLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <PaStoreProvider>
      <ToastProvider>
        <div className="flex min-h-screen w-full flex-col bg-pa-bg-app font-pa-ui text-pa-14 text-pa-content">
          {children}
        </div>
      </ToastProvider>
    </PaStoreProvider>
  );
}
