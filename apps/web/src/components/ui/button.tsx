'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-pa-accent text-pa-on-accent hover:bg-pa-accent-ui',
  secondary: 'bg-pa-surface border-pa-border text-pa-content hover:bg-pa-surface-muted',
  ghost: 'text-pa-accent hover:bg-pa-accent-subtle',
  // ⚠️ danger 填充只出现在破坏性操作的**二次确认弹窗内**，
  // 绝不是页面上某个控件的常驻态（DESIGN-SPEC §4）。
  danger: 'bg-pa-negative text-white hover:brightness-[0.94]',
};

/**
 * 内边距按「变体 × 尺寸」直接算死，不靠工具类的先后顺序覆盖 ——
 * Tailwind 不保证同属性工具类的优先级由书写顺序决定，叠着写会随机失效。
 * ghost 是紧凑型（左右 10px），与其余变体不共用尺寸表。
 */
function paddingFor(variant: ButtonVariant, size: ButtonSize): string {
  if (variant === 'ghost') return 'px-[10px]';
  return size === 'sm' ? 'px-[14px]' : 'px-[18px]';
}

/**
 * 按钮的类名生成器。
 * 单独导出是为了让 `<Link>` 能长成按钮的样子 —— 一个导航目标应该渲染成 <a>
 * 而不是 <button>（中键新标签页、右键复制链接、读屏的角色播报都指望它）。
 * 这样也不用为此引入 Slot / cloneElement 那一套。
 */
export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  return cn(
    'inline-flex items-center justify-center gap-pa-2 whitespace-nowrap',
    'rounded-pa-md border border-transparent font-semibold',
    'transition-[background-color,border-color,filter] duration-[120ms]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring',
    size === 'sm' ? 'pa-hit min-h-[34px] text-pa-12' : 'min-h-[var(--pa-hit-target)] text-pa-13',
    paddingFor(variant, size),
    VARIANT[variant],
    'disabled:pointer-events-none disabled:opacity-45',
    className,
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-pa-2 whitespace-nowrap',
        'rounded-pa-md border border-transparent font-semibold',
        'transition-[background-color,border-color,filter] duration-[120ms]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring',
        // 命中区 44×44 —— sm 变体视觉高 34px，靠 pa-hit 的透明 ::after 补足，
        // 而不是把按钮画大（DESIGN-SPEC §7）。
        size === 'sm'
          ? 'min-h-[34px] text-pa-12 pa-hit'
          : 'min-h-[var(--pa-hit-target)] text-pa-13',
        paddingFor(variant, size),
        VARIANT[variant],
        'disabled:pointer-events-none disabled:opacity-45',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
