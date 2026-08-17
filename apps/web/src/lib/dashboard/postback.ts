/**
 * Postback 汇总（/api/postback/data、/api/postback/dates）—— 复刻旧 dashboard/server.js。
 * 按 app_id×media_source 聚合 af/ad 收入与笔数，归并到产品→渠道结构。
 * SQLite→PG：date(event_time,'+8h')=D → event_time ∈ 北京日 UTC 边界 [strLo,strHi)；
 *   ad 的 unixepoch event_time 用 epoch 边界（文本 10 位字典序==数值）。
 */

import { query, queryOne } from '@agentic-ug/db';

import { beijingDayBounds, getDateRange, tableForMonth } from './dates';
import { APP_ID_MAP, EXCLUDED_APP_IDS, mapMediaSource } from './mapping';

interface ChannelAgg {
  channel: string;
  count: number;
  revenue: number;
}

interface ProductAgg {
  product: string;
  count: number;
  revenue: number;
  channels: ChannelAgg[];
}

interface Section {
  products: ProductAgg[];
  totals: { count: number; revenue: number };
}

export interface PostbackData {
  date: string;
  af: Section;
  ad: Section;
}

interface AggRow {
  app_id: string | null;
  media_source: string | null;
  count: number;
  revenue: number;
}

/** 把 (app_id×media_source) 聚合行归并为 产品→渠道 结构（同一渠道重复出现时后者覆盖，复刻原语义）。 */
function buildSection(rows: AggRow[]): Section {
  interface ProductBuild {
    product: string;
    count: number;
    revenue: number;
    channels: Map<string, ChannelAgg>;
  }
  const productMap = new Map<string, ProductBuild>();
  let totalCount = 0;
  let totalRevenue = 0;

  for (const row of rows) {
    const appId = row.app_id ?? '';
    if (EXCLUDED_APP_IDS.has(appId)) continue;
    const productName = APP_ID_MAP[appId] ?? appId;
    const channelName = mapMediaSource(row.media_source ?? '');

    let pm = productMap.get(productName);
    if (!pm) {
      pm = { product: productName, count: 0, revenue: 0, channels: new Map() };
      productMap.set(productName, pm);
    }
    pm.count += row.count;
    pm.revenue += row.revenue;
    pm.channels.set(channelName, { channel: channelName, count: row.count, revenue: row.revenue });
    totalCount += row.count;
    totalRevenue += row.revenue;
  }

  const products = [...productMap.values()]
    .map((p) => ({
      product: p.product,
      count: p.count,
      revenue: p.revenue,
      channels: [...p.channels.values()].sort((a, b) => b.revenue - a.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return { products, totals: { count: totalCount, revenue: totalRevenue } };
}

function emptySection(): Section {
  return { products: [], totals: { count: 0, revenue: 0 } };
}

const AGG_SELECT =
  'app_id, media_source, COUNT(*)::int as count, COALESCE(SUM(revenue), 0)::float8 as revenue';

/** 单个北京自然日的 (app_id×media_source) 聚合行（月表不存在时返回 null）。 */
async function loadDayAggRows(date: string): Promise<{ af: AggRow[]; ad: AggRow[] } | null> {
  const tableName = tableForMonth(date);
  const exists = await queryOne<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE tablename = $1',
    [tableName],
  );
  if (!exists) return null;

  const { strLo, strHi, epLo, epHi } = beijingDayBounds(date);
  const af = await query<AggRow>(
    `SELECT ${AGG_SELECT}
     FROM ${tableName}
     WHERE event_name = 'af_purchase' AND event_time >= $1 AND event_time < $2
     GROUP BY app_id, media_source
     ORDER BY SUM(revenue) DESC`,
    [strLo, strHi],
  );
  const ad = await query<AggRow>(
    `SELECT ${AGG_SELECT}
     FROM ${tableName}
     WHERE event_name = 'ad_purchase' AND event_time >= $1 AND event_time < $2
     GROUP BY app_id, media_source
     ORDER BY SUM(revenue) DESC`,
    [epLo.toString(), epHi.toString()],
  );
  return { af, ad };
}

/** 把多天的聚合行按 (app_id,media_source) 合并求和，供跨日区间复用单日 buildSection 语义。 */
function accumulate(target: Map<string, AggRow>, rows: AggRow[]): void {
  for (const row of rows) {
    const key = `${row.app_id ?? ''}\u0000${row.media_source ?? ''}`;
    const existing = target.get(key);
    if (existing) {
      existing.count += row.count;
      existing.revenue += row.revenue;
    } else {
      target.set(key, {
        app_id: row.app_id,
        media_source: row.media_source,
        count: row.count,
        revenue: row.revenue,
      });
    }
  }
}

/** 某北京自然日的 postback 汇总（月表不存在时返回空壳）。 */
export async function loadPostbackData(date: string): Promise<PostbackData> {
  const rows = await loadDayAggRows(date);
  if (!rows) return { date, af: emptySection(), ad: emptySection() };
  return { date, af: buildSection(rows.af), ad: buildSection(rows.ad) };
}

/** startDate..endDate（含两端）的 postback 汇总；start===end 时等价单日。 */
export async function loadPostbackRange(startDate: string, endDate: string): Promise<PostbackData> {
  const afMap = new Map<string, AggRow>();
  const adMap = new Map<string, AggRow>();
  for (const day of getDateRange(startDate, endDate)) {
    const rows = await loadDayAggRows(day);
    if (!rows) continue;
    accumulate(afMap, rows.af);
    accumulate(adMap, rows.ad);
  }
  return {
    date: endDate,
    af: buildSection([...afMap.values()]),
    ad: buildSection([...adMap.values()]),
  };
}

/** 所有月表里 af_purchase 出现过的北京日期（倒序）。 */
export async function listPostbackDates(): Promise<string[]> {
  const tableRows = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename LIKE 'records_%' ORDER BY tablename`,
  );
  const dates: string[] = [];
  for (const { tablename } of tableRows) {
    const dayRows = await query<{ dt: string | null }>(
      `SELECT DISTINCT ((event_time::timestamp + interval '8 hours')::date)::text as dt
       FROM ${tablename} WHERE event_name = 'af_purchase' ORDER BY dt DESC`,
    );
    for (const r of dayRows) {
      if (r.dt) dates.push(r.dt);
    }
  }
  dates.sort();
  dates.reverse();
  return dates;
}
