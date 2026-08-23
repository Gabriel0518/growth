'use client';

import type { ReactNode } from 'react';

import { cn } from './cn';

export interface SegmentItem {
  value: string;
  label: string;
}

interface SegmentProps {
  items: SegmentItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  'aria-label'?: string;
}

/**
 * 分段控件用于**同一份数据的不同视图**（Grid / Table、全部 / 在投）。
 * 若选项之间会换掉数据本身，那是 Tab 不是 Segment —— 别混用。
 */
export function Segment({
  items,
  value,
  onChange,
  className,
  'aria-label': ariaLabel,
}: SegmentProps): ReactNode {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn('inline-flex gap-[2px] rounded-pa-md bg-pa-surface-muted p-[3px]', className)}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              onChange(item.value);
            }}
            className={cn(
              'rounded-[6px] px-[14px] py-[7px] text-pa-12 font-semibold',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring',
              selected
                ? 'bg-pa-surface text-pa-content shadow-pa-1'
                : 'text-pa-content-tertiary hover:text-pa-content-secondary',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
