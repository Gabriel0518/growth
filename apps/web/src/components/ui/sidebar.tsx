'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { cn } from './cn';

export type NavIcon = 'overview' | 'campaigns' | 'kols' | 'content' | 'reports' | 'settings';

const ICONS: Record<NavIcon, ReactNode> = {
  overview: (
    <g fill="currentColor">
      <rect x="0" y="0" width="6.5" height="6.5" rx="1.5" />
      <rect x="9.5" y="0" width="6.5" height="6.5" rx="1.5" />
      <rect x="0" y="9.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="9.5" y="9.5" width="6.5" height="6.5" rx="1.5" />
    </g>
  ),
  campaigns: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="1" y="2.5" width="14" height="12" rx="2" />
      <path d="M1 6.5h14M5 1v3M11 1v3" strokeLinecap="round" />
    </g>
  ),
  kols: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="6" cy="5" r="3" />
      <path d="M1 14.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" strokeLinecap="round" />
      <path d="M12 3.2a2.6 2.6 0 010 4.6M13.5 14.5c0-2-.6-3.4-1.7-4.3" strokeLinecap="round" />
    </g>
  ),
  content: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="1" y="2" width="15" height="12" rx="2" />
      <circle cx="5.5" cy="6" r="1.3" fill="currentColor" stroke="none" />
      <path
        d="M2 12l3.6-3.6a1.5 1.5 0 012.1 0L11 11.7M10.2 10.9l1.6-1.6a1.5 1.5 0 012.1 0L16 11.2"
        strokeLinecap="round"
      />
    </g>
  ),
  reports: (
    <g fill="currentColor">
      <rect x="0" y="9" width="3" height="7" rx="1" />
      <rect x="6.5" y="4" width="3" height="12" rx="1" />
      <rect x="13" y="6.5" width="3" height="9.5" rx="1" />
    </g>
  ),
  settings: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="8" cy="8" r="6.6" />
      <circle cx="8" cy="8" r="2.4" />
    </g>
  ),
};

export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: NavIcon;
  /** 待处理数量。0 或缺省时不渲染徽章 —— 空徽章比没有徽章更吵。 */
  badge?: number;
}

interface SidebarProps {
  items: NavItem[];
  /** 当前页对应的 item.key。 */
  active: string;
  brand?: ReactNode;
  /** 底部区（消耗计与用户位）。底部锚定，与导航项分别贴上下两端。 */
  footer?: ReactNode;
  className?: string;
}

/**
 * ⚠️ 导航项必须用 next/link 的 <Link>，**不能用原生 <a href>**。
 * 原生 <a> 会触发整页重载：React 状态全部丢失，跨屏联动直接失效
 * （表现为「在详情页暂停了 campaign，回到列表还显示 Live」），而且每次点导航
 * 都要重新下载并执行整个 bundle。已踩过一次。
 *
 * 高度可拉伸，**不按页面高度出变体**。
 *
 * 底板 stretch、导航项顶部锚定、footer 底部锚定 —— 一个实例覆盖 900px 的登录页
 * 到 1761px 的总览页。若按高度出变体，6 个导航态会膨胀成 40 多个（COMPONENTS.md 决定①）。
 *
 * 窄屏直接隐藏：这是给每天盯盘 8 小时的人用的桌面工具，
 * 折叠成汉堡菜单只会让主内容区更挤，不如让它先消失。
 */
export function Sidebar({ items, active, brand, footer, className }: SidebarProps): ReactNode {
  return (
    <nav
      className={cn(
        'sticky top-0 hidden h-screen w-[224px] shrink-0 flex-col md:flex',
        'border-r border-pa-border bg-pa-surface',
        className,
      )}
    >
      {brand === undefined ? null : (
        <div className="flex items-center gap-[10px] p-[22px]">{brand}</div>
      )}

      <div className="px-[14px]">
        {items.map((item) => {
          const current = item.key === active;
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'flex min-h-[var(--pa-hit-target)] w-full items-center gap-[14px]',
                'rounded-pa-md px-[14px] text-pa-13 font-medium',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring',
                current
                  ? 'bg-pa-accent-subtle font-semibold text-pa-accent'
                  : 'text-pa-content-secondary hover:bg-pa-surface-muted',
              )}
            >
              <svg viewBox="0 0 16 16" className="h-[16px] w-[16px] shrink-0" aria-hidden="true">
                {ICONS[item.icon]}
              </svg>
              {item.label}
              {item.badge === undefined || item.badge === 0 ? null : (
                <span className="ml-auto rounded-pa-full bg-pa-warning-subtle px-[7px] py-[3px] font-pa-mono text-pa-9 text-pa-warning">
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {footer === undefined ? null : (
        <div className="mt-auto grid gap-[22px] p-[22px]">{footer}</div>
      )}
    </nav>
  );
}
