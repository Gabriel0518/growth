import type { ReactNode } from 'react';

import { cn } from '@/components/ui';

/** 细进度条。tone 走数据语义色 —— 它表达的是「达标 / 超支」而不是装饰。 */
export function Track({
  value,
  tone = 'accent',
  className,
}: {
  value: number;
  tone?: 'accent' | 'positive' | 'negative';
  className?: string;
}): ReactNode {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      className={cn(
        'mt-pa-2 h-[5px] overflow-hidden rounded-pa-full bg-pa-surface-muted',
        className,
      )}
    >
      <i
        className={cn(
          'pa-progress-fill block h-full',
          tone === 'positive' && 'bg-pa-positive',
          tone === 'negative' && 'bg-pa-negative',
          tone === 'accent' && 'bg-pa-accent',
        )}
        style={{ width: `${String(pct)}%` }}
      />
    </div>
  );
}
