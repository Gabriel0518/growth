'use client';

import type { ReactNode } from 'react';

import { useOverlay } from './use-overlay';

interface DrawerProps {
  title: string;
  lede?: string | undefined;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}

/** 右侧抽屉。用于内容较长、需要边看列表边勾选的流程（加创作者、生成变体）。 */
export function Drawer({ title, lede, children, footer, onClose }: DrawerProps): ReactNode {
  const ref = useOverlay(onClose);
  return (
    <div
      className="fixed inset-0 z-[61] bg-[rgba(15,23,42,0.42)]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pa-drawer-title"
        className="absolute inset-y-0 right-0 flex w-full max-w-[480px] flex-col bg-pa-surface shadow-pa-3"
      >
        <div className="border-b border-pa-border-subtle px-pa-6 py-pa-5">
          <h2 id="pa-drawer-title" className="text-pa-17 font-semibold">
            {title}
          </h2>
          {lede === undefined ? null : (
            <p className="mt-pa-2 text-pa-12 text-pa-content-body">{lede}</p>
          )}
        </div>
        <div className="flex-1 overflow-auto px-pa-6 py-pa-5">{children}</div>
        {footer === undefined ? null : (
          <div className="flex justify-end gap-[10px] border-t border-pa-border-subtle px-pa-6 py-pa-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
