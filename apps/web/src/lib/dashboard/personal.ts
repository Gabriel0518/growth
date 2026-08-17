/**
 * 个人面板（/api/postback/personal）—— 复刻旧 dashboard/server.js 的日报核心。
 * 层级 operator→product→channel→campaign→adset→ad，9 指标含修正收入。
 * 单日：全量 DB 查询 + XMP 成本注入 + 快照读写（complete/partial + 跨日新用户补丁）。
 * 多日：逐日快照聚合（历史用快照、当天走 live 查询），按日修正系数折算 corrected*。
 * SQLite→PG：payload JSON 提取在 JS 侧完成；af 时间用北京日 UTC 串边界，ad 用 epoch bigint。
 */

import { query, queryOne } from '@agentic-ug/db';

import { computeCorrectionFactors } from './correction-factors';
import type { FactorMap } from './correction-factors';
import {
  beijingDayBounds,
  daysBefore,
  getDateRange,
  nowBeijingHour,
  tableForMonth,
  todayBeijing,
  yesterdayBeijing,
} from './dates';
import { AD_UID_EXPR, AF_UID_EXPR, buildDedupCountSql } from './dedup';
import { APP_ID_MAP, mapMediaSource } from './mapping';
import { matchOperator, normAdset, AD_ORGANIC_SOURCES, PARTNERSHIP_OPERATOR } from './operators';
import {
  loadPersonalSnapshot,
  savePersonalSnapshot,
  type PersonalResponse,
  type PersonalChannel,
  type PersonalCampaign,
  type PersonalAdset,
  type PersonalAd,
  type PersonalSummary,
  type PersonalSnapshot,
} from './personal-snapshots';
import { fetchXmpCampaigns, XMP_PWA_PRODUCT } from './xmp';
import type { XmpRow } from './xmp';

const AF_PAID = ['Facebook Ads', 'googleadwords_int', 'tiktokglobal_int'];

interface PurchaseRow {
  campaign: string | null;
  app_id: string | null;
  media_source: string | null;
  revenue: number | null;
  event_time: string | null;
  install_time: string | null;
  payload: string | null;
}

interface ExtraRow extends PurchaseRow {
  afAdset?: string;
  afAd?: string;
  afCampaignId?: string;
  afAdsetId?: string;
  adAdgroup?: string;
  adCreative?: string;
  adCampaignId?: string;
  adAdsetId?: string;
}

// ── 可变构建节点（单日全量路径）──
// deductedRevenue = 总收入的加权折扣版（AF：S2S×0.87，其余 SDK 按产品/平台官方费率 安卓×0.75、iOS×0.70、Mora iOS/Ruby And×0.85；AD 按 payment_channel WAFFO×0.87/ONERWAY×0.92/其余按产品取官方支付费率，默认×0.7、Mora iOS×0.85、Ruby And×0.85），与总收入平行。
interface MAd {
  ad: string;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
}
interface MAdset {
  adset: string;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  cost: number;
  impressions: number;
  clicks: number;
  adsetIds: Set<string>;
  ads: Map<string, MAd>;
}
interface MCampaign {
  campaign: string;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  cost: number;
  impressions: number;
  clicks: number;
  installs: number;
  campaignIds: Set<string>;
  adsets: Map<string, MAdset>;
}
interface MChannel {
  channel: string;
  count: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  cost: number;
  impressions: number;
  clicks: number;
  campaigns: Map<string, MCampaign>;
}
interface MProduct {
  product: string;
  count: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  cost: number;
  channels: Map<string, MChannel>;
}
interface MOperator {
  operator: string;
  count: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  cost: number;
  products: Map<string, MProduct>;
}

const round2 = (x: number): number => Number(x.toFixed(2));
const pad2 = (n: number): string => n.toString().padStart(2, '0');

/** payload JSON 串取键值（缺失/非法均返回 null，对齐 json_extract 的宽松语义）。 */
function jsonField(payload: string | null, key: string): string | null {
  if (!payload) return null;
  try {
    const o = JSON.parse(payload) as Record<string, unknown>;
    const v = o[key];
    if (v == null) return null;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return null;
  } catch {
    return null;
  }
}

/**
 * 官方支付（Apple Pay / Google Play 等非三方渠道，含 payment_channel 缺失/未知的兜底）
 * 按产品的实收比例。默认 0.7（费率 30% 保守取小）；Mora iOS、Ruby And 走官方实际费率 15% → 0.85。
 * 仅用于 AD 侧的官方支付/缺失兜底（本次未改动）。
 */
const APPLE_PAY_RATE_BY_PRODUCT: Record<string, number> = {
  'Mora iOS': 0.85,
  'Ruby And': 0.85, // Ruby 官方支付（非三方）费率 15%
};
const APPLE_PAY_RATE_DEFAULT = 0.7;

/** AF 侧按官方实际费率 15% → ×0.85 的产品（不分平台，按产品名精确列出）。 */
const AF_RATE_15PCT_PRODUCTS: ReadonlySet<string> = new Set(['Mora iOS', 'Ruby And']);

/**
 * 产品名无平台后缀、但需显式指定平台的覆盖表。
 * 后缀（iOS/And）源自 app_id→产品映射，绝大多数产品名自带后缀即可判定；仅少数无后缀产品
 * （app_id 为反向域名包名、无法靠数字 App Store ID 认出 iOS）需在此钉死：
 *   Doni（com.doni.appa）= 安卓；GraceChat / Luma 为数字 App Store ID，走下方 iOS 兜底，无需列。
 */
const ANDROID_PRODUCT_OVERRIDE: ReadonlySet<string> = new Set(['Doni']);

/**
 * 产品是否安卓。判定优先级（等价于「按 app_id 精确判定」，因产品名后缀本就由 app_id 映射得来）：
 *   1) 产品名含 " iOS" → iOS；含 " And" → 安卓（后缀权威，Dora iOS 用包名 app_id 也照样判 iOS）。
 *   2) 无后缀：数字 / id+数字的 App Store ID → iOS。
 *   3) 仍无法判定：查 ANDROID_PRODUCT_OVERRIDE，命中判安卓，其余兜底 iOS（= 抽 30%）。
 */
function isAndroidProduct(appId: string | null, product: string): boolean {
  if (product.includes('iOS')) return false;
  if (product.includes('And')) return true;
  if (/^(id)?\d+$/.test(appId ?? '')) return false; // App Store 数字 ID → iOS
  return ANDROID_PRODUCT_OVERRIDE.has(product);
}

/**
 * AF 侧「非 S2S」（SDK/缺失/异常）单条付费的实收比例（官方支付费率，按产品/平台分档）：
 *   Mora iOS、Ruby And 抽 15% → ×0.85；安卓产品抽 25% → ×0.75；iOS 产品及无法判定兜底抽 30% → ×0.70。
 * 平台判定见 isAndroidProduct（按 app_id 精确判定）。S2S 在 deductedOf 里先行命中 ×0.87，不进本函数。
 */
function afDeductRate(appId: string | null, product: string): number {
  if (AF_RATE_15PCT_PRODUCTS.has(product)) return 0.85;
  return isAndroidProduct(appId, product) ? 0.75 : 0.7;
}

/**
 * 单条付费事件的「扣费金额」：总收入 revenue 的加权折扣版。逐条先乘系数再累加。
 * AF（isAd=false）读 payload 的 event_source：S2S ×0.87（抽 13%，最高优先）；其余（SDK/缺失/异常）
 *   落 afDeductRate 按产品/平台官方费率（安卓 ×0.75、iOS ×0.70、Mora iOS/Ruby And ×0.85、兜底 ×0.70）。
 * AD（isAd=true）读 payload 的 payment_channel（由 tag-payment-channel 服务补写）分档：
 *   WAFFO ×0.87、ONERWAY ×0.92（抽 8%），其余（官方支付 Apple Pay/Google Play / 缺失 / 未知）按产品取
 *   APPLE_PAY_RATE_BY_PRODUCT（默认 ×0.7，Mora iOS ×0.85，Ruby And ×0.85）。
 * 扣费收入接入修正系数在下游（correctedDeductedRevenue = deductedRevenue * cf），此处只管原始折扣。
 */
function deductedOf(row: PurchaseRow, isAd: boolean, product: string): number {
  const rev = row.revenue ?? 0;
  if (isAd) {
    const ch = jsonField(row.payload, 'payment_channel');
    if (ch === 'WAFFO') return rev * 0.87;
    if (ch === 'ONERWAY') return rev * 0.92; // 抽 8%
    // Apple Pay / 缺失 / 其他 兜底
    return rev * (APPLE_PAY_RATE_BY_PRODUCT[product] ?? APPLE_PAY_RATE_DEFAULT);
  }
  // AF 侧：S2S 最高优先 ×0.87（抽 13%），SDK/缺失/异常再落分产品/平台官方费率。
  const es = jsonField(row.payload, 'event_source');
  if (es === 'S2S') return rev * 0.87;
  return rev * afDeductRate(row.app_id, product);
}

/** 空串/null → '(unknown)'。 */
function orUnknown(s: string | null): string {
  return s != null && s !== '' ? s : '(unknown)';
}

/** campaign 键（含末尾 trim，复刻 `(c||'(unknown)').trim()`）。 */
function campaignKey(raw: string | null): string {
  return (raw != null && raw !== '' ? raw : '(unknown)').trim();
}

/** 北京日「次日」字符串（纯本地日历加一，复刻旧写法）。 */
function nextDateStr(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const o = new Date(y, m - 1, d + 1);
  return `${o.getFullYear().toString()}-${pad2(o.getMonth() + 1)}-${pad2(o.getDate())}`;
}

/** af 行是否「目标北京日安装且 24h 内付费」的新用户。 */
function afIsNewUser(installIso: string | null, eventIso: string | null, date: string): boolean {
  if (!installIso || !eventIso) return false;
  const eventDate = new Date(`${eventIso.replace(' ', 'T')}Z`);
  const installDate = new Date(`${installIso.replace(' ', 'T')}Z`);
  if (Number.isNaN(installDate.getTime()) || Number.isNaN(eventDate.getTime())) return false;
  const installBeijingDay = new Date(installDate.getTime() + 8 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  const diffHours = (eventDate.getTime() - installDate.getTime()) / 3_600_000;
  return installBeijingDay === date && diffHours >= 0 && diffHours < 24;
}

/** ad 行是否新用户（epoch 秒串）。 */
function adIsNewUser(installTs: string | null, eventTs: string | null, date: string): boolean {
  if (installTs == null || eventTs == null) return false;
  const e = Number.parseInt(eventTs, 10);
  const i = Number.parseInt(installTs, 10);
  if (Number.isNaN(e) || Number.isNaN(i)) return false;
  const installBeijingDay = new Date((i + 8 * 3600) * 1000).toISOString().slice(0, 10);
  const diffHours = (e - i) / 3600;
  return installBeijingDay === date && diffHours >= 0 && diffHours < 24;
}

/** ad campaign 解码：urldecode（+→空格）后剥末尾 "(…)"，再 trim。 */
function decodeAdCampaign(raw: string | null): string {
  if (raw == null || raw === '') return '';
  let campaign: string;
  try {
    campaign = decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {
    campaign = raw; // keep raw on malformed encoding
  }
  return campaign.replace(/\s*\(.*?\)\s*$/, '').trim();
}

/** ad creative → ad 键（decode + 剥 "(…)"）；缺失 '(unknown)'。 */
function decodeAdCreative(cr: string | null): string {
  if (!cr) return '(unknown)';
  return decodeURIComponent(cr)
    .replace(/\s*\(.*?\)\s*$/, '')
    .trim();
}

/** AD 名称末尾 "(id)" 提取 FB id（纯数字）；无则返回 null。 */
function extractAdId(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw;
  try {
    s = decodeURIComponent(s.replaceAll('+', ' '));
  } catch {
    s = s.replaceAll('+', ' ');
  }
  const m = s.match(/\((\d+)\)\s*$/);
  return m?.[1] ?? null;
}

function productOf(appId: string | null): string {
  const id = appId == null || appId === '' ? '' : appId;
  return APP_ID_MAP[id] ?? id;
}

async function tableExists(tbl: string): Promise<boolean> {
  const row = await queryOne<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE tablename = $1',
    [tbl],
  );
  return row != null;
}

// ── ensure（get-or-create）辅助 ──
function ensureOp(map: Map<string, MOperator>, operator: string): MOperator {
  let op = map.get(operator);
  if (!op) {
    op = {
      operator,
      count: 0,
      revenue: 0,
      newUserRevenue: 0,
      deductedRevenue: 0,
      cost: 0,
      products: new Map(),
    };
    map.set(operator, op);
  }
  return op;
}
function ensureProd(op: MOperator, product: string): MProduct {
  let p = op.products.get(product);
  if (!p) {
    p = {
      product,
      count: 0,
      revenue: 0,
      newUserRevenue: 0,
      deductedRevenue: 0,
      cost: 0,
      channels: new Map(),
    };
    op.products.set(product, p);
  }
  return p;
}
function ensureCh(p: MProduct, channel: string): MChannel {
  let c = p.channels.get(channel);
  if (!c) {
    c = {
      channel,
      count: 0,
      revenue: 0,
      newUserRevenue: 0,
      deductedRevenue: 0,
      cost: 0,
      impressions: 0,
      clicks: 0,
      campaigns: new Map(),
    };
    p.channels.set(channel, c);
  }
  return c;
}
function ensureCamp(c: MChannel, campaign: string): MCampaign {
  let camp = c.campaigns.get(campaign);
  if (!camp) {
    camp = {
      campaign,
      revenue: 0,
      newUserRevenue: 0,
      deductedRevenue: 0,
      cost: 0,
      impressions: 0,
      clicks: 0,
      installs: 0,
      campaignIds: new Set(),
      adsets: new Map(),
    };
    c.campaigns.set(campaign, camp);
  }
  return camp;
}
function ensureAdset(camp: MCampaign, adset: string): MAdset {
  let a = camp.adsets.get(adset);
  if (!a) {
    a = {
      adset,
      revenue: 0,
      newUserRevenue: 0,
      deductedRevenue: 0,
      cost: 0,
      impressions: 0,
      clicks: 0,
      adsetIds: new Set(),
      ads: new Map(),
    };
    camp.adsets.set(adset, a);
  }
  return a;
}
function ensureAd(adset: MAdset, ad: string): MAd {
  let x = adset.ads.get(ad);
  if (!x) {
    x = { ad, revenue: 0, newUserRevenue: 0, deductedRevenue: 0 };
    adset.ads.set(ad, x);
  }
  return x;
}

// ── 单日全量查询 ──
interface SummaryRow {
  count: number;
  revenue: number;
  new_user_revenue: number;
  deducted: number;
}

const AF_ROW_COLS = 'campaign, app_id, media_source, revenue, event_time, install_time, payload';

async function queryAfPaid(tbl: string, strLo: string, strHi: string): Promise<ExtraRow[]> {
  const rows = await query<PurchaseRow>(
    `SELECT ${AF_ROW_COLS} FROM ${tbl}
     WHERE event_name = 'af_purchase' AND event_time >= $1 AND event_time < $2
       AND media_source IN ($3, $4, $5)`,
    [strLo, strHi, ...AF_PAID],
  );
  return rows.map((r) => attachAfPayload(r));
}

async function queryAfCrossDay(
  tbl: string,
  strLo: string,
  strHi: string,
  strLoN: string,
  strHiN: string,
): Promise<ExtraRow[]> {
  const rows = await query<PurchaseRow>(
    `SELECT ${AF_ROW_COLS} FROM ${tbl}
     WHERE event_name = 'af_purchase'
       AND install_time >= $1 AND install_time < $2
       AND event_time >= $3 AND event_time < $4
       AND media_source IN ($5, $6, $7)
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 >= 0
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 < 24`,
    [strLo, strHi, strLoN, strHiN, ...AF_PAID],
  );
  return rows.map((r) => attachAfPayload(r));
}

async function queryAdPaid(tbl: string, epLo: number, epHi: number): Promise<ExtraRow[]> {
  const rows = await query<PurchaseRow>(
    `SELECT ${AF_ROW_COLS} FROM ${tbl}
     WHERE event_name = 'ad_purchase' AND event_time::bigint >= $1 AND event_time::bigint < $2`,
    [epLo, epHi],
  );
  return rows.map((r) => attachAdPayload(r));
}

async function queryAdCrossDay(
  tbl: string,
  epLo: number,
  epHi: number,
  epLoN: number,
  epHiN: number,
): Promise<ExtraRow[]> {
  const rows = await query<PurchaseRow>(
    `SELECT ${AF_ROW_COLS} FROM ${tbl}
     WHERE event_name = 'ad_purchase'
       AND install_time::bigint >= $1 AND install_time::bigint < $2
       AND event_time::bigint >= $3 AND event_time::bigint < $4
       AND event_time::bigint - install_time::bigint >= 0
       AND event_time::bigint - install_time::bigint < 86400`,
    [epLo, epHi, epLoN, epHiN],
  );
  return rows.map((r) => attachAdPayload(r));
}

async function queryAfSummaryRow(
  tbl: string,
  source: string,
  strLo: string,
  strHi: string,
): Promise<SummaryRow> {
  // 扣费与 deductedOf 的 AF 侧一致：S2S ×0.87；其余按产品/平台官方费率。故 GROUP BY app_id 并拆出
  // S2S 收入，逐产品对「非 S2S 部分」套 afDeductRate、对「S2S 部分」套 ×0.87，再汇总。
  const rows = await query<{
    app_id: string | null;
    count: number;
    revenue: number;
    nur: number;
    s2s_revenue: number;
  }>(
    `SELECT app_id, COUNT(*)::int as count, COALESCE(SUM(revenue), 0)::float8 as revenue,
       COALESCE(SUM(CASE WHEN install_time >= $1 AND install_time < $2
         AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 >= 0
         AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 < 24
         THEN revenue ELSE 0 END), 0)::float8 as nur,
       COALESCE(SUM(CASE WHEN payload LIKE '%"event_source":"S2S"%' THEN revenue ELSE 0 END), 0)::float8 as s2s_revenue
     FROM ${tbl}
     WHERE event_name = 'af_purchase' AND event_time >= $3 AND event_time < $4 AND media_source = $5
     GROUP BY app_id`,
    [strLo, strHi, strLo, strHi, source],
  );
  const acc: SummaryRow = { count: 0, revenue: 0, new_user_revenue: 0, deducted: 0 };
  for (const r of rows) {
    acc.count += r.count;
    acc.revenue += r.revenue;
    acc.new_user_revenue += r.nur;
    const nonS2sRevenue = r.revenue - r.s2s_revenue;
    acc.deducted +=
      r.s2s_revenue * 0.87 + nonS2sRevenue * afDeductRate(r.app_id, productOf(r.app_id));
  }
  return acc;
}

async function queryAfSummaryExtra(
  tbl: string,
  source: string,
  strLo: string,
  strHi: string,
  strLoN: string,
  strHiN: string,
): Promise<number> {
  const row = await queryOne<{ extra: number }>(
    `SELECT COALESCE(SUM(revenue), 0)::float8 as extra FROM ${tbl}
     WHERE event_name = 'af_purchase'
       AND install_time >= $1 AND install_time < $2
       AND event_time >= $3 AND event_time < $4
       AND media_source = $5
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 >= 0
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 < 24`,
    [strLo, strHi, strLoN, strHiN, source],
  );
  return row?.extra ?? 0;
}

function attachAfPayload(row: PurchaseRow): ExtraRow {
  return {
    ...row,
    afAdset: jsonField(row.payload, 'af_adset') ?? '',
    afAd: jsonField(row.payload, 'af_ad') ?? '',
    afCampaignId: jsonField(row.payload, 'af_c_id') ?? '',
    afAdsetId: jsonField(row.payload, 'af_adset_id') ?? '',
  };
}
function attachAdPayload(row: PurchaseRow): ExtraRow {
  const adgroupRaw = jsonField(row.payload, 'adgroup') ?? '';
  return {
    ...row,
    adAdgroup: adgroupRaw,
    adCreative: jsonField(row.payload, 'creative') ?? '',
    adCampaignId: extractAdId(row.campaign) ?? '',
    adAdsetId: extractAdId(adgroupRaw) ?? '',
  };
}

// ── 单日：把 AF/AD 行灌入 operatorMap ──
function ingestAfPaid(
  operatorMap: Map<string, MOperator>,
  rows: ExtraRow[],
  date: string,
  afInstallMap: Map<string, number>,
): void {
  for (const row of rows) {
    const operator = matchOperator(row.campaign) ?? 'other';
    const product = productOf(row.app_id);
    const channel = mapMediaSource(row.media_source ?? '');
    const rev = row.revenue ?? 0;
    const ded = deductedOf(row, false, product); // AF 按 event_source 折扣
    const isNewUser = afIsNewUser(row.install_time, row.event_time, date);

    const op = ensureOp(operatorMap, operator);
    op.count += 1;
    op.revenue += rev;
    op.deductedRevenue += ded;
    if (isNewUser) op.newUserRevenue += rev;
    const p = ensureProd(op, product);
    p.count += 1;
    p.revenue += rev;
    p.deductedRevenue += ded;
    if (isNewUser) p.newUserRevenue += rev;
    const c = ensureCh(p, channel);
    c.count += 1;
    c.revenue += rev;
    c.deductedRevenue += ded;
    if (isNewUser) c.newUserRevenue += rev;
    const campKey = campaignKey(row.campaign);
    const camp = ensureCamp(c, campKey);
    camp.installs = afInstallMap.get(campKey) ?? 0;
    if (row.afCampaignId) camp.campaignIds.add(row.afCampaignId);
    camp.revenue += rev;
    camp.deductedRevenue += ded;
    if (isNewUser) camp.newUserRevenue += rev;
    const adset = ensureAdset(camp, orUnknown(normAdset(row.afAdset)));
    if (row.afAdsetId) adset.adsetIds.add(row.afAdsetId);
    adset.revenue += rev;
    adset.deductedRevenue += ded;
    if (isNewUser) adset.newUserRevenue += rev;
    const ad = ensureAd(adset, orUnknown(row.afAd ?? null));
    ad.revenue += rev;
    ad.deductedRevenue += ded;
    if (isNewUser) ad.newUserRevenue += rev;
  }
}

function ingestAfExtra(operatorMap: Map<string, MOperator>, rows: ExtraRow[]): void {
  for (const row of rows) {
    const operator = matchOperator(row.campaign) ?? 'other';
    const product = productOf(row.app_id);
    const channel = mapMediaSource(row.media_source ?? '');
    const rev = row.revenue ?? 0;
    const op = ensureOp(operatorMap, operator);
    op.newUserRevenue += rev;
    const p = ensureProd(op, product);
    p.newUserRevenue += rev;
    const c = ensureCh(p, channel);
    c.newUserRevenue += rev;
    const camp = ensureCamp(c, campaignKey(row.campaign));
    if (row.afCampaignId) camp.campaignIds.add(row.afCampaignId);
    camp.newUserRevenue += rev;
    const adset = ensureAdset(camp, orUnknown(normAdset(row.afAdset)));
    if (row.afAdsetId) adset.adsetIds.add(row.afAdsetId);
    adset.newUserRevenue += rev;
    const ad = ensureAd(adset, orUnknown(row.afAd ?? null));
    ad.newUserRevenue += rev;
  }
}

interface AdOrganicAcc {
  count: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
}

function ingestAdPaid(
  operatorMap: Map<string, MOperator>,
  rows: ExtraRow[],
  date: string,
  adInstallMap: Map<string, number>,
  adOrganic: AdOrganicAcc,
): void {
  for (const row of rows) {
    const mediaSource = row.media_source ?? '';
    const rev = row.revenue ?? 0;
    // product 提前解析：自然量分支也要按产品取 Apple Pay 费率。
    const product = productOf(row.app_id);
    const ded = deductedOf(row, true, product); // AD 按 payment_channel 分档折扣
    const campaign = decodeAdCampaign(row.campaign);
    const isNewUser = adIsNewUser(row.install_time, row.event_time, date);
    if (AD_ORGANIC_SOURCES.has(mediaSource)) {
      adOrganic.count += 1;
      adOrganic.revenue += rev;
      adOrganic.deductedRevenue += ded;
      if (isNewUser) adOrganic.newUserRevenue += rev;
      continue;
    }
    const operator = matchOperator(campaign) ?? 'other';
    const channel = mapMediaSource(mediaSource);
    const op = ensureOp(operatorMap, operator);
    op.count += 1;
    op.revenue += rev;
    op.deductedRevenue += ded;
    if (isNewUser) op.newUserRevenue += rev;
    const p = ensureProd(op, product);
    p.count += 1;
    p.revenue += rev;
    p.deductedRevenue += ded;
    if (isNewUser) p.newUserRevenue += rev;
    const c = ensureCh(p, channel);
    c.count += 1;
    c.revenue += rev;
    c.deductedRevenue += ded;
    if (isNewUser) c.newUserRevenue += rev;
    const campKey = orUnknown(campaign === '' ? null : campaign);
    const camp = ensureCamp(c, campKey);
    camp.installs = adInstallMap.get(campKey) ?? 0;
    if (row.adCampaignId) camp.campaignIds.add(row.adCampaignId);
    camp.revenue += rev;
    camp.deductedRevenue += ded;
    if (isNewUser) camp.newUserRevenue += rev;
    const adset = ensureAdset(camp, orUnknown(normAdset(row.adAdgroup)));
    if (row.adAdsetId) adset.adsetIds.add(row.adAdsetId);
    adset.revenue += rev;
    adset.deductedRevenue += ded;
    if (isNewUser) adset.newUserRevenue += rev;
    const ad = ensureAd(adset, decodeAdCreative(row.adCreative ?? null));
    ad.revenue += rev;
    ad.deductedRevenue += ded;
    if (isNewUser) ad.newUserRevenue += rev;
  }
}

function ingestAdExtra(
  operatorMap: Map<string, MOperator>,
  rows: ExtraRow[],
  adOrganic: AdOrganicAcc,
): void {
  for (const row of rows) {
    const mediaSource = row.media_source ?? '';
    const rev = row.revenue ?? 0;
    const campaign = decodeAdCampaign(row.campaign);
    if (AD_ORGANIC_SOURCES.has(mediaSource)) {
      adOrganic.newUserRevenue += rev;
      continue;
    }
    const operator = matchOperator(campaign) ?? 'other';
    const product = productOf(row.app_id);
    const channel = mapMediaSource(mediaSource);
    const op = ensureOp(operatorMap, operator);
    op.newUserRevenue += rev;
    const p = ensureProd(op, product);
    p.newUserRevenue += rev;
    const c = ensureCh(p, channel);
    c.newUserRevenue += rev;
    const camp = ensureCamp(c, orUnknown(campaign === '' ? null : campaign));
    if (row.adCampaignId) camp.campaignIds.add(row.adCampaignId);
    camp.newUserRevenue += rev;
  }
}

/** XMP 成本注入 operatorMap（含 adset join）。 */
function ingestXmp(operatorMap: Map<string, MOperator>, xmpRows: XmpRow[]): void {
  for (const xmpRow of xmpRows) {
    // PWA 行只供投手日报按 DAU 分摊，不计入个人面板任何一层（投手总成本亦不含）。
    if (xmpRow.product === XMP_PWA_PRODUCT) continue;
    const operator = matchOperator(xmpRow.campaign) ?? 'other';
    const op = ensureOp(operatorMap, operator);
    op.cost += xmpRow.cost;
    const p = ensureProd(op, xmpRow.product);
    p.cost += xmpRow.cost;
    const c = ensureCh(p, xmpRow.channel);
    c.cost += xmpRow.cost;
    c.impressions += xmpRow.impressions;
    c.clicks += xmpRow.clicks;
    const campKey = campaignKey(xmpRow.campaign);
    const camp = ensureCamp(c, campKey);
    camp.cost += xmpRow.cost;
    camp.impressions += xmpRow.impressions;
    camp.clicks += xmpRow.clicks;
    // adset join：normAdset(adset) 命中已有 DB 节点 → 注入其上，否则落 campaign 的 '(unknown)'。
    const normKey = normAdset(xmpRow.adset);
    const adsetKey = normKey !== '' && camp.adsets.has(normKey) ? normKey : '(unknown)';
    const adset = ensureAdset(camp, adsetKey);
    adset.cost += xmpRow.cost;
    adset.impressions += xmpRow.impressions;
    adset.clicks += xmpRow.clicks;
  }
}

// ── 单日 operatorMap → 排序输出 ──
function buildChannelOutput(c: MChannel): PersonalChannel {
  const camps = [...c.campaigns.values()];
  const totalImp = camps.reduce((s, camp) => s + camp.impressions, 0);
  const totalClk = camps.reduce((s, camp) => s + camp.clicks, 0);
  const totalCost = c.cost;
  const campaigns: PersonalCampaign[] = camps
    .map((camp): PersonalCampaign => {
      const adsets: PersonalAdset[] = [...camp.adsets.values()]
        .map((adset): PersonalAdset => {
          const ads: PersonalAd[] = [...adset.ads.values()].sort((a, b) => b.revenue - a.revenue);
          return {
            adset: adset.adset,
            revenue: adset.revenue,
            newUserRevenue: adset.newUserRevenue,
            deductedRevenue: adset.deductedRevenue,
            cost: adset.cost,
            impressions: adset.impressions,
            clicks: adset.clicks,
            adsetIds: [...adset.adsetIds],
            ads,
          };
        })
        .sort((a, b) => b.revenue - a.revenue);
      return {
        campaign: camp.campaign,
        revenue: camp.revenue,
        newUserRevenue: camp.newUserRevenue,
        deductedRevenue: camp.deductedRevenue,
        cost: camp.cost,
        impressions: camp.impressions,
        clicks: camp.clicks,
        installs: camp.installs,
        campaignIds: [...camp.campaignIds],
        adsets,
      };
    })
    .sort((a, b) => b.cost + b.revenue - (a.cost + a.revenue));
  return {
    channel: c.channel,
    count: c.count,
    revenue: c.revenue,
    newUserRevenue: c.newUserRevenue,
    deductedRevenue: c.deductedRevenue,
    cost: totalCost,
    cpm: totalImp > 0 ? round2((totalCost / totalImp) * 1000) : null,
    cpc: totalClk > 0 ? round2(totalCost / totalClk) : null,
    campaigns,
  };
}

function buildOperators(operatorMap: Map<string, MOperator>): PersonalResponse['operators'] {
  return [...operatorMap.values()]
    .map((op) => ({
      operator: op.operator,
      count: op.count,
      cost: op.cost,
      revenue: op.revenue,
      newUserRevenue: op.newUserRevenue,
      deductedRevenue: op.deductedRevenue,
      products: [...op.products.values()]
        .map((p) => ({
          product: p.product,
          count: p.count,
          cost: p.cost,
          revenue: p.revenue,
          newUserRevenue: p.newUserRevenue,
          deductedRevenue: p.deductedRevenue,
          channels: [...p.channels.values()]
            .map((c) => buildChannelOutput(c))
            .sort((a, b) => b.revenue - a.revenue),
        }))
        .sort((a, b) => b.revenue - a.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

/** 全 3 渠道(FB/GG/TT)均有成本且合计>100 才算「可信成本」，用于是否落完整快照。 */
function responseHasReasonableCost(data: PersonalResponse): boolean {
  const channelCost = new Map<string, number>();
  for (const op of data.operators) {
    for (const prod of op.products) {
      for (const ch of prod.channels) {
        channelCost.set(ch.channel, (channelCost.get(ch.channel) ?? 0) + ch.cost);
      }
    }
  }
  let total = 0;
  for (const v of channelCost.values()) total += v;
  if (total <= 100) return false;
  return ['FB', 'GG', 'TT'].every((ch) => (channelCost.get(ch) ?? 0) > 0);
}

interface SingleDayFull {
  response: PersonalResponse;
  afExtra: ExtraRow[];
  adExtra: ExtraRow[];
  organicExtra: number;
  restrictedExtra: number;
}

/** 单日全量：查询 + 构建 + XMP，返回响应与跨日增量（供快照落盘扣减）。 */
async function computeSingleDayFull(date: string, forceFreshXmp: boolean): Promise<SingleDayFull> {
  const tableName = tableForMonth(date);
  const dB = beijingDayBounds(date);
  const nextStr = nextDateStr(date);
  const nextTableName = tableForMonth(nextStr);
  const dBn = beijingDayBounds(nextStr);
  const nextExists = nextTableName !== tableName && (await tableExists(nextTableName));

  const paidRows = await queryAfPaid(tableName, dB.strLo, dB.strHi);

  const afExtra: ExtraRow[] = await queryAfCrossDay(
    tableName,
    dB.strLo,
    dB.strHi,
    dBn.strLo,
    dBn.strHi,
  );
  if (nextExists) {
    afExtra.push(
      ...(await queryAfCrossDay(nextTableName, dB.strLo, dB.strHi, dBn.strLo, dBn.strHi)),
    );
  }

  const afInstallRows = await query<{ campaign: string | null; installs: number }>(
    buildDedupCountSql(
      'campaign',
      'installs',
      'event_time, _tbl, _rid',
      `SELECT campaign, event_time, id AS _rid, 0 AS _tbl, ${AF_UID_EXPR} AS uid FROM ${tableName}
       WHERE event_name = 'af_complete_registration' AND event_time >= $1 AND event_time < $2
         AND media_source IN ($3, $4, $5)`,
    ),
    [dB.strLo, dB.strHi, ...AF_PAID],
  );
  const afInstallMap = new Map<string, number>();
  for (const r of afInstallRows) afInstallMap.set(campaignKey(r.campaign), r.installs);

  const adInstallRows = await query<{ campaign: string | null; installs: number }>(
    buildDedupCountSql(
      'campaign',
      'installs',
      'event_time::bigint, _tbl, _rid',
      `SELECT campaign, event_time, id AS _rid, 0 AS _tbl, ${AD_UID_EXPR} AS uid FROM ${tableName}
       WHERE event_name = 'ad_complete_registration' AND event_time::bigint >= $1 AND event_time::bigint < $2`,
    ),
    [dB.epLo, dB.epHi],
  );
  const adInstallMap = new Map<string, number>();
  for (const r of adInstallRows) {
    const camp = orUnknown(decodeAdCampaign(r.campaign) || null);
    adInstallMap.set(camp, (adInstallMap.get(camp) ?? 0) + r.installs);
  }

  const organicRow = await queryAfSummaryRow(tableName, 'organic', dB.strLo, dB.strHi);
  const organicExtra = await queryAfSummaryExtra(
    tableName,
    'organic',
    dB.strLo,
    dB.strHi,
    dBn.strLo,
    dBn.strHi,
  );
  const restrictedRow = await queryAfSummaryRow(tableName, 'restricted', dB.strLo, dB.strHi);
  const restrictedExtra = await queryAfSummaryExtra(
    tableName,
    'restricted',
    dB.strLo,
    dB.strHi,
    dBn.strLo,
    dBn.strHi,
  );

  const adPaidRows = await queryAdPaid(tableName, dB.epLo, dB.epHi);
  const adExtra: ExtraRow[] = await queryAdCrossDay(
    tableName,
    dB.epLo,
    dB.epHi,
    dBn.epLo,
    dBn.epHi,
  );
  if (nextExists) {
    adExtra.push(...(await queryAdCrossDay(nextTableName, dB.epLo, dB.epHi, dBn.epLo, dBn.epHi)));
  }

  const operatorMap = new Map<string, MOperator>();
  const adOrganic: AdOrganicAcc = { count: 0, revenue: 0, newUserRevenue: 0, deductedRevenue: 0 };
  ingestAfPaid(operatorMap, paidRows, date, afInstallMap);
  ingestAfExtra(operatorMap, afExtra);
  ingestAdPaid(operatorMap, adPaidRows, date, adInstallMap, adOrganic);
  ingestAdExtra(operatorMap, adExtra, adOrganic);

  let xmpCampaigns: XmpRow[] = [];
  try {
    xmpCampaigns = await fetchXmpCampaigns(date, { staleOk: !forceFreshXmp, needAdset: true });
  } catch (error) {
    console.error('[API] XMP fetch failed for personal panel:', (error as Error).message);
  }
  ingestXmp(operatorMap, xmpCampaigns);

  const response: PersonalResponse = {
    date,
    operators: buildOperators(operatorMap),
    organic: {
      count: organicRow.count + adOrganic.count,
      revenue: organicRow.revenue + adOrganic.revenue,
      newUserRevenue: organicRow.new_user_revenue + organicExtra + adOrganic.newUserRevenue,
      deductedRevenue: organicRow.deducted + adOrganic.deductedRevenue,
    },
    restricted: {
      count: restrictedRow.count,
      revenue: restrictedRow.revenue,
      newUserRevenue: restrictedRow.new_user_revenue + restrictedExtra,
      deductedRevenue: restrictedRow.deducted,
    },
  };

  return { response, afExtra, adExtra, organicExtra, restrictedExtra };
}

/** partial 快照落盘：从含跨日增量的响应里扣掉跨日新用户，得到 base（不含跨日）。 */
function buildPartialBase(full: SingleDayFull): PersonalResponse {
  const base: PersonalResponse = structuredClone(full.response);
  const findOp = (operator: string): PersonalResponse['operators'][number] | undefined =>
    base.operators.find((o) => o.operator === operator);

  for (const row of full.afExtra) {
    const operator = matchOperator(row.campaign) ?? 'other';
    const product = productOf(row.app_id);
    const channel = mapMediaSource(row.media_source ?? '');
    const rev = row.revenue ?? 0;
    const op = findOp(operator);
    if (!op) continue;
    op.newUserRevenue -= rev;
    const prod = op.products.find((p) => p.product === product);
    if (!prod) continue;
    prod.newUserRevenue -= rev;
    const ch = prod.channels.find((c) => c.channel === channel);
    if (!ch) continue;
    ch.newUserRevenue -= rev;
    const camp = ch.campaigns.find((c) => c.campaign === campaignKey(row.campaign));
    if (camp) camp.newUserRevenue -= rev;
  }
  for (const row of full.adExtra) {
    const mediaSource = row.media_source ?? '';
    if (AD_ORGANIC_SOURCES.has(mediaSource)) continue;
    const rev = row.revenue ?? 0;
    const campaign = decodeAdCampaign(row.campaign);
    const operator = matchOperator(campaign) ?? 'other';
    const product = productOf(row.app_id);
    const channel = mapMediaSource(mediaSource);
    const op = findOp(operator);
    if (!op) continue;
    op.newUserRevenue -= rev;
    const prod = op.products.find((p) => p.product === product);
    if (!prod) continue;
    prod.newUserRevenue -= rev;
    const ch = prod.channels.find((c) => c.channel === channel);
    if (!ch) continue;
    ch.newUserRevenue -= rev;
    const camp = ch.campaigns.find(
      (c) => c.campaign === orUnknown(campaign === '' ? null : campaign),
    );
    if (camp) camp.newUserRevenue -= rev;
  }
  if (full.organicExtra) base.organic.newUserRevenue -= full.organicExtra;
  if (full.restrictedExtra && base.restricted)
    base.restricted.newUserRevenue -= full.restrictedExtra;
  return base;
}

// ── 跨日新用户补丁（partial → complete）──
interface CrossDayPatch {
  afExtraRows: ExtraRow[];
  adExtraRows: ExtraRow[];
  organicExtra: number;
  restrictedExtra: number;
}

async function patchCrossDayNewUsers(dateStr: string): Promise<CrossDayPatch | null> {
  try {
    const tableName = tableForMonth(dateStr);
    const nextStr = nextDateStr(dateStr);
    const nextTableName = tableForMonth(nextStr);
    const dB = beijingDayBounds(dateStr);
    const dBn = beijingDayBounds(nextStr);
    const hasMain = await tableExists(tableName);
    const hasNext = nextTableName !== tableName && (await tableExists(nextTableName));

    const afExtraRows: ExtraRow[] = [];
    if (hasMain) {
      afExtraRows.push(
        ...(await queryAfCrossDay(tableName, dB.strLo, dB.strHi, dBn.strLo, dBn.strHi)),
      );
    }
    if (hasNext) {
      afExtraRows.push(
        ...(await queryAfCrossDay(nextTableName, dB.strLo, dB.strHi, dBn.strLo, dBn.strHi)),
      );
    }

    const adExtraRows: ExtraRow[] = [];
    if (hasMain) {
      adExtraRows.push(...(await queryAdCrossDay(tableName, dB.epLo, dB.epHi, dBn.epLo, dBn.epHi)));
    }
    if (hasNext) {
      adExtraRows.push(
        ...(await queryAdCrossDay(nextTableName, dB.epLo, dB.epHi, dBn.epLo, dBn.epHi)),
      );
    }

    let organicExtra = 0;
    let restrictedExtra = 0;
    if (hasMain) {
      organicExtra = await queryAfSummaryExtra(
        tableName,
        'organic',
        dB.strLo,
        dB.strHi,
        dBn.strLo,
        dBn.strHi,
      );
      restrictedExtra = await queryAfSummaryExtra(
        tableName,
        'restricted',
        dB.strLo,
        dB.strHi,
        dBn.strLo,
        dBn.strHi,
      );
    }
    return { afExtraRows, adExtraRows, organicExtra, restrictedExtra };
  } catch (error) {
    console.error('[Snapshot] Cross-day patch query error:', (error as Error).message);
    return null;
  }
}

function applyCrossDayPatch(snapshot: PersonalResponse, patch: CrossDayPatch): void {
  for (const row of patch.afExtraRows) {
    const operator = matchOperator(row.campaign) ?? 'other';
    const product = productOf(row.app_id);
    const channel = mapMediaSource(row.media_source ?? '');
    const rev = row.revenue ?? 0;
    const op = snapshot.operators.find((o) => o.operator === operator);
    if (!op) continue;
    op.newUserRevenue += rev;
    const prod = op.products.find((p) => p.product === product);
    if (!prod) continue;
    prod.newUserRevenue += rev;
    const ch = prod.channels.find((c) => c.channel === channel);
    if (!ch) continue;
    ch.newUserRevenue += rev;
    const camp = ch.campaigns.find((c) => c.campaign === campaignKey(row.campaign));
    if (!camp) continue;
    camp.newUserRevenue += rev;
    const adset = camp.adsets.find((a) => a.adset === orUnknown(normAdset(row.afAdset)));
    if (!adset) continue;
    adset.newUserRevenue += rev;
    const ad = adset.ads.find((a) => a.ad === orUnknown(row.afAd ?? null));
    if (ad) ad.newUserRevenue += rev;
  }
  for (const row of patch.adExtraRows) {
    const mediaSource = row.media_source ?? '';
    if (AD_ORGANIC_SOURCES.has(mediaSource)) continue;
    const rev = row.revenue ?? 0;
    const campaign = decodeAdCampaign(row.campaign);
    const operator = matchOperator(campaign) ?? 'other';
    const product = productOf(row.app_id);
    const channel = mapMediaSource(mediaSource);
    const op = snapshot.operators.find((o) => o.operator === operator);
    if (!op) continue;
    op.newUserRevenue += rev;
    const prod = op.products.find((p) => p.product === product);
    if (!prod) continue;
    prod.newUserRevenue += rev;
    const ch = prod.channels.find((c) => c.channel === channel);
    if (!ch) continue;
    ch.newUserRevenue += rev;
    const camp = ch.campaigns.find(
      (c) => c.campaign === orUnknown(campaign === '' ? null : campaign),
    );
    if (camp) camp.newUserRevenue += rev;
  }
  if (patch.organicExtra) snapshot.organic.newUserRevenue += patch.organicExtra;
  if (patch.restrictedExtra && snapshot.restricted)
    snapshot.restricted.newUserRevenue += patch.restrictedExtra;
}

// ── 多日 live 单日（简化：无 campaign/adset，供聚合当天用）──
async function getPersonalDataLive(date: string): Promise<PersonalResponse | null> {
  try {
    const tableName = tableForMonth(date);
    if (!(await tableExists(tableName))) {
      return {
        date,
        operators: [],
        organic: { count: 0, revenue: 0, newUserRevenue: 0 },
        restricted: { count: 0, revenue: 0, newUserRevenue: 0 },
      };
    }
    const nextStr = nextDateStr(date);
    const nextTableName = tableForMonth(nextStr);
    const dB = beijingDayBounds(date);
    const dBn = beijingDayBounds(nextStr);
    const nextExists = nextTableName !== tableName && (await tableExists(nextTableName));

    const paidRows = await queryAfPaid(tableName, dB.strLo, dB.strHi);
    const afExtra: ExtraRow[] = await queryAfCrossDay(
      tableName,
      dB.strLo,
      dB.strHi,
      dBn.strLo,
      dBn.strHi,
    );
    if (nextExists) {
      afExtra.push(
        ...(await queryAfCrossDay(nextTableName, dB.strLo, dB.strHi, dBn.strLo, dBn.strHi)),
      );
    }
    const organicRow = await queryAfSummaryRow(tableName, 'organic', dB.strLo, dB.strHi);
    const organicExtra = await queryAfSummaryExtra(
      tableName,
      'organic',
      dB.strLo,
      dB.strHi,
      dBn.strLo,
      dBn.strHi,
    );
    const restrictedRow = await queryAfSummaryRow(tableName, 'restricted', dB.strLo, dB.strHi);
    const restrictedExtra = await queryAfSummaryExtra(
      tableName,
      'restricted',
      dB.strLo,
      dB.strHi,
      dBn.strLo,
      dBn.strHi,
    );
    const adPaidRows = await queryAdPaid(tableName, dB.epLo, dB.epHi);
    const adExtra: ExtraRow[] = await queryAdCrossDay(
      tableName,
      dB.epLo,
      dB.epHi,
      dBn.epLo,
      dBn.epHi,
    );
    if (nextExists) {
      adExtra.push(...(await queryAdCrossDay(nextTableName, dB.epLo, dB.epHi, dBn.epLo, dBn.epHi)));
    }

    const operatorMap = new Map<string, MOperator>();
    const adOrganic: AdOrganicAcc = {
      count: 0,
      revenue: 0,
      newUserRevenue: 0,
      deductedRevenue: 0,
    };
    const emptyInstall = new Map<string, number>();
    ingestAfPaid(operatorMap, paidRows, date, emptyInstall);
    ingestAfExtra(operatorMap, afExtra);
    ingestAdPaid(operatorMap, adPaidRows, date, emptyInstall, adOrganic);
    ingestAdExtra(operatorMap, adExtra, adOrganic);

    let xmpCampaigns: XmpRow[] = [];
    try {
      xmpCampaigns = await fetchXmpCampaigns(date, { staleOk: true });
    } catch {
      /* XMP 失败则成本为 0 */
    }
    ingestXmp(operatorMap, xmpCampaigns);

    // live 输出：仅 operator→product→channel（无 campaign），channel 不含 cpm/cpc（聚合不用）。
    const operators = [...operatorMap.values()]
      .map((op) => ({
        operator: op.operator,
        count: op.count,
        cost: op.cost,
        revenue: op.revenue,
        newUserRevenue: op.newUserRevenue,
        deductedRevenue: op.deductedRevenue,
        products: [...op.products.values()]
          .map((p) => ({
            product: p.product,
            count: p.count,
            cost: p.cost,
            revenue: p.revenue,
            newUserRevenue: p.newUserRevenue,
            deductedRevenue: p.deductedRevenue,
            channels: [...p.channels.values()]
              .map((c): PersonalChannel => ({
                channel: c.channel,
                count: c.count,
                revenue: c.revenue,
                newUserRevenue: c.newUserRevenue,
                deductedRevenue: c.deductedRevenue,
                cost: c.cost,
                cpm: null,
                cpc: null,
                campaigns: [],
              }))
              .sort((a, b) => b.revenue - a.revenue),
          }))
          .sort((a, b) => b.revenue - a.revenue),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    return {
      date,
      operators,
      organic: {
        count: organicRow.count + adOrganic.count,
        revenue: organicRow.revenue + adOrganic.revenue,
        newUserRevenue: organicRow.new_user_revenue + organicExtra + adOrganic.newUserRevenue,
        deductedRevenue: organicRow.deducted + adOrganic.deductedRevenue,
      },
      restricted: {
        count: restrictedRow.count,
        revenue: restrictedRow.revenue,
        newUserRevenue: restrictedRow.new_user_revenue + restrictedExtra,
        deductedRevenue: restrictedRow.deducted,
      },
    };
  } catch (error) {
    console.error('[getPersonalDataLive] Error:', (error as Error).message);
    return null;
  }
}

// ── 多日聚合 ──
interface AggAd {
  ad: string;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  correctedRevenue: number;
  correctedNewUserRevenue: number;
  correctedDeductedRevenue: number;
}
interface AggAdset {
  adset: string;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  correctedRevenue: number;
  correctedNewUserRevenue: number;
  correctedDeductedRevenue: number;
  cost: number;
  impressions: number;
  clicks: number;
  adsetIds: Set<string>;
  ads: Map<string, AggAd>;
}
interface AggCampaign {
  campaign: string;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  correctedRevenue: number;
  correctedNewUserRevenue: number;
  correctedDeductedRevenue: number;
  cost: number;
  impressions: number;
  clicks: number;
  installs: number;
  campaignIds: Set<string>;
  adsets: Map<string, AggAdset>;
}
interface AggChannel {
  channel: string;
  count: number;
  cost: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  correctedRevenue: number;
  correctedNewUserRevenue: number;
  correctedDeductedRevenue: number;
  impressions: number;
  clicks: number;
  campaigns: Map<string, AggCampaign>;
}
interface AggProduct {
  product: string;
  count: number;
  cost: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  correctedRevenue: number;
  correctedNewUserRevenue: number;
  correctedDeductedRevenue: number;
  channels: Map<string, AggChannel>;
}
interface AggOperator {
  operator: string;
  count: number;
  cost: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  correctedRevenue: number;
  correctedNewUserRevenue: number;
  correctedDeductedRevenue: number;
  products: Map<string, AggProduct>;
}
interface AggSummary {
  count: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue: number;
  correctedRevenue: number;
  correctedNewUserRevenue: number;
  correctedDeductedRevenue: number;
}

function corrFactorFor(factors: FactorMap, product: string, channel: string): number {
  const f = factors[product];
  if (f == null) return 1;
  if (typeof f === 'number') return f;
  if (channel === 'FB' || channel === 'FB W2A') return f.fb || 1;
  return f.other || 1;
}

function mergeSummary(agg: AggSummary, day: PersonalSummary | undefined): void {
  if (!day) return;
  agg.count += day.count;
  agg.revenue += day.revenue;
  agg.newUserRevenue += day.newUserRevenue;
  agg.deductedRevenue += day.deductedRevenue ?? 0; // 老快照无此字段 → 0 兜底
  agg.correctedRevenue += day.revenue;
  agg.correctedNewUserRevenue += day.newUserRevenue;
  agg.correctedDeductedRevenue += day.deductedRevenue ?? 0; // organic/restricted 不乘系数，与 correctedRevenue 对齐
}

function mergePersonalDay(
  operatorAgg: Map<string, AggOperator>,
  organicAgg: AggSummary,
  restrictedAgg: AggSummary,
  dayData: PersonalResponse | null,
  factors: FactorMap,
): void {
  if (!dayData) return;
  mergeSummary(organicAgg, dayData.organic);
  mergeSummary(restrictedAgg, dayData.restricted);

  for (const op of dayData.operators) {
    let aggOp = operatorAgg.get(op.operator);
    if (!aggOp) {
      aggOp = {
        operator: op.operator,
        count: 0,
        cost: 0,
        revenue: 0,
        newUserRevenue: 0,
        deductedRevenue: 0,
        correctedRevenue: 0,
        correctedNewUserRevenue: 0,
        correctedDeductedRevenue: 0,
        products: new Map(),
      };
      operatorAgg.set(op.operator, aggOp);
    }
    aggOp.count += op.count;
    aggOp.cost += op.cost;
    aggOp.revenue += op.revenue;
    aggOp.newUserRevenue += op.newUserRevenue;
    aggOp.deductedRevenue += op.deductedRevenue ?? 0;

    for (const prod of op.products) {
      let aggProd = aggOp.products.get(prod.product);
      if (!aggProd) {
        aggProd = {
          product: prod.product,
          count: 0,
          cost: 0,
          revenue: 0,
          newUserRevenue: 0,
          deductedRevenue: 0,
          correctedRevenue: 0,
          correctedNewUserRevenue: 0,
          correctedDeductedRevenue: 0,
          channels: new Map(),
        };
        aggOp.products.set(prod.product, aggProd);
      }
      aggProd.count += prod.count;
      aggProd.cost += prod.cost;
      aggProd.revenue += prod.revenue;
      aggProd.newUserRevenue += prod.newUserRevenue;
      aggProd.deductedRevenue += prod.deductedRevenue ?? 0;

      for (const ch of prod.channels) {
        let aggCh = aggProd.channels.get(ch.channel);
        if (!aggCh) {
          aggCh = {
            channel: ch.channel,
            count: 0,
            cost: 0,
            revenue: 0,
            newUserRevenue: 0,
            deductedRevenue: 0,
            correctedRevenue: 0,
            correctedNewUserRevenue: 0,
            correctedDeductedRevenue: 0,
            impressions: 0,
            clicks: 0,
            campaigns: new Map(),
          };
          aggProd.channels.set(ch.channel, aggCh);
        }
        aggCh.count += ch.count;
        aggCh.cost += ch.cost;
        aggCh.revenue += ch.revenue;
        aggCh.newUserRevenue += ch.newUserRevenue;
        aggCh.deductedRevenue += ch.deductedRevenue ?? 0;
        // 合创(partnership)：修正系数按真实产品 + 渠道默认 FB 口径取（业务要求）。
        // 后端结构对 partnership 仍是正常的 产品→渠道，故 prod.product 即真实产品。
        const cf =
          op.operator === PARTNERSHIP_OPERATOR
            ? corrFactorFor(factors, prod.product, 'FB')
            : corrFactorFor(factors, prod.product, ch.channel);
        aggCh.correctedRevenue += ch.revenue * cf;
        aggCh.correctedNewUserRevenue += ch.newUserRevenue * cf;
        aggCh.correctedDeductedRevenue += (ch.deductedRevenue ?? 0) * cf;

        for (const camp of ch.campaigns) {
          const campName = camp.campaign.trim();
          let aggCamp = aggCh.campaigns.get(campName);
          if (!aggCamp) {
            aggCamp = {
              campaign: campName,
              revenue: 0,
              newUserRevenue: 0,
              deductedRevenue: 0,
              correctedRevenue: 0,
              correctedNewUserRevenue: 0,
              correctedDeductedRevenue: 0,
              cost: 0,
              impressions: 0,
              clicks: 0,
              installs: 0,
              campaignIds: new Set(),
              adsets: new Map(),
            };
            aggCh.campaigns.set(campName, aggCamp);
          }
          aggCamp.revenue += camp.revenue;
          aggCamp.newUserRevenue += camp.newUserRevenue;
          aggCamp.deductedRevenue += camp.deductedRevenue ?? 0;
          aggCamp.correctedRevenue += camp.revenue * cf;
          aggCamp.correctedNewUserRevenue += camp.newUserRevenue * cf;
          aggCamp.correctedDeductedRevenue += (camp.deductedRevenue ?? 0) * cf;
          aggCamp.cost += camp.cost;
          aggCamp.impressions += camp.impressions;
          aggCamp.clicks += camp.clicks;
          aggCamp.installs += camp.installs;
          for (const cid of camp.campaignIds ?? []) aggCamp.campaignIds.add(cid);

          for (const adset of camp.adsets) {
            let aggAdset = aggCamp.adsets.get(adset.adset);
            if (!aggAdset) {
              aggAdset = {
                adset: adset.adset,
                revenue: 0,
                newUserRevenue: 0,
                deductedRevenue: 0,
                correctedRevenue: 0,
                correctedNewUserRevenue: 0,
                correctedDeductedRevenue: 0,
                cost: 0,
                impressions: 0,
                clicks: 0,
                adsetIds: new Set(),
                ads: new Map(),
              };
              aggCamp.adsets.set(adset.adset, aggAdset);
            }
            aggAdset.revenue += adset.revenue;
            aggAdset.newUserRevenue += adset.newUserRevenue;
            aggAdset.deductedRevenue += adset.deductedRevenue ?? 0;
            aggAdset.correctedRevenue += adset.revenue * cf;
            aggAdset.correctedNewUserRevenue += adset.newUserRevenue * cf;
            aggAdset.correctedDeductedRevenue += (adset.deductedRevenue ?? 0) * cf;
            aggAdset.cost += adset.cost;
            aggAdset.impressions += adset.impressions;
            aggAdset.clicks += adset.clicks;
            for (const sid of adset.adsetIds ?? []) aggAdset.adsetIds.add(sid);

            for (const ad of adset.ads) {
              let aggAd = aggAdset.ads.get(ad.ad);
              if (!aggAd) {
                aggAd = {
                  ad: ad.ad,
                  revenue: 0,
                  newUserRevenue: 0,
                  deductedRevenue: 0,
                  correctedRevenue: 0,
                  correctedNewUserRevenue: 0,
                  correctedDeductedRevenue: 0,
                };
                aggAdset.ads.set(ad.ad, aggAd);
              }
              aggAd.revenue += ad.revenue;
              aggAd.newUserRevenue += ad.newUserRevenue;
              aggAd.deductedRevenue += ad.deductedRevenue ?? 0;
              aggAd.correctedRevenue += ad.revenue * cf;
              aggAd.correctedNewUserRevenue += ad.newUserRevenue * cf;
              aggAd.correctedDeductedRevenue += (ad.deductedRevenue ?? 0) * cf;
            }
          }
        }
      }

      // 回卷 corrected 到 product / operator。
      let prodCorr = 0;
      let prodCorrNew = 0;
      let prodCorrDed = 0;
      for (const c of aggProd.channels.values()) {
        prodCorr += c.correctedRevenue;
        prodCorrNew += c.correctedNewUserRevenue;
        prodCorrDed += c.correctedDeductedRevenue;
      }
      aggProd.correctedRevenue = prodCorr;
      aggProd.correctedNewUserRevenue = prodCorrNew;
      aggProd.correctedDeductedRevenue = prodCorrDed;
    }
    let opCorr = 0;
    let opCorrNew = 0;
    let opCorrDed = 0;
    for (const p of aggOp.products.values()) {
      opCorr += p.correctedRevenue;
      opCorrNew += p.correctedNewUserRevenue;
      opCorrDed += p.correctedDeductedRevenue;
    }
    aggOp.correctedRevenue = opCorr;
    aggOp.correctedNewUserRevenue = opCorrNew;
    aggOp.correctedDeductedRevenue = opCorrDed;
  }
}

function buildMultiDayOperators(
  operatorAgg: Map<string, AggOperator>,
): PersonalResponse['operators'] {
  return [...operatorAgg.values()]
    .map((op) => ({
      operator: op.operator,
      count: op.count,
      cost: op.cost,
      revenue: op.revenue,
      newUserRevenue: op.newUserRevenue,
      deductedRevenue: op.deductedRevenue,
      correctedRevenue: op.correctedRevenue,
      correctedNewUserRevenue: op.correctedNewUserRevenue,
      correctedDeductedRevenue: op.correctedDeductedRevenue,
      products: [...op.products.values()]
        .map((p) => ({
          product: p.product,
          count: p.count,
          cost: p.cost,
          revenue: p.revenue,
          newUserRevenue: p.newUserRevenue,
          deductedRevenue: p.deductedRevenue,
          correctedRevenue: p.correctedRevenue,
          correctedNewUserRevenue: p.correctedNewUserRevenue,
          correctedDeductedRevenue: p.correctedDeductedRevenue,
          channels: [...p.channels.values()]
            .map((c): PersonalChannel => {
              const campaigns: PersonalCampaign[] = [...c.campaigns.values()]
                .map((camp): PersonalCampaign => {
                  const adsets: PersonalAdset[] = [...camp.adsets.values()]
                    .map((adset): PersonalAdset => ({
                      adset: adset.adset,
                      revenue: adset.revenue,
                      newUserRevenue: adset.newUserRevenue,
                      deductedRevenue: adset.deductedRevenue,
                      correctedRevenue: adset.correctedRevenue,
                      correctedNewUserRevenue: adset.correctedNewUserRevenue,
                      correctedDeductedRevenue: adset.correctedDeductedRevenue,
                      cost: adset.cost,
                      impressions: adset.impressions,
                      clicks: adset.clicks,
                      adsetIds: [...adset.adsetIds],
                      ads: [...adset.ads.values()].sort((a, b) => b.revenue - a.revenue),
                    }))
                    .sort((a, b) => b.revenue - a.revenue);
                  return {
                    campaign: camp.campaign,
                    revenue: camp.revenue,
                    newUserRevenue: camp.newUserRevenue,
                    deductedRevenue: camp.deductedRevenue,
                    correctedRevenue: camp.correctedRevenue,
                    correctedNewUserRevenue: camp.correctedNewUserRevenue,
                    correctedDeductedRevenue: camp.correctedDeductedRevenue,
                    cost: camp.cost,
                    impressions: camp.impressions,
                    clicks: camp.clicks,
                    installs: camp.installs,
                    campaignIds: [...camp.campaignIds],
                    adsets,
                  };
                })
                .sort((a, b) => b.cost - a.cost);
              return {
                channel: c.channel,
                count: c.count,
                revenue: c.revenue,
                newUserRevenue: c.newUserRevenue,
                deductedRevenue: c.deductedRevenue,
                correctedRevenue: c.correctedRevenue,
                correctedNewUserRevenue: c.correctedNewUserRevenue,
                correctedDeductedRevenue: c.correctedDeductedRevenue,
                cost: c.cost,
                cpm: c.impressions > 0 ? round2((c.cost / c.impressions) * 1000) : null,
                cpc: c.clicks > 0 ? round2(c.cost / c.clicks) : null,
                campaigns,
              };
            })
            .sort((a, b) => b.revenue - a.revenue),
        }))
        .sort((a, b) => b.revenue - a.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

// ── 对外入口 ──
export interface PersonalInput {
  startDate: string;
  endDate: string;
}

async function computeMultiDay(startDate: string, endDate: string): Promise<PersonalResponse> {
  const dates = getDateRange(startDate, endDate);
  const today = todayBeijing();
  const missingDates: string[] = [];
  const operatorAgg = new Map<string, AggOperator>();
  const organicAgg: AggSummary = {
    count: 0,
    revenue: 0,
    newUserRevenue: 0,
    deductedRevenue: 0,
    correctedRevenue: 0,
    correctedNewUserRevenue: 0,
    correctedDeductedRevenue: 0,
  };
  const restrictedAgg: AggSummary = {
    count: 0,
    revenue: 0,
    newUserRevenue: 0,
    deductedRevenue: 0,
    correctedRevenue: 0,
    correctedNewUserRevenue: 0,
    correctedDeductedRevenue: 0,
  };

  const dailyCorrFactors = new Map<string, FactorMap>();
  for (const d of dates) {
    const dataDate = d >= today ? yesterdayBeijing() : d;
    try {
      dailyCorrFactors.set(d, await computeCorrectionFactors(dataDate));
    } catch {
      dailyCorrFactors.set(d, {});
    }
  }

  for (const d of dates) {
    const daysAgo = daysBefore(today, d);
    const factors = dailyCorrFactors.get(d) ?? {};
    const snapshot = await loadPersonalSnapshot(d);
    if (snapshot) {
      const meta = snapshot._meta;
      const dayData: PersonalResponse = { ...snapshot };
      delete (dayData as PersonalSnapshot)._meta;
      if (meta?.type === 'complete') {
        mergePersonalDay(operatorAgg, organicAgg, restrictedAgg, dayData, factors);
        continue;
      }
      if (meta?.type === 'partial' && daysAgo >= 2) {
        const patch = await patchCrossDayNewUsers(d);
        if (patch) {
          applyCrossDayPatch(dayData, patch);
          await savePersonalSnapshot(d, dayData, { type: 'complete', upgradedFrom: 'partial' });
        }
        mergePersonalDay(operatorAgg, organicAgg, restrictedAgg, dayData, factors);
        continue;
      }
      if (meta?.type === 'partial' && daysAgo === 1) {
        const patch = await patchCrossDayNewUsers(d);
        if (patch) applyCrossDayPatch(dayData, patch);
        mergePersonalDay(operatorAgg, organicAgg, restrictedAgg, dayData, factors);
        continue;
      }
    }
    if (d === today) {
      try {
        const live = await getPersonalDataLive(d);
        if (live) mergePersonalDay(operatorAgg, organicAgg, restrictedAgg, live, factors);
        else missingDates.push(d);
      } catch (error) {
        console.error(`[Personal Multi-day] Live query failed for ${d}:`, (error as Error).message);
        missingDates.push(d);
      }
    } else {
      missingDates.push(d);
    }
  }

  return {
    date: endDate,
    startDate,
    endDate,
    isRange: true,
    missingDates,
    operators: buildMultiDayOperators(operatorAgg),
    organic: organicAgg,
    restricted: restrictedAgg,
  };
}

async function computeSingleDay(date: string): Promise<PersonalResponse> {
  const today = todayBeijing();
  const daysAgo = daysBefore(today, date);
  const hour = nowBeijingHour();

  const existing = await loadPersonalSnapshot(date);
  if (existing) {
    const meta = existing._meta;
    const data: PersonalResponse = { ...existing };
    delete (data as PersonalSnapshot)._meta;
    if (meta?.type === 'complete') {
      return data;
    }
    if (meta?.type === 'partial' && daysAgo >= 2) {
      const patch = await patchCrossDayNewUsers(date);
      if (patch) {
        applyCrossDayPatch(data, patch);
        await savePersonalSnapshot(date, data, { type: 'complete', upgradedFrom: 'partial' });
        return data;
      }
      console.error(`[Snapshot] Cross-day patch failed for ${date}, falling back to full query`);
    }
    if (meta?.type === 'partial' && daysAgo === 1) {
      const patch = await patchCrossDayNewUsers(date);
      if (patch) applyCrossDayPatch(data, patch);
      return data;
    }
  }

  const tableName = tableForMonth(date);
  if (!(await tableExists(tableName))) {
    return { date, operators: [], organic: { count: 0, revenue: 0, newUserRevenue: 0 } };
  }

  const willSavePartial = daysAgo === 1 && hour >= 6 && !existing;
  const full = await computeSingleDayFull(date, willSavePartial);
  const responseData = full.response;

  const hasCost = responseHasReasonableCost(responseData);
  if (daysAgo >= 2 && hasCost) {
    await savePersonalSnapshot(date, responseData, { type: 'complete' });
  } else if (daysAgo === 1 && hour >= 6 && hasCost && !existing) {
    const base = buildPartialBase(full);
    await savePersonalSnapshot(date, base, { type: 'partial' });
  }

  return responseData;
}

/** 个人面板对外入口：单日 / 多日分派。 */
export async function computePersonal(input: PersonalInput): Promise<PersonalResponse> {
  const { startDate, endDate } = input;
  if (startDate !== endDate) {
    return computeMultiDay(startDate, endDate);
  }
  return computeSingleDay(startDate);
}
