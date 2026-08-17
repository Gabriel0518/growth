/**
 * 北京时区日期与月表工具 —— 逐字对齐旧 dashboard/server.js。
 * 全部为纯 epoch 偏移计算，与服务器系统时区无关。
 */

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function parseYmd(dateStr: string): [number, number, number] {
  const parts = dateStr.split('-');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/**
 * 月表选取与北京自然日边界统一由 @agentic-ug/core 提供，看板与 fetcher 共用同一实现，
 * 避免选表口径/边界计算在两处各存一份而漂移。此处 re-export 以保持既有 import 路径不变。
 */
export { tableForMonth, beijingDayBounds } from '@agentic-ug/core';
export type { BeijingDayBounds } from '@agentic-ug/core';

/** startDate..endDate（含两端）的 YYYY-MM-DD 数组。 */
export function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const [sy, sm, sd] = parseYmd(startDate);
  const [ey, em, ed] = parseYmd(endDate);
  const d = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  while (d <= end) {
    dates.push(`${d.getFullYear().toString()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/** 覆盖某日期区间的所有月表名（去重）。 */
export function getTablesForRange(startDate: string, endDate: string): string[] {
  const tables = new Set<string>();
  const [sy, sm, sd] = parseYmd(startDate);
  const [ey, em, ed] = parseYmd(endDate);
  const d = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  while (d <= end) {
    tables.add(`records_${d.getFullYear().toString()}${pad2(d.getMonth() + 1)}`);
    d.setDate(d.getDate() + 1);
  }
  return [...tables];
}

/** 北京时间「今天」YYYY-MM-DD。 */
export function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 北京时间「昨天」YYYY-MM-DD。纯 epoch 偏移，避免 setDate 跨时区多减一天。 */
export function yesterdayBeijing(): string {
  return new Date(Date.now() + 8 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
}

/** 当前北京时间的小时（0-23）。 */
export function nowBeijingHour(): number {
  return new Date(Date.now() + 8 * 3_600_000).getUTCHours();
}

/** dateB 比 dateA 早几天（B < A 为正）。 */
export function daysBefore(dateA: string, dateB: string): number {
  const a = new Date(`${dateA}T00:00:00Z`);
  const b = new Date(`${dateB}T00:00:00Z`);
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}
