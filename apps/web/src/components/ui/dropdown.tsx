'use client';

import type { ReactNode } from 'react';

import { cn } from './cn';

export interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

/**
 * 用原生 `<select>` 而不是自绘浮层：原生的键盘操作、移动端滚轮选择器和读屏支持
 * 都是免费的，自绘一套要补一堆 a11y 才能打平。
 * 箭头是内联 SVG 背景图 —— `appearance: none` 之后必须自己补一个。
 */
export function Dropdown({
  options,
  value,
  onChange,
  disabled = false,
  className,
  'aria-label': ariaLabel,
}: DropdownProps): ReactNode {
  return (
    <div className={cn('relative', className)}>
      <select
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cn(
          'h-[var(--pa-hit-target)] w-full cursor-pointer appearance-none',
          'rounded-pa-md border border-pa-border bg-pa-surface',
          'pl-[14px] pr-[34px] text-pa-13 text-pa-content outline-none',
          'focus:border-pa-ring focus:shadow-[0_0_0_3px_rgba(8,145,178,0.16)]',
          'disabled:cursor-not-allowed disabled:bg-pa-surface-muted disabled:opacity-60',
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg
        viewBox="0 0 10 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
        className="pointer-events-none absolute right-pa-3 top-1/2 h-[6px] w-[10px] -translate-y-1/2 text-pa-content-tertiary"
      >
        <path d="M1 1l4 4 4-4" strokeLinecap="round" />
      </svg>
    </div>
  );
}
