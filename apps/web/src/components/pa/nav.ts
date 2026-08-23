import type { NavIcon } from '@/components/ui';

/** 侧栏导航。分组来自 Figma 稿：Workspace（日常）/ Manage（配置）。 */
export interface PaNavItem {
  key: string;
  label: string;
  href: string;
  icon: NavIcon;
  /** 显示在投 campaign 数。只有 Campaigns 有。 */
  counted?: boolean;
}

export const NAV_GROUPS: { group: string; items: PaNavItem[] }[] = [
  {
    group: 'Workspace',
    items: [
      { key: 'overview', label: 'Overview', href: '/pa', icon: 'overview' },
      {
        key: 'campaigns',
        label: 'Campaigns',
        href: '/pa/campaigns',
        icon: 'campaigns',
        counted: true,
      },
      { key: 'kols', label: 'KOL Network', href: '/pa/kols', icon: 'kols' },
      { key: 'content', label: 'Content', href: '/pa/content', icon: 'content' },
      { key: 'reports', label: 'Reports', href: '/pa/reports', icon: 'reports' },
    ],
  },
  {
    group: 'Manage',
    items: [{ key: 'settings', label: 'Settings', href: '/pa/settings', icon: 'settings' }],
  },
];

/** 路径 → 当前高亮的导航项。子路由归到它的一级项。 */
export function navKeyFor(pathname: string): string {
  if (pathname.startsWith('/pa/campaigns')) return 'campaigns';
  if (pathname.startsWith('/pa/kols')) return 'kols';
  if (pathname.startsWith('/pa/content')) return 'content';
  if (pathname.startsWith('/pa/reports')) return 'reports';
  if (pathname.startsWith('/pa/settings')) return 'settings';
  return 'overview';
}
