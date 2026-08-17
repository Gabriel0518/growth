/**
 * 按安装日的修正收入曲线（/api/revenue-by-install）—— 复刻旧 dashboard/server.js。
 * 固定查询「某北京日」的 af/ad 付费购买事件，按各行的安装北京日分桶，乘以修正系数。
 * 早于坐标轴窗口的安装日收入并入 earlierRevenue。修正系数与个人面板同源（fresh compute）。
 * SQLite→PG：event_time UTC 串用北京日边界；ad 的 unixepoch 用 CAST bigint 范围。
 */

import { query, queryOne } from '@agentic-ug/db';

import { computeCorrectionFactors } from './correction-factors';
import type { FactorMap } from './correction-factors';
import { beijingDayBounds, getTablesForRange, todayBeijing, yesterdayBeijing } from './dates';
import { APP_ID_MAP, mapMediaSource } from './mapping';
import { AD_ORGANIC_SOURCES, matchOperator } from './operators';

export type RevByInstallLevel = 'campaign' | 'channel' | 'product' | 'operator';

export interface RevByInstallInput {
  level: RevByInstallLevel;
  date: string;
  days: number;
  campaign: string;
  channel: string;
  product: string;
  operator: string;
}

export interface RevByInstallResponse {
  level: RevByInstallLevel;
  date: string;
  days: number;
  startDate: string;
  campaign?: string;
  product?: string;
  channel?: string;
  operator?: string;
  series: { date: string; revenue: number }[];
  earlierRevenue: number;
}

const AF_PAID = ['Facebook Ads', 'googleadwords_int', 'tiktokglobal_int'];

interface EventRow {
  campaign: string | null;
  app_id: string | null;
  media_source: string | null;
  revenue: number | null;
  install_time: string | null;
}

/** af install_time（UTC 串）→ 北京安装日 YYYY-MM-DD。 */
function afInstallDay(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(`${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(t.getTime())) return null;
  return new Date(t.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** ad install_time（unix 秒串）→ 北京安装日 YYYY-MM-DD。 */
function adInstallDay(ts: string | null): string | null {
  if (ts == null) return null;
  const n = Number.parseInt(ts, 10);
  if (Number.isNaN(n)) return null;
  return new Date((n + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** 修正系数取值：Android 单值；iOS FB/FB W2A 用 fb，其余 other。 */
function corrFactorFor(factors: FactorMap, product: string | undefined, channel: string): number {
  const f = product === undefined ? undefined : factors[product];
  if (f == null) return 1;
  if (typeof f === 'number') return f;
  if (channel === 'FB' || channel === 'FB W2A') return f.fb || 1;
  return f.other || 1;
}

export async function computeRevenueByInstall(
  input: RevByInstallInput,
): Promise<RevByInstallResponse> {
  const { level, date, days, campaign: reqCampaign, channel: reqChannel } = input;
  const { product: reqProduct, operator: reqOperator } = input;

  // 北京日坐标轴 startDate..date（含两端）
  const [dy, dm, dd] = date.split('-').map(Number) as [number, number, number];
  const startMs = Date.UTC(dy, dm - 1, dd) - days * 86_400_000;
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const axis: string[] = [];
  for (let i = 0; i <= days; i++) {
    axis.push(new Date(startMs + i * 86_400_000).toISOString().slice(0, 10));
  }
  const axis0 = axis[0] ?? startDate;

  // 查询日（北京 0-24h）的 UTC 边界
  const { strLo: afEvLow, strHi: afEvHigh, epLo: adEvLow, epHi: adEvHigh } = beijingDayBounds(date);

  // 产品 → app_ids（operator 层跨所有产品，不加 app_id 过滤）
  let appIds: string[] | null = null;
  if (level !== 'operator') {
    appIds = Object.entries(APP_ID_MAP)
      .filter(([, n]) => n === reqProduct)
      .map(([id]) => id);
    if (appIds.length === 0) {
      return {
        level,
        date,
        days,
        startDate,
        series: axis.map((d) => ({ date: d, revenue: 0 })),
        earlierRevenue: 0,
      };
    }
  }

  const byDay = new Map<string, number>();
  for (const d of axis) byDay.set(d, 0);
  let earlierRevenue = 0;

  const corrDataDate = date >= todayBeijing() ? yesterdayBeijing() : date;
  const corrFactors = await computeCorrectionFactors(corrDataDate);

  const addRevenue = (day: string | null, rev: number): void => {
    if (day == null) return;
    if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + rev);
    else if (day < axis0) earlierRevenue += rev;
  };

  const evLowDateUtc = new Date(Date.parse(`${date}T00:00:00+08:00`)).toISOString().slice(0, 10);
  for (const tbl of getTablesForRange(evLowDateUtc, date)) {
    const exists = await queryOne<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE tablename = $1',
      [tbl],
    );
    if (!exists) continue;

    // AF 付费：查询日内的 af_purchase
    const afAppFilter = appIds
      ? `AND app_id IN (${appIds.map((_, i) => `$${(i + 6).toString()}`).join(',')})`
      : '';
    const afRows = await query<EventRow>(
      `SELECT campaign, app_id, media_source, revenue, install_time
       FROM ${tbl}
       WHERE event_name = 'af_purchase'
         AND event_time >= $1 AND event_time < $2
         AND media_source IN ($3, $4, $5)
         ${afAppFilter}`,
      appIds ? [afEvLow, afEvHigh, ...AF_PAID, ...appIds] : [afEvLow, afEvHigh, ...AF_PAID],
    );
    for (const row of afRows) {
      const product = row.app_id === null ? undefined : APP_ID_MAP[row.app_id];
      const channel = mapMediaSource(row.media_source ?? '');
      const campaign = (row.campaign ?? '').trim();
      if (level === 'campaign' && (channel !== reqChannel || campaign !== reqCampaign)) continue;
      if (level === 'channel' && channel !== reqChannel) continue;
      if (level === 'operator' && (matchOperator(campaign) ?? 'other') !== reqOperator) continue;
      const rev = (row.revenue ?? 0) * corrFactorFor(corrFactors, product, channel);
      addRevenue(afInstallDay(row.install_time), rev);
    }

    // AD 付费：查询日内的 ad_purchase（unix 秒 event_time）
    const adAppFilter = appIds
      ? `AND app_id IN (${appIds.map((_, i) => `$${(i + 3).toString()}`).join(',')})`
      : '';
    const adRows = await query<EventRow>(
      `SELECT campaign, app_id, media_source, revenue, install_time
       FROM ${tbl}
       WHERE event_name = 'ad_purchase'
         AND event_time::bigint >= $1 AND event_time::bigint < $2
         ${adAppFilter}`,
      appIds ? [adEvLow, adEvHigh, ...appIds] : [adEvLow, adEvHigh],
    );
    for (const row of adRows) {
      if (row.media_source !== null && AD_ORGANIC_SOURCES.has(row.media_source)) continue;
      const product = row.app_id === null ? undefined : APP_ID_MAP[row.app_id];
      const channel = mapMediaSource(row.media_source ?? '');
      let campaign = row.campaign ?? '';
      try {
        campaign = decodeURIComponent(campaign.replaceAll('+', ' '));
      } catch {
        /* keep raw on malformed encoding */
      }
      campaign = campaign.replace(/\s*\(.*?\)\s*$/, '').trim();
      if (level === 'campaign' && (channel !== reqChannel || campaign !== reqCampaign)) continue;
      if (level === 'channel' && channel !== reqChannel) continue;
      if (level === 'operator' && (matchOperator(campaign) ?? 'other') !== reqOperator) continue;
      const rev = (row.revenue ?? 0) * corrFactorFor(corrFactors, product, channel);
      addRevenue(adInstallDay(row.install_time), rev);
    }
  }

  const series = axis.map((d) => ({ date: d, revenue: round2(byDay.get(d) ?? 0) }));
  return {
    level,
    date,
    days,
    startDate,
    ...(reqCampaign ? { campaign: reqCampaign } : {}),
    ...(reqProduct ? { product: reqProduct } : {}),
    ...(reqChannel ? { channel: reqChannel } : {}),
    ...(reqOperator ? { operator: reqOperator } : {}),
    series,
    earlierRevenue: round2(earlierRevenue),
  };
}
