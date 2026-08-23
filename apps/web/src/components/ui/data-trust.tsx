import type { ReactNode } from 'react';

import { cn } from './cn';

/**
 * DataTrust —— 这套设计系统存在的理由，不是可有可无的徽章。
 *
 * 它回应 doc 01 §8.2 的实际问题：顶栏日期控件只有 2/5 页面真实消费，
 * 用户却以为已经过滤了当前页。DataTrust 让**每个数字自己说明**「什么口径、
 * 什么时间、可不可信」，而不是靠一个全局控件去暗示。
 *
 * 配套的产品改动是把日期控件从顶栏下沉到真正消费它的页面 —— 只加徽章不搬控件，
 * 等于承认问题但不解决（CLAUDE.md B5）。
 */
export type TrustState = 'fresh' | 'stale' | 'partial' | 'failed';

const STATE: Record<TrustState, string> = {
  fresh: 'text-pa-positive',
  stale: 'text-pa-warning',
  // ⚠️ 用 content-tertiary（4.6:1）而不是 content-placeholder（2.9:1）——
  // 「部分缺数」是承载信息的文字，不是占位符（DESIGN-SPEC §2.2 的 text-3 警告）。
  partial: 'text-pa-content-tertiary',
  failed: 'text-pa-negative',
};

interface DataTrustProps {
  state: TrustState;
  children: ReactNode;
  className?: string;
}

export function DataTrust({ state, children, className }: DataTrustProps): ReactNode {
  return (
    <span
      className={cn(
        'pa-dot inline-flex items-center gap-[6px] font-pa-mono text-pa-9',
        STATE[state],
        className,
      )}
    >
      {children}
    </span>
  );
}
