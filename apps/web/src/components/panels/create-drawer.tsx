'use client';

import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/** 通用创建 Drawer：右侧滑入面板，适合内容较长的表单。 */
export function CreateDrawer({ open, title, onClose, children }: Props): React.ReactElement | null {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[8000] flex">
      {/* 遮罩 */}
      <div className="flex-1 bg-black/40" onClick={onClose} />
      {/* Drawer */}
      <div className="w-[600px] border-l border-border bg-bg-dark shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3 shrink-0">
          <h3 className="font-bold text-text">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-xs text-text-dim hover:border-accent hover:text-accent"
          >
            关闭
          </button>
        </div>
        {/* Body — scrollable */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {children}
        </div>
      </div>
    </div>
  );
}
