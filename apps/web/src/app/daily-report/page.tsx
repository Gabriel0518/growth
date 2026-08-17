/**
 * 全自动投手日报面板 —— 服务端渲染入口。
 * 跟其他面板一样，由 Dashboard 客户端组件接管渲染。
 */

'use client';

import { Dashboard } from '@/components/dashboard';

export default function DailyReportPage(): React.ReactElement {
  return <Dashboard initialPanel="daily-report" />;
}
