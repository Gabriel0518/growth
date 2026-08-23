'use client';

import type { ReactNode } from 'react';

import { useOverlay } from './use-overlay';

import { cn } from '@/components/ui';

interface DialogProps {
  title: string;
  /** 一句话说明这个弹窗会造成什么后果，不要重复标题。 */
  lede?: string | undefined;
  children?: ReactNode;
  /** 页脚按钮区。取消在左、主操作在右。 */
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}

export function Dialog({
  title,
  lede,
  children,
  footer,
  onClose,
  wide = false,
}: DialogProps): ReactNode {
  const ref = useOverlay(onClose);
  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-[rgba(15,23,42,0.42)] p-pa-6"
      // 点遮罩关闭。⚠️ 只在遮罩本身上触发，冒泡上来的点击不算，
      // 否则在弹窗里选中文字松开鼠标会误关。
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pa-dialog-title"
        className={cn(
          'flex max-h-[88vh] w-full flex-col rounded-pa-lg bg-pa-surface shadow-pa-2',
          wide ? 'max-w-[720px]' : 'max-w-[560px]',
        )}
      >
        <div className="px-pa-6 pt-pa-5">
          <h2 id="pa-dialog-title" className="text-pa-17 font-semibold">
            {title}
          </h2>
          {lede === undefined ? null : (
            <p className="mt-pa-2 text-pa-12 text-pa-content-body">{lede}</p>
          )}
        </div>
        {children === undefined ? null : (
          <div className="grid gap-pa-4 overflow-auto px-pa-6 py-pa-5">{children}</div>
        )}
        {footer === undefined ? null : (
          <div className="flex justify-end gap-[10px] border-t border-pa-border-subtle px-pa-6 pb-pa-5 pt-pa-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** 旧值 → 新值对照表。高风险确认必须展示它，只问「确定吗」等于没说改了什么。 */
export function DeltaList({
  rows,
}: {
  rows: { label: string; from: string; to: string }[];
}): ReactNode {
  return (
    <dl className="overflow-hidden rounded-pa-md border border-pa-border">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[130px_1fr] gap-pa-3 border-t border-pa-border-subtle px-[14px] py-[11px] text-pa-12 first:border-t-0"
        >
          <dt className="text-pa-content-tertiary">{row.label}</dt>
          <dd className="pa-num flex flex-wrap items-center gap-pa-2">
            <span>{row.from}</span>
            <span className="text-pa-content-tertiary" aria-label="changes to">
              →
            </span>
            <span className="font-bold">{row.to}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
