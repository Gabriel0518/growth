/**
 * 首页面板（tab）定义 —— 纯常量，供服务端各路由 page.tsx 与客户端 dashboard.tsx 共用。
 * URL 以路径表达当前面板（summary=/，其余 /personal、/creative 等），刷新可直达；
 * 未知路径归一到 summary。
 */

export type PanelName =
  | 'summary'
  | 'pb-personal'
  | 'creative'
  | 'postback'
  | 'daily-report'
  | 'ad-manager';

export const PANELS: { key: PanelName; label: string; path: string }[] = [
  { key: 'summary', label: '汇总面板', path: '/' },
  { key: 'pb-personal', label: '个人面板', path: '/personal' },
  { key: 'creative', label: '素材面板', path: '/creative' },
  { key: 'daily-report', label: '投放日报', path: '/daily-report' },
  { key: 'ad-manager', label: '投放管理', path: '/ad-manager' },
];

const PATH_TO_PANEL = new Map<string, PanelName>(PANELS.map((p) => [p.path, p.key]));
const PANEL_TO_PATH = new Map<PanelName, string>(PANELS.map((p) => [p.key, p.path]));

/** 面板 → 路径（用于 pushState / 链接）。 */
export function pathForPanel(panel: PanelName): string {
  return PANEL_TO_PATH.get(panel) ?? '/';
}

/** 路径 → 面板（用于 popstate / 直链）；未知路径回退 summary。 */
export function panelFromPath(pathname: string): PanelName {
  return PATH_TO_PANEL.get(pathname) ?? 'summary';
}
