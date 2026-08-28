import type { ReactNode } from 'react';

import { cn } from './cn';
import { DataTrust, type TrustState } from './data-trust';

interface MetricCardProps {
  label: string;
  /** 已格式化好的展示值。缺数传 '—'，**不要**传 '0' 或 'N/A'（DESIGN-SPEC §12）。 */
  value: string;
  sub?: string | undefined;
  trust?: { state: TrustState; text: string };
  /** 右上角迷你图等附加内容。 */
  aside?: ReactNode;
  className?: string;
}

/**
 * ⚠️ 实心，**绝不玻璃**。浅色下 --glass-bg 只有 72% 不透明度，达不到 §6 要求的 ≥0.85，
 * 叠在彩色背景上对比度不可控（DESIGN-SPEC v0.2 变更 C3）。
 */
export function MetricCard({
  label,
  value,
  sub,
  trust,
  aside,
  className,
}: MetricCardProps): ReactNode {
  return (
    <div className={cn('rounded-pa-lg border border-pa-border bg-pa-surface p-pa-4', className)}>
      <div className="flex items-start gap-[10px]">
        <div className="min-w-0 flex-1">
          <div className="text-pa-13 font-semibold text-pa-content">{label}</div>
          {/* pa-num：等宽数位 + 关连字，保证数值列对齐且 1/l、0/O 不混淆 */}
          <div className="pa-num mt-[6px] text-pa-27 font-bold">{value}</div>
        </div>
        {aside === undefined ? null : <div className="shrink-0">{aside}</div>}
      </div>
      {sub === undefined && trust === undefined ? null : (
        <div className="mt-pa-2 flex items-center gap-pa-2">
          {trust === undefined ? null : <DataTrust state={trust.state}>{trust.text}</DataTrust>}
          {sub === undefined ? null : (
            <span className="font-pa-mono text-pa-9 text-pa-content-tertiary">{sub}</span>
          )}
        </div>
      )}
    </div>
  );
}
