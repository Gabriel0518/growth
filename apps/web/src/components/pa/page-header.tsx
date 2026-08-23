import type { ReactNode } from 'react';

import { cn } from '@/components/ui';

/** 全大写 mono 小标签。表头与眉标用同一个类，保证字距一致。 */
export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <p
      className={cn(
        'font-pa-mono text-pa-10 uppercase tracking-[0.16em] text-pa-content-tertiary',
        className,
      )}
    >
      {children}
    </p>
  );
}

interface PageHeaderProps {
  title: string;
  lede?: string | undefined;
  /** 标题右侧的状态胶囊等。 */
  badge?: ReactNode;
  /** 右上角按钮区。 */
  actions?: ReactNode;
}

export function PageHeader({ title, lede, badge, actions }: PageHeaderProps): ReactNode {
  return (
    <div className="mb-pa-6 mt-pa-2 flex flex-wrap items-start gap-pa-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-pa-3">
          <h1 className="text-pa-28 font-semibold tracking-[-0.01em]">{title}</h1>
          {badge}
        </div>
        {lede === undefined ? null : (
          <p className="mt-pa-1 text-pa-13 text-pa-content-body">{lede}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 flex-wrap gap-pa-3">{actions}</div>
      )}
    </div>
  );
}
