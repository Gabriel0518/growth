import type { ReactNode } from 'react';

import { cn } from '@/components/ui';

/**
 * 密集表格。
 *
 * ⚠️ **实心，绝不玻璃** —— 高密度小字叠 backdrop-filter，对比度不可控
 * （DESIGN-SPEC §6）。表头 UPPERCASE mono，数值列右对齐且必须带 pa-num。
 */
export function TableCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-pa-lg border border-pa-border bg-pa-surface',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 横向滚动容器。窄屏下表格自己滚，不去压缩列宽把字挤成两行。 */
export function TableScroll({ children }: { children: ReactNode }): ReactNode {
  return <div className="overflow-x-auto">{children}</div>;
}

export interface Column {
  key: string;
  label: string;
  /** 数值列：右对齐。 */
  num?: boolean;
}

export function TableHead({ columns }: { columns: Column[] }): ReactNode {
  return (
    <thead>
      <tr>
        {columns.map((col) => (
          <th
            key={col.key}
            scope="col"
            className={cn(
              'whitespace-nowrap bg-pa-surface-muted px-pa-3 py-[13px] font-pa-mono text-pa-10 font-bold uppercase tracking-[0.1em] text-pa-content-secondary',
              col.num ? 'text-right' : 'text-left',
            )}
          >
            {col.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function Table({
  children,
  minWidth = 900,
}: {
  children: ReactNode;
  minWidth?: number;
}): ReactNode {
  return (
    <table className="w-full border-collapse" style={{ minWidth }}>
      {children}
    </table>
  );
}

export function Td({
  children,
  num = false,
  className,
}: {
  children: ReactNode;
  num?: boolean;
  className?: string;
}): ReactNode {
  return (
    <td
      className={cn(
        'border-b border-pa-border-subtle px-pa-3 py-[10px] align-middle text-pa-12 text-pa-content-secondary',
        num && 'pa-num text-right',
        className,
      )}
    >
      {children}
    </td>
  );
}

/** 表格里的「主标题 + 副标题」单元格。长名字截断，不让它把行撑高。 */
export function CellStack({
  media,
  title,
  sub,
}: {
  media?: ReactNode;
  title: string;
  sub?: string | undefined;
}): ReactNode {
  return (
    <span className="flex items-center gap-[10px]">
      {media}
      <span className="min-w-0">
        <b className="block truncate text-pa-15 font-bold text-pa-content">{title}</b>
        {sub === undefined ? null : (
          <span className="mt-px block truncate text-pa-10 text-pa-content-tertiary">{sub}</span>
        )}
      </span>
    </span>
  );
}
