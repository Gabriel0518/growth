/**
 * 多日范围聚合结果的进程内 TTL 缓存 —— 复刻旧 server.js 的 _rangeResultCache。
 * 仅内存，重启即清（回填/重建快照后从干净数据重新计算，符合预期）。
 * 单副本部署下与旧版逐字对齐；多副本各自持有独立缓存（可接受：TTL 短）。
 */

import { todayBeijing } from './dates';

const TTL_LIVE = 60 * 1000; // 含当天（活数据）
const TTL_HIST = 6 * 3600 * 1000; // 已结算历史区间

interface Entry {
  value: unknown;
  fp: string;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

/** 区间 TTL：含当天用短 TTL，纯历史用长 TTL。 */
export function rangeCacheTtl(endDate: string): number {
  return endDate < todayBeijing() ? TTL_HIST : TTL_LIVE;
}

/** 命中且未过期且指纹一致才返回，否则 undefined。 */
export function getRangeCache(key: string, fp: string): unknown {
  const e = cache.get(key);
  if (e && e.expiresAt > Date.now() && e.fp === fp) return e.value;
  return undefined;
}

/** 写入并按插入序驱逐最旧项，上限 300 条。 */
export function setRangeCache(key: string, value: unknown, fp: string, ttl: number): void {
  cache.set(key, { value, fp, expiresAt: Date.now() + ttl });
  if (cache.size > 300) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}
