import type { ReactNode } from 'react';

import { cn } from './cn';

/**
 * 色调是变体轴，文字是内容属性。
 *
 * 全站实际用到的状态词有 Live / Active / Paused / In review / Ready / Generating /
 * Rejected / Failed / Ended / Draft 等十余种。一词一变体会让每加一个状态就得改组件；
 * 收成 5 个色调 + 文本属性后，新增状态只是换个词（COMPONENTS.md 决定②）。
 */
export type PillTone = 'positive' | 'warning' | 'negative' | 'progress' | 'neutral';

const TONE: Record<PillTone, string> = {
  positive: 'bg-pa-positive-subtle text-pa-positive',
  warning: 'bg-pa-warning-subtle text-pa-warning',
  negative: 'bg-pa-negative-subtle text-pa-negative',
  progress: 'bg-pa-accent-subtle text-pa-accent',
  neutral: 'bg-pa-surface-muted text-pa-content-tertiary',
};

/**
 * 业务状态 → 色调。取自原型 STATUS_CLASS，是全站唯一的映射来源。
 *
 * ⚠️ rejected 走 negative 且**必须**由调用方区分是 `Internal rejected`（我们的人审素材）
 * 还是 `Platform rejected`（Meta/TikTok 拒审 → 广告关闭）—— 两者动作完全不同，
 * 不能只靠同一个红胶囊表达（CAMPAIGN-LIVE.md B11）。
 */
export const STATUS_TONE: Record<string, PillTone> = {
  running: 'positive',
  live: 'positive',
  ready: 'progress',
  automating: 'warning',
  review: 'warning',
  generating: 'warning',
  rejected: 'negative',
  failed: 'negative',
  draft: 'neutral',
  stopped: 'neutral',
  preparing: 'neutral',
  archived: 'neutral',
};

interface StatusPillProps {
  tone: PillTone;
  children: ReactNode;
  className?: string;
}

export function StatusPill({ tone, children, className }: StatusPillProps): ReactNode {
  return (
    <span
      className={cn(
        // pa-dot 画左侧小圆点。⚠️ 圆点只是强化，**颜色永远不是唯一信号** ——
        // 文字必须同时存在，任何状态都不得只靠颜色表达（COMPONENTS.md 决定②）。
        'pa-dot inline-flex h-[24px] items-center gap-[7px] whitespace-nowrap',
        'rounded-pa-full px-[11px] font-pa-mono text-pa-9 font-bold',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
