/**
 * 修正系数（读侧）—— 计算逻辑与映射表全部来自 @agentic-ug/core 的唯一真源，
 * 本文件只负责看板特有的三层取数：内存缓存 → 每日持久化 → 现算兜底。
 *
 * 写侧是 packages/fetcher/src/correction.ts（scheduler 每日定稿昨日后算一次写库）。
 * 两侧现在共用 core.computeCorrectionFactors，公式与产品映射不会再分叉——
 * 历史上这两处各存一份实现，Mora iOS 上线时只改了本文件，写库快照里始终缺 Mora，
 * 所有读持久化的下游都静默兜底成 1（详见 core/src/correction.ts 头注释）。
 */

import { computeCorrectionFactors as computeFactors } from '@agentic-ug/core';
import { queryOne, query } from '@agentic-ug/db';

import { todayBeijing, yesterdayBeijing } from './dates';

export { isFbSource } from '@agentic-ug/core';
export type { CorrectionFactor, FactorMap } from '@agentic-ug/core';

import type { FactorMap } from '@agentic-ug/core';

/** 计算某北京自然日 dataDate 的全产品修正系数（core 真源 + 本仓库的 pg 连接池）。 */
export async function computeCorrectionFactors(dataDate: string): Promise<FactorMap> {
  return computeFactors(dataDate, { query, queryOne });
}

interface CacheEntry {
  factors: FactorMap;
  computedOn: string;
}

const corrFactorCache = new Map<string, CacheEntry>();

/**
 * 缓存命中判定（复刻 getCachedCorrFactors）：
 *   历史日期（早于昨天）永久有效；昨天/今天仅当 computedOn===todayStr 有效；跨自然日失效。
 */
export function getCachedCorrFactors(
  dataDate: string,
  todayStr: string,
  yesterdayStr: string,
): FactorMap | undefined {
  const entry = corrFactorCache.get(dataDate);
  if (!entry) return undefined;
  if (dataDate < yesterdayStr) return entry.factors;
  if (entry.computedOn === todayStr) return entry.factors;
  return undefined;
}

/**
 * 只读某日持久化修正系数（daily_snapshots kind='correction'，由每日 job 写入、永久留存）。
 * **对外接口 /api/ext/correction-factors 只读此持久化，绝不现算**；缺失返回 null。
 */
export async function loadPersistedCorrectionFactors(dataDate: string): Promise<FactorMap | null> {
  const row = await queryOne<{ payload: FactorMap }>(
    "SELECT payload FROM daily_snapshots WHERE kind = 'correction' AND date = $1",
    [dataDate],
  );
  return row?.payload ?? null;
}

/** 取修正系数（内存缓存 → 每日持久化 → 现算兜底，并写回内存缓存）。 */
export async function getCorrectionFactors(dataDate: string): Promise<FactorMap> {
  const todayStr = todayBeijing();
  const yesterdayStr = yesterdayBeijing();
  const cached = getCachedCorrFactors(dataDate, todayStr, yesterdayStr);
  if (cached) return cached;
  // 持久化优先：每日 job 已把昨日及更早的修正系数算好写库（永久留存），直接读用不重复现算。
  const persisted = await loadPersistedCorrectionFactors(dataDate);
  if (persisted) {
    corrFactorCache.set(dataDate, { factors: persisted, computedOn: todayStr });
    return persisted;
  }
  const factors = await computeCorrectionFactors(dataDate);
  corrFactorCache.set(dataDate, { factors, computedOn: todayStr });
  return factors;
}
