/**
 * 素材（creative）与 AIGC 的 N 日窗口聚合 —— 复刻旧 server.js 的 aggregateCreativeDays / aggregateAigcDays。
 * 读 daily_snapshots(kind='creative'|'aigc')，按 FB/TT 双渠道、product::name 键累加成本/曝光/点击/新用户收入。
 * 窗口恒为「昨天往前 N 天」的完整历史日；creative 用范围缓存（指纹=各日 fetchedAt），aigc 每次重算（对齐旧版）。
 */

import { loadAigcRange, loadCreativeRange, type CreativeDayCache } from './creative-snapshots';
import { getDateRange, todayBeijing } from './dates';
import { getRangeCache, rangeCacheTtl, setRangeCache } from './range-cache';

export const CREATIVE_ALLOWED_WINDOWS = [3, 7, 14];

interface CreativeAgg {
  name: string;
  product: string;
  designer: string;
  series: string;
  number: string;
  date: string;
  channel: string;
  cost: number;
  impressions: number;
  clicks: number;
  newUserRevenue: number;
}

interface AigcAgg {
  name: string;
  product: string;
  channel: string;
  cost: number;
  impressions: number;
  clicks: number;
  newUserRevenue: number;
}

export interface CreativeResponse {
  days: number;
  dates: string[];
  missingDates: string[];
  dateRange: string;
  fb: CreativeAgg[];
  tt: CreativeAgg[];
}

export interface AigcResponse {
  days: number;
  dates: string[];
  missingDates: string[];
  dateRange: string;
  fb: AigcAgg[];
  tt: AigcAgg[];
}

/** YYYY-MM-DD 偏移 deltaDays 天（UTC 午夜基准，与系统时区无关）。 */
function shiftDate(dateStr: string, deltaDays: number): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 「昨天往前 N 天」的完整历史日窗口 [today-days, …, today-1]。 */
function windowDates(days: number): string[] {
  const today = todayBeijing();
  return getDateRange(shiftDate(today, -days), shiftDate(today, -1));
}

/** 各日 fetchedAt 拼接（缺失记 0）：快照重写后自动失配旧窗口缓存（复刻旧 mtime 指纹）。 */
function windowFingerprint(dates: string[], map: Map<string, CreativeDayCache<unknown>>): string {
  let fp = '';
  for (const d of dates) {
    const entry = map.get(d);
    fp += `${(entry ? entry.fetchedAt : 0).toString()},`;
  }
  return fp;
}

function channelMap<T>(
  fb: Map<string, T>,
  tt: Map<string, T>,
  channel: string,
): Map<string, T> | null {
  if (channel === 'FB') return fb;
  if (channel === 'TT') return tt;
  return null;
}

/** creative N 日窗口聚合（带范围缓存）。 */
export async function computeCreative(days: number): Promise<CreativeResponse> {
  const dates = windowDates(days);
  const dayCache = await loadCreativeRange(dates);
  const fp = windowFingerprint(dates, dayCache);
  const cacheKey = `creative|${days.toString()}|${dates[0] ?? ''}`;

  const cached = getRangeCache(cacheKey, fp);
  if (cached !== undefined) return cached as CreativeResponse;

  const fbMap = new Map<string, CreativeAgg>();
  const ttMap = new Map<string, CreativeAgg>();
  for (const dateStr of dates) {
    const day = dayCache.get(dateStr);
    if (!day) continue;
    for (const c of day.creatives) {
      const map = channelMap(fbMap, ttMap, c.channel);
      if (!map) continue;
      const name = c.name ?? c.key ?? '';
      const product = c.product ?? '';
      const mapKey = `${product}::${name}`;
      let agg = map.get(mapKey);
      if (!agg) {
        agg = {
          name,
          product,
          designer: c.designer ?? '',
          series: c.series ?? '',
          number: c.number ?? '',
          date: c.date ?? '',
          channel: c.channel,
          cost: 0,
          impressions: 0,
          clicks: 0,
          newUserRevenue: 0,
        };
        map.set(mapKey, agg);
      }
      if (!agg.product && product) agg.product = product;
      agg.cost += c.cost ?? 0;
      agg.impressions += c.impressions ?? 0;
      agg.clicks += c.clicks ?? 0;
      agg.newUserRevenue += c.newUserRevenue ?? 0;
    }
  }

  const missingDates = dates.filter((d) => !dayCache.has(d));
  const response: CreativeResponse = {
    days,
    dates,
    missingDates,
    dateRange: `${dates[0] ?? ''} ~ ${dates.at(-1) ?? ''}`,
    fb: [...fbMap.values()],
    tt: [...ttMap.values()],
  };
  setRangeCache(cacheKey, response, fp, rangeCacheTtl(dates.at(-1) ?? todayBeijing()));
  return response;
}

/** aigc N 日窗口聚合（每次重算，对齐旧版无缓存）。 */
export async function computeAigc(days: number): Promise<AigcResponse> {
  const dates = windowDates(days);
  const dayCache = await loadAigcRange(dates);

  const fbMap = new Map<string, AigcAgg>();
  const ttMap = new Map<string, AigcAgg>();
  for (const dateStr of dates) {
    const day = dayCache.get(dateStr);
    if (!day) continue;
    for (const c of day.creatives) {
      const map = channelMap(fbMap, ttMap, c.channel);
      if (!map) continue;
      const product = c.product ?? '';
      const mapKey = `${product}::${c.name}`;
      let agg = map.get(mapKey);
      if (!agg) {
        agg = {
          name: c.name,
          product,
          channel: c.channel,
          cost: 0,
          impressions: 0,
          clicks: 0,
          newUserRevenue: 0,
        };
        map.set(mapKey, agg);
      }
      if (!agg.product && product) agg.product = product;
      agg.cost += c.cost ?? 0;
      agg.impressions += c.impressions ?? 0;
      agg.clicks += c.clicks ?? 0;
      agg.newUserRevenue += c.newUserRevenue ?? 0;
    }
  }

  const missingDates = dates.filter((d) => !dayCache.has(d));
  return {
    days,
    dates,
    missingDates,
    dateRange: `${dates[0] ?? ''} ~ ${dates.at(-1) ?? ''}`,
    fb: [...fbMap.values()],
    tt: [...ttMap.values()],
  };
}

/** days 参数解析：仅允许 3/7/14，否则回退 3（复刻旧 CREATIVE_ALLOWED_WINDOWS 校验）。 */
export function parseDaysParam(raw: string | null): number {
  const n = Number.parseInt(raw ?? '', 10);
  return CREATIVE_ALLOWED_WINDOWS.includes(n) ? n : 3;
}
