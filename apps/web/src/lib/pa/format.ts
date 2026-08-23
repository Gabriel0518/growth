/**
 * 数值格式化。移植自原型 `js/ui.js` 的 Fmt，口径逐字保持一致 ——
 * 这些函数的输出会与 Figma 表格里的数字逐位比对，改了就对不上了。
 */

import type { Campaign } from './types';

export function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** 紧凑金额，用于空间受限处（卡片指标、阶段条）。 */
export function moneyK(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${String(Math.round(n / 1000))}K`;
  return `$${String(Math.round(n))}`;
}

/** 紧凑计数。10 万以上取整到 K，避免 "128.4K" 这种既长又没多少信息量的写法。 */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 100_000) return `${String(Math.round(n / 1000))}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function pct(n: number): string {
  return `${String(Math.round(n))}%`;
}

export function roas(n: number): string {
  return `${n.toFixed(2)}×`;
}

export function cpi(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * 缺数一律 em dash，**绝不用 0，也不用 N/A**。
 * 0 是一个真实的测量结果，拿它冒充「没有数据」是在撒谎（DESIGN-SPEC §12）。
 */
export function dash(
  value: number | string | null | undefined,
  fn?: (n: number) => string,
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return fn ? fn(value) : String(value);
  return value;
}

/** 消耗进度：花掉的占预算上限的百分比，封顶 100。 */
export function pacing(c: Pick<Campaign, 'spend' | 'cap'>): number {
  return c.cap ? Math.min(100, Math.round((c.spend / c.cap) * 100)) : 0;
}

/** campaign 的展示名。全站统一「名称 / 市场」，三个页面曾经各写各的。 */
export function campaignLabel(c: Pick<Campaign, 'name' | 'market'>): string {
  return `${c.name} / ${c.market}`;
}
