'use client';

import flatpickr from 'flatpickr';
import { Mandarin } from 'flatpickr/dist/l10n/zh.js';
import type { Instance } from 'flatpickr/dist/types/instance';
import { useEffect, useRef } from 'react';

import { daySpan } from '@/lib/client/format';

const MAX_RANGE_DAYS = 31;

function toYmd(d: Date): string {
  return `${d.getFullYear().toString()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Props {
  startDate: string;
  endDate: string;
  onChange: (start: string, end: string) => void;
}

/** flatpickr range 选择器（zh，Y-m-d），超过 31 天回退——复刻旧 date-range picker。 */
export function DateRangePicker({ startDate, endDate, onChange }: Props): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const fpRef = useRef<Instance | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!inputRef.current) return;
    const fp = flatpickr(inputRef.current, {
      mode: 'range',
      dateFormat: 'Y-m-d',
      locale: Mandarin,
      defaultDate: [startDate, endDate],
      onChange: (selectedDates) => {
        if (selectedDates.length < 2) return;
        const ds = selectedDates.map((d) => toYmd(d)).sort();
        const lo = ds[0];
        const hi = ds[1];
        if (lo === undefined || hi === undefined) return;
        if (daySpan(lo, hi) > MAX_RANGE_DAYS) {
          globalThis.alert(
            `日期范围过大（${daySpan(lo, hi).toString()} 天）。当前多日查询性能有限，请选择不超过 ${MAX_RANGE_DAYS.toString()} 天的区间。`,
          );
          fp.setDate([startDate, endDate], false);
          return;
        }
        onChangeRef.current(lo, hi);
      },
    });
    fpRef.current = fp;
    return () => {
      fp.destroy();
      fpRef.current = null;
    };
    // 仅初始化一次；外部日期变更通过下面的 effect 同步。
  }, []);

  // 外部（如「今天」按钮）改变日期时，同步选择器显示但不触发 onChange。
  useEffect(() => {
    fpRef.current?.setDate([startDate, endDate], false);
  }, [startDate, endDate]);

  return (
    <input
      ref={inputRef}
      type="text"
      title="选择日期或区间"
      placeholder="选择日期或区间"
      readOnly
      className="w-[190px] cursor-pointer rounded-md border border-border bg-bg-card px-2 py-1.5 text-center text-[0.85rem] text-text focus:border-accent focus:outline-none"
    />
  );
}
