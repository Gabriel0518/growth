'use client';

import type { ReactNode } from 'react';

import { cn } from './cn';

interface RadioProps {
  /** 同一组必须共用一个 name，否则浏览器不会做互斥。 */
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Radio({
  name,
  value,
  checked,
  onChange,
  label,
  disabled = false,
  className,
}: RadioProps): ReactNode {
  return (
    <label
      className={cn(
        'flex min-h-[var(--pa-hit-target)] cursor-pointer items-center gap-pa-2 text-pa-13',
        disabled && 'cursor-not-allowed opacity-45',
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => {
          onChange(value);
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
