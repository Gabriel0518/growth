'use client';

import type { ReactNode } from 'react';

import { cn } from './cn';

export interface TabItem {
  value: string;
  label: string;
}

interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  'aria-label'?: string;
}

/**
 * ⚠️ 用了 role="tablist" 就必须在内容区给对应面板挂 role="tabpanel" +
 * aria-labelledby，否则读屏会念出「选项卡」却找不到它控制的东西。
 * id 由调用方通过 items[].value 保证唯一。
 */
export function Tabs({
  items,
  value,
  onChange,
  className,
  'aria-label': ariaLabel,
}: TabsProps): ReactNode {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn('flex items-center gap-pa-5 border-b border-pa-border', className)}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`tab-${item.value}`}
            aria-selected={selected}
            aria-controls={`tabpanel-${item.value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(item.value);
            }}
            className={cn(
              'min-h-[var(--pa-hit-target)] border-b-2 pb-[10px] pt-[12px] text-pa-13',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring',
              selected
                ? 'border-pa-accent font-semibold text-pa-content'
                : 'border-transparent text-pa-content-tertiary hover:text-pa-content-secondary',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
