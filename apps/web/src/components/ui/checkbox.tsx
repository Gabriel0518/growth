'use client';

import type { ReactNode } from 'react';

import { cn } from './cn';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 有文字时整行可点；没有文字时（如表格全选列）只有方框本身。 */
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  className,
}: CheckboxProps): ReactNode {
  return (
    <label
      className={cn(
        // 整行高度撑到 44px 满足命中区，方框视觉仍是 16px（DESIGN-SPEC §7）。
        'flex min-h-[var(--pa-hit-target)] cursor-pointer items-center gap-pa-2 text-pa-13',
        disabled && 'cursor-not-allowed opacity-45',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        className={cn(
          'h-[16px] w-[16px] shrink-0 accent-pa-accent',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring',
        )}
      />
      {label}
    </label>
  );
}
