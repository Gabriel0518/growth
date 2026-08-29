'use client';

import type { ReactNode } from 'react';

import { cn } from '@/components/ui';

export interface DateRangeValue {
  start: string;
  end: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function isValidDateValue(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = parseDate(value);
  if (!Number.isFinite(date.getTime())) return false;
  const [year, month, day] = value.split('-').map(Number);
  return (
    date.getFullYear() === year && date.getMonth() === (month ?? 0) - 1 && date.getDate() === day
  );
}

export function toDateInputValue(date: Date): string {
  return `${date.getFullYear().toString()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function shiftDate(value: string, offset: number): string {
  const date = parseDate(value);
  date.setDate(date.getDate() + offset);
  return toDateInputValue(date);
}

export function defaultDateRange(days = 30): DateRangeValue {
  const end = toDateInputValue(new Date());
  return { start: shiftDate(end, -(Math.max(1, days) - 1)), end };
}

export function daysBetween(start: string, end: string): number {
  if (!isValidDateValue(start) || !isValidDateValue(end)) return 1;
  return Math.max(
    1,
    Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / 86_400_000) + 1,
  );
}

export function dateRangeLabels({ start, end }: DateRangeValue): string[] {
  if (!isValidDateValue(start) || !isValidDateValue(end)) return [];
  const count = daysBetween(start, end);
  const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  return Array.from({ length: count }, (_, index) => {
    const date = parseDate(start);
    date.setDate(date.getDate() + index);
    return formatter.format(date);
  });
}

export function formatDateRange({ start, end }: DateRangeValue): string {
  if (!isValidDateValue(start) || !isValidDateValue(end)) return 'Select dates';
  const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const startLabel = formatter.format(parseDate(start));
  const endLabel = formatter.format(parseDate(end));
  return start === end ? startLabel : `${startLabel} - ${endLabel}`;
}

interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  className?: string;
}

/** Shared free-form date range control for dashboard and reports. */
export function DateRangePicker({ value, onChange, className }: DateRangePickerProps): ReactNode {
  const today = toDateInputValue(new Date());

  function handleStartChange(start: string): void {
    if (!isValidDateValue(start)) return;
    const safeStart = start > today ? today : start;
    const safeEnd = value.end > today ? today : value.end;
    onChange({ start: safeStart, end: safeStart > safeEnd ? safeStart : safeEnd });
  }

  function handleEndChange(end: string): void {
    if (!isValidDateValue(end)) return;
    const safeEnd = end > today ? today : end;
    const safeStart = value.start > today ? today : value.start;
    onChange({ start: safeEnd < safeStart ? safeEnd : safeStart, end: safeEnd });
  }

  function updateStart(start: string): void {
    handleStartChange(start);
  }

  function updateEnd(end: string): void {
    handleEndChange(end);
  }

  return (
    <div
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_18px_minmax(0,1fr)] items-end gap-2 rounded-pa-md border border-pa-border bg-pa-surface px-3 py-2',
        className,
      )}
      aria-label="Date range"
    >
      <label className="grid min-w-0 cursor-pointer">
        <input
          type="date"
          value={value.start}
          max={today}
          aria-label="Start date"
          onChange={(event) => updateStart(event.target.value)}
          onBlur={(event) => {
            if (!isValidDateValue(event.currentTarget.value))
              event.currentTarget.value = value.start;
          }}
          className="h-[32px] min-w-0 w-full cursor-pointer bg-transparent text-pa-12 font-semibold text-pa-content outline-none"
        />
      </label>
      <span
        className="mb-[7px] grid h-[14px] w-[18px] place-items-center text-pa-content-tertiary"
        aria-hidden="true"
      >
        <svg viewBox="0 0 18 14" className="h-[12px] w-[16px]" fill="none">
          <path
            d="M1.5 7h14M10.5 2.5 15 7l-4.5 4.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <label className="grid min-w-0 cursor-pointer">
        <input
          type="date"
          value={value.end}
          max={today}
          aria-label="End date"
          onChange={(event) => updateEnd(event.target.value)}
          onBlur={(event) => {
            if (!isValidDateValue(event.currentTarget.value)) event.currentTarget.value = value.end;
          }}
          className="h-[32px] min-w-0 w-full cursor-pointer bg-transparent text-pa-12 font-semibold text-pa-content outline-none"
        />
      </label>
    </div>
  );
}
