import type { ReactNode } from 'react';

import 'flatpickr/dist/flatpickr.min.css';
import './globals.css';

export const metadata = {
  title: 'Sitin 投放数据平台',
  description: 'Agentic UG 数据平台',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  // 渲染前读取 localStorage 设置 data-theme，避免刷新时主题闪烁（默认 dark）。
  const themeScript = `(function(){try{var t=localStorage.getItem('ug-theme');document.documentElement.dataset.theme=t==='light'?'light':'dark';}catch(e){document.documentElement.dataset.theme='dark';}})();`;
  return (
    <html lang="zh-CN" data-theme="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
