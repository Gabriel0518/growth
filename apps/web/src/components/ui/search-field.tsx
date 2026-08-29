'use client';

import type { ReactNode } from 'react';

import { cn } from './cn';

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function SearchField({
  value,
  onChange,
  placeholder = 'Search',
  className,
}: SearchFieldProps): ReactNode {
  return (
    <label
      className={cn(
        'flex h-[36px] items-center gap-[10px] rounded-pa-md border border-pa-border',
        'bg-pa-surface px-pa-3 text-pa-content-tertiary',
        'focus-within:border-pa-ring',
        className,
      )}
    >
      <svg
        viewBox="0 0 13 13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        className="h-[13px] w-[13px] shrink-0"
        aria-hidden="true"
      >
        <circle cx="5.4" cy="5.4" r="4.4" />
        <path d="M8.8 8.8L12 12" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        // placeholder 用 content-placeholder（2.9:1）—— 这是它唯一被允许的用途，
        // 因为占位符不承载信息，真实输入值用 content 正文色（DESIGN-SPEC §5）。
        className={cn(
          'w-full border-0 bg-transparent text-pa-12 text-pa-content outline-none',
          'placeholder:text-pa-content-placeholder',
        )}
      />
    </label>
  );
}
