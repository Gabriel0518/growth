import type { ReactNode } from 'react';

import { cn } from '@/components/ui';

interface CardProps {
  children: ReactNode;
  /** 直接给内边距的简单卡片；需要 CardHead 时用 false 并自行控制内部间距。 */
  padded?: boolean;
  className?: string;
}

/** ⚠️ 实心，绝不玻璃。浅色下 --glass-bg 只有 72% 不透明度，达不到 §6 的 ≥0.85。 */
export function Card({ children, padded = false, className }: CardProps): ReactNode {
  return (
    <div
      className={cn(
        'rounded-pa-lg border border-pa-border bg-pa-surface',
        padded && 'p-pa-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

interface CardHeadProps {
  title: string;
  sub?: string | undefined;
  /** 右侧操作区（分段控件、DataTrust、计数）。 */
  aside?: ReactNode;
  className?: string;
}

export function CardHead({ title, sub, aside, className }: CardHeadProps): ReactNode {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-pa-3 border-b border-pa-border-subtle px-pa-4 py-[14px]',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-pa-15 font-semibold">{title}</div>
        {sub === undefined ? null : (
          <div className="text-pa-11 text-pa-content-tertiary">{sub}</div>
        )}
      </div>
      {aside}
    </div>
  );
}
