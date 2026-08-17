/**
 * 渠道汇总（/api/channel-summary）—— 复刻旧 dashboard/server.js。
 * 按 FB/GG/TT 三渠道聚合 cost/revenue/installs/新用户收入/D7 收入，含每产品拆分与派生指标。
 * cost 只读 XMP 磁盘缓存（PG xmp_cache，不触发 live fetch，避免 QPM/内存压力）；
 * revenue/installs 直接扫 records_YYYYMM。channel-summary 不读写快照，与个人面板不同。
 * SQLite→PG：af 用北京日 UTC 串边界，ad 用 epoch bigint；julianday*24 → EXTRACT(EPOCH)/3600。
 */

import { query, queryOne } from '@agentic-ug/db';

import { beijingDayBounds, getDateRange, getTablesForRange, todayBeijing } from './dates';
import { AD_UID_EXPR, AF_UID_EXPR, buildDedupCountSql } from './dedup';
import { APP_ID_MAP, MEDIA_SOURCE_MAP } from './mapping';
import { loadXmpCacheRange, XMP_PWA_PRODUCT, type XmpDayCache } from './xmp';

type ChannelKey = 'FB' | 'GG' | 'TT';
const CHANNEL_KEYS: ChannelKey[] = ['FB', 'GG', 'TT'];

type MetricKey = 'cost' | 'revenue' | 'installs' | 'newUserRevenue' | 'd7Revenue';

interface RawBucket {
  cost: number;
  revenue: number;
  installs: number;
  newUserRevenue: number;
  d7Revenue: number;
}
interface RawChannel extends RawBucket {
  products: Map<string, RawBucket>;
}

interface ProductSummary {
  cost: number;
  revenue: number;
  installs: number;
  cpi: number | null;
  newUserRevenue: number;
  newUserRoas: number | null;
  d7Revenue: number;
  d7Roas: number | null;
}
interface ChannelSummary extends ProductSummary {
  products: Record<string, ProductSummary>;
}

export interface ChannelSummaryResponse {
  startDate: string;
  endDate: string;
  channels: Record<string, ChannelSummary>;
  d7Incomplete: string[];
  xmpMissingDates: string[];
}

function emptyBucket(): RawBucket {
  return { cost: 0, revenue: 0, installs: 0, newUserRevenue: 0, d7Revenue: 0 };
}

function isChannelKey(ch: string): ch is ChannelKey {
  return ch === 'FB' || ch === 'GG' || ch === 'TT';
}

/**
 * channel-summary 专用 media_source → 渠道映射（区别于通用 mapMediaSource）：
 * restricted / Unattributed 归 FB；organic 类排除；FB W2A 合并进 FB；含 w2a/web 归 FB；未知排除。
 */
function mapChannelForSummary(src: string | null): ChannelKey | null {
  if (!src) return null;
  if (src === 'restricted' || src === 'Unattributed') return 'FB';
  const mapped = MEDIA_SOURCE_MAP[src];
  if (mapped === 'Organic') return null;
  if (mapped !== undefined) {
    if (mapped === 'FB W2A') return 'FB';
    return isChannelKey(mapped) ? mapped : null;
  }
  const s = src.toLowerCase();
  if (s.includes('w2a') || s.includes('web')) return 'FB';
  return null;
}

/** app_id → 产品名（复刻 `APP_ID_MAP[app_id] || app_id`，null 落 'null' 键）。 */
function productName(appId: string | null): string {
  if (appId == null) return 'null';
  return APP_ID_MAP[appId] ?? appId;
}

function getProductBucket(ch: RawChannel, product: string): RawBucket {
  let b = ch.products.get(product);
  if (!b) {
    b = emptyBucket();
    ch.products.set(product, b);
  }
  return b;
}

interface GroupRow {
  media_source: string | null;
  app_id: string | null;
  val: number;
}

/** 把分组行按 channel-summary 映射累加到 channel + product 桶的某指标上。 */
function applyRows(
  channels: Record<ChannelKey, RawChannel>,
  rows: GroupRow[],
  metric: MetricKey,
): void {
  for (const row of rows) {
    const ch = mapChannelForSummary(row.media_source);
    if (ch == null) continue;
    const chBucket = channels[ch];
    chBucket[metric] += row.val;
    const pb = getProductBucket(chBucket, productName(row.app_id));
    pb[metric] += row.val;
  }
}

async function tableExists(tbl: string): Promise<boolean> {
  const row = await queryOne<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE tablename = $1',
    [tbl],
  );
  return row != null;
}

interface RangeBounds {
  rangeStart: string;
  rangeEnd: string;
  tsStart: number;
  tsEnd: number;
}

/** 某月表内的 8 次分组查询（af/ad × revenue/installs/新用户/D7），累加进 channels。 */
async function aggregateTable(
  tbl: string,
  channels: Record<ChannelKey, RawChannel>,
  b: RangeBounds,
): Promise<void> {
  const afRev = await query<GroupRow>(
    `SELECT media_source, app_id, COALESCE(SUM(revenue), 0)::float8 as val FROM ${tbl}
     WHERE event_name = 'af_purchase' AND event_time >= $1 AND event_time < $2
     GROUP BY media_source, app_id`,
    [b.rangeStart, b.rangeEnd],
  );
  applyRows(channels, afRev, 'revenue');

  const adRev = await query<GroupRow>(
    `SELECT media_source, app_id, COALESCE(SUM(revenue), 0)::float8 as val FROM ${tbl}
     WHERE event_name = 'ad_purchase' AND event_time::bigint >= $1 AND event_time::bigint < $2
     GROUP BY media_source, app_id`,
    [b.tsStart, b.tsEnd],
  );
  applyRows(channels, adRev, 'revenue');

  // AF/AD 安装数已移出本函数：注册数须按 user_id 在整个查询范围内（可能跨月表）全局去重，
  // 且 PARTITION BY 不含 media_source（同一 uid 跨 source 只算最早那次），故在循环后统一去重，见 dedupInstalls。

  const afNew = await query<GroupRow>(
    `SELECT media_source, app_id, COALESCE(SUM(revenue), 0)::float8 as val FROM ${tbl}
     WHERE event_name = 'af_purchase' AND install_time >= $1 AND install_time < $2
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 >= 0
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 < 24
     GROUP BY media_source, app_id`,
    [b.rangeStart, b.rangeEnd],
  );
  applyRows(channels, afNew, 'newUserRevenue');

  const adNew = await query<GroupRow>(
    `SELECT media_source, app_id, COALESCE(SUM(revenue), 0)::float8 as val FROM ${tbl}
     WHERE event_name = 'ad_purchase' AND install_time::bigint >= $1 AND install_time::bigint < $2
       AND event_time::bigint - install_time::bigint >= 0
       AND event_time::bigint - install_time::bigint < 86400
     GROUP BY media_source, app_id`,
    [b.tsStart, b.tsEnd],
  );
  applyRows(channels, adNew, 'newUserRevenue');

  const afD7 = await query<GroupRow>(
    `SELECT media_source, app_id, COALESCE(SUM(revenue), 0)::float8 as val FROM ${tbl}
     WHERE event_name = 'af_purchase' AND install_time >= $1 AND install_time < $2
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 >= 0
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 < 168
     GROUP BY media_source, app_id`,
    [b.rangeStart, b.rangeEnd],
  );
  applyRows(channels, afD7, 'd7Revenue');

  const adD7 = await query<GroupRow>(
    `SELECT media_source, app_id, COALESCE(SUM(revenue), 0)::float8 as val FROM ${tbl}
     WHERE event_name = 'ad_purchase' AND install_time::bigint >= $1 AND install_time::bigint < $2
       AND event_time::bigint - install_time::bigint >= 0
       AND event_time::bigint - install_time::bigint < 604800
     GROUP BY media_source, app_id`,
    [b.tsStart, b.tsEnd],
  );
  applyRows(channels, adD7, 'd7Revenue');
}

/**
 * AF & AD 安装数：跨月表 UNION ALL 后按 user_id 全局去重，再按 media_source+app_id 聚合到 installs。
 * 关键：PARTITION BY uid 不含 media_source——同一 user_id 若在两个 source 各注册一次，只算最早那次。
 */
async function dedupInstalls(
  existingTables: string[],
  channels: Record<ChannelKey, RawChannel>,
  b: RangeBounds,
): Promise<void> {
  if (existingTables.length === 0) return;

  const afParams: string[] = [];
  const afBranches = existingTables.map((t, i) => {
    const lo = afParams.push(b.rangeStart);
    const hi = afParams.push(b.rangeEnd);
    return `SELECT media_source, app_id, event_time, id AS _rid, ${i.toString()} AS _tbl, ${AF_UID_EXPR} AS uid
      FROM ${t}
      WHERE event_name = 'af_complete_registration' AND event_time >= $${lo.toString()} AND event_time < $${hi.toString()}`;
  });
  const afRows = await query<GroupRow>(
    buildDedupCountSql(
      'media_source, app_id',
      'val',
      'event_time, _tbl, _rid',
      afBranches.join(' UNION ALL '),
    ),
    afParams,
  );
  applyRows(channels, afRows, 'installs');

  const adParams: number[] = [];
  const adBranches = existingTables.map((t, i) => {
    const lo = adParams.push(b.tsStart);
    const hi = adParams.push(b.tsEnd);
    return `SELECT media_source, app_id, event_time, id AS _rid, ${i.toString()} AS _tbl, ${AD_UID_EXPR} AS uid
      FROM ${t}
      WHERE event_name = 'ad_complete_registration' AND event_time::bigint >= $${lo.toString()} AND event_time::bigint < $${hi.toString()}`;
  });
  const adRows = await query<GroupRow>(
    buildDedupCountSql(
      'media_source, app_id',
      'val',
      'event_time::bigint, _tbl, _rid',
      adBranches.join(' UNION ALL '),
    ),
    adParams,
  );
  applyRows(channels, adRows, 'installs');
}

/** 月表 records_YYYYMM 名（本地日历）。 */
function tableNameForDate(y: number, mZeroBased: number, d: number): string {
  const dt = new Date(y, mZeroBased, d);
  return `records_${dt.getFullYear().toString()}${(dt.getMonth() + 1).toString().padStart(2, '0')}`;
}

function deriveBucket(b: RawBucket): ProductSummary {
  return {
    cost: b.cost,
    revenue: b.revenue,
    installs: b.installs,
    cpi: b.installs > 0 ? b.cost / b.installs : null,
    newUserRevenue: b.newUserRevenue,
    newUserRoas: b.cost > 0 ? (b.newUserRevenue / b.cost) * 100 : null,
    d7Revenue: b.d7Revenue,
    d7Roas: b.cost > 0 ? (b.d7Revenue / b.cost) * 100 : null,
  };
}

/** XMP 范围缓存指纹：各日 fetchedAt 拼接（缺失记 0），XMP 重拉后自动失配旧范围缓存。 */
export function xmpRangeFingerprint(dates: string[], xmpMap: Map<string, XmpDayCache>): string {
  let fp = '';
  for (const d of dates) {
    const entry = xmpMap.get(d);
    fp += `${(entry ? entry.fetchedAt : 0).toString()},`;
  }
  return fp;
}

export interface ChannelSummaryInput {
  startDate: string;
  endDate: string;
  xmpMap: Map<string, XmpDayCache>;
}

/** 读某区间各北京日的 XMP 磁盘缓存（不触发 live fetch），供路由做 cost + 指纹。 */
export function loadChannelSummaryXmp(
  startDate: string,
  endDate: string,
): Promise<Map<string, XmpDayCache>> {
  return loadXmpCacheRange(getDateRange(startDate, endDate));
}

export async function computeChannelSummary(
  input: ChannelSummaryInput,
): Promise<ChannelSummaryResponse> {
  const { startDate, endDate, xmpMap } = input;
  const dates = getDateRange(startDate, endDate);

  const channels: Record<ChannelKey, RawChannel> = {
    FB: { ...emptyBucket(), products: new Map() },
    GG: { ...emptyBucket(), products: new Map() },
    TT: { ...emptyBucket(), products: new Map() },
  };

  // Phase 1：XMP 成本（仅磁盘缓存），并记录缺失日。
  const xmpMissingDates: string[] = [];
  for (const date of dates) {
    const entry = xmpMap.get(date);
    if (entry && entry.data.length > 0) {
      for (const row of entry.data) {
        if (!isChannelKey(row.channel)) continue;
        // PWA 行只供投手日报分摊，不进渠道/产品口径（渠道总计亦不含，避免与产品之和对不上）。
        if (row.product === XMP_PWA_PRODUCT) continue;
        const chBucket = channels[row.channel];
        chBucket.cost += row.cost;
        if (row.product) getProductBucket(chBucket, row.product).cost += row.cost;
      }
    } else {
      xmpMissingDates.push(date);
    }
  }

  // Phase 2：扫 records 表聚合 revenue/installs/新用户/D7。
  const startBounds = beijingDayBounds(startDate);
  const endBounds = beijingDayBounds(endDate);
  const bounds: RangeBounds = {
    rangeStart: startBounds.strLo,
    rangeEnd: endBounds.strHi,
    tsStart: startBounds.epLo,
    tsEnd: endBounds.epHi,
  };

  const [ey, em, ed] = endDate.split('-').map(Number) as [number, number, number];
  const endNextTable = tableNameForDate(ey, em - 1, ed + 8); // D7 窗口可溢出到下月
  const allTables = [...new Set([...getTablesForRange(startDate, endDate), endNextTable])];
  const existingTables: string[] = [];
  for (const tbl of allTables) {
    if (!(await tableExists(tbl))) continue;
    existingTables.push(tbl);
    await aggregateTable(tbl, channels, bounds);
  }
  await dedupInstalls(existingTables, channels, bounds);

  // Phase 3：派生指标 + 每产品拆分。
  const result: Record<string, ChannelSummary> = {};
  for (const ch of CHANNEL_KEYS) {
    const data = channels[ch];
    const products: Record<string, ProductSummary> = {};
    for (const [prod, pb] of data.products) products[prod] = deriveBucket(pb);
    result[ch] = { ...deriveBucket(data), products };
  }

  // Phase 4：D7 完整性——窗口末尾超出今天的安装日标记为不完整。
  const todayStr = todayBeijing();
  const d7Incomplete: string[] = [];
  for (const date of dates) {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const d7End = new Date(y, m - 1, d + 7);
    const d7EndStr = `${d7End.getFullYear().toString()}-${(d7End.getMonth() + 1).toString().padStart(2, '0')}-${d7End.getDate().toString().padStart(2, '0')}`;
    if (d7EndStr > todayStr) d7Incomplete.push(date);
  }

  return { startDate, endDate, channels: result, d7Incomplete, xmpMissingDates };
}
