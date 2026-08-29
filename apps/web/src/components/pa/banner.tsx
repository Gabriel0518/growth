import type { ReactNode } from 'react';

import { cn } from '@/components/ui';

export type BannerTone = 'error' | 'warn' | 'info';

const TONE: Record<BannerTone, string> = {
  error: 'bg-pa-negative-subtle text-pa-negative border-pa-negative/25',
  warn: 'bg-pa-warning-subtle text-pa-warning border-transparent',
  info: 'bg-pa-accent-subtle text-pa-accent border-transparent',
};

interface BannerProps {
  tone: BannerTone;
  children: ReactNode;
  /** 右侧动作按钮。异常条必须给得出下一步，否则只是在报丧。 */
  action?: ReactNode;
  className?: string;
}

/**
 * 页内提示条。
 * ⚠️ 异常必须浮到页面顶部，不能埋在 42 行里 —— 全自动系统的价值不是「让你看它跑」，
 * 而是出问题时立刻告诉你（CAMPAIGN-LIVE.md）。
 */
export function Banner({ tone, children, action, className }: BannerProps): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-pa-3 rounded-pa-md border px-pa-4 py-[14px] text-pa-12',
        TONE[tone],
        className,
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
