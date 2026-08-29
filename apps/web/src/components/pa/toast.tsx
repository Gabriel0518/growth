'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { cn } from '@/components/ui';

export type ToastTone = 'ok' | 'error' | 'neutral';

interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

const ToastContext = createContext<((text: string, tone?: ToastTone) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((text: string, tone: ToastTone = 'neutral') => {
    // 用递增序号而不是 Date.now()/random 当 key —— 服务端与客户端要能对上，
    // 且截图可复现。
    setItems((prev) => {
      const id = (prev.at(-1)?.id ?? 0) + 1;
      globalThis.setTimeout(() => {
        setItems((cur) => cur.filter((t) => t.id !== id));
      }, 4000);
      return [...prev, { id, text, tone }];
    });
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-live 让读屏播报操作结果 —— 只做视觉提示的话，键盘用户不知道操作成没成 */}
      <div
        className="pointer-events-none fixed bottom-pa-5 right-pa-5 z-[80] grid gap-[10px]"
        role="status"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex max-w-[380px] items-center gap-[10px] rounded-pa-md px-pa-4 py-pa-3 text-pa-12 text-white shadow-pa-2',
              t.tone === 'ok' && 'bg-pa-positive',
              t.tone === 'error' && 'bg-pa-negative',
              t.tone === 'neutral' && 'bg-pa-content',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, tone?: ToastTone) => void {
  const push = useContext(ToastContext);
  if (!push) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return push;
}
