'use client';

import { useEffect, useRef } from 'react';

/**
 * 覆盖层通用行为：Esc 关闭、焦点陷阱、关闭后把焦点还给触发它的元素、锁背景滚动。
 *
 * 这四条一起做才有意义 —— 只做 Esc 不做焦点归还，键盘用户关掉弹窗后焦点会掉到
 * body 上，等于在页面里迷路。
 */
export function useOverlay(onClose: () => void): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;

    // 打开时把焦点移进覆盖层，否则读屏还停在背景内容上。
    const focusables = () =>
      node
        ? [
            ...node.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          ]
        : [];
    focusables()[0]?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      // 循环 Tab，不让焦点跑到背景里去。
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      opener?.focus();
    };
  }, []);

  return ref;
}
