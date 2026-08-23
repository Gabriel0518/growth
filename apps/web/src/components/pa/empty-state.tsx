import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  /** 说明为什么空，以及怎么走出去。只写「暂无数据」等于什么都没说。 */
  description?: string | undefined;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps): ReactNode {
  return (
    <div className="grid place-items-center gap-pa-1 px-pa-6 py-[56px] text-center">
      <h3 className="text-pa-15 font-semibold">{title}</h3>
      {description === undefined ? null : (
        <p className="max-w-[380px] text-pa-12 text-pa-content-tertiary">{description}</p>
      )}
      {action === undefined ? null : <div className="mt-pa-2">{action}</div>}
    </div>
  );
}
