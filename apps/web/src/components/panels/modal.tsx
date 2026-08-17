'use client';

import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** 通用弹窗：遮罩 + 居中白色面板。点击遮罩关闭。 */
export function Modal({ open, title, onClose, children }: Props): React.ReactElement | null {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[8000] flex items-center justify-center">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      {/* 面板 */}
      <div className="relative w-full max-w-lg rounded-xl border border-border bg-bg-dark shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="font-bold text-text">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-xs text-text-dim hover:border-accent hover:text-accent"
          >
            关闭
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
