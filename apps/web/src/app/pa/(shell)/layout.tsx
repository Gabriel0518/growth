'use client';

import type { ReactNode } from 'react';

import { AppShell } from '@/components/pa/app-shell';

/**
 * 应用外壳：侧栏 + 顶栏 + 内容容器。
 *
 * 用路由组 `(shell)` 的原因：Login 是唯一没有外壳的屏，但它要共享 /pa 的浅色主题。
 * `(shell)` 不进 URL —— /pa/campaigns 仍然是 /pa/campaigns。
 */
export default function ShellLayout({ children }: { children: ReactNode }): ReactNode {
  return <AppShell>{children}</AppShell>;
}
