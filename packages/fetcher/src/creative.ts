/**
 * 素材（creative）与 AIGC 抓取写入侧 —— 复刻旧 dashboard/fetch-creative-data.js。
 * 两条并列管线：creative（全素材超集，无 AIGC 过滤）与 aigc（仅 /aigc/i）。
 * 每条：XMP AD 级报表（report_type:'ad'，ad_name+product_name，cost/impression/click，
 * 分 facebook/tiktok 模块）取消耗 + PG records_YYYYMM 取 AF/AD 新用户收入，按
 * aigcMatchKey(name,product)::channel 关联，聚合成日快照写入 daily_snapshots
 * (kind='creative'|'aigc')，供 web 侧 creative.ts 读侧按 N 日窗口聚合。
 *
 * 迁移要点：
 *  - 收入源由旧 SQLite data.db 改为 PG 月表 records_YYYYMM；时间边界用北京日 sargable
 *    区间（af 用 UTC 字符串、ad 用 unix 秒），与 dashboard/personal.ts 同款惯用法，
 *    「安装日=目标北京日 且 24h 内付费」为新用户，跨月付费扫当月+次月两张表，无重复计数。
 *  - 名称归一保留末尾 _<数字>（命名规范正式编号），仅剥 _copy / 8 位随机哈希
 *    （对齐 main 分支 f88d8165：两侧同带编号，匹配 key 仍对齐且素材名唯一可辨）。
 *  - TT 消耗暂仍走 XMP module='tiktok'（未接 main 的 TikTok Marketing API 直连 fad4967d）。
 */

import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

import { query } from '@agentic-ug/db';

const XMP_CLIENT_ID = process.env['XMP_CLIENT_ID'] ?? '';
const XMP_CLIENT_SECRET = process.env['XMP_CLIENT_SECRET'] ?? '';
const XMP_HOST = process.env['XMP_API_HOST'] ?? 'xmp-open.mobvista.com';
const XMP_ACCOUNT_REPORT_PATH = '/v2/media/account/report';

// XMP 分页限速：单页 30s 签名 TTL，页间/渠道间退避（对齐旧 3.5s）。
const XMP_PAGE_DELAY_MS = 3500;

/** 用于命名解析的产品集合（非过滤）。 */
const PRODUCTS = ['Dora', 'Romi', 'Doni', 'Luma', 'Jovia', 'GraceChat', 'Kira', 'Nalo'];
const PRODUCTS_RE = PRODUCTS.join('|');

/** XMP module → 我方渠道名。 */
const XMP_CHANNEL_MAP: Record<string, string> = { facebook: 'FB', tiktok: 'TT' };

/** AF af_channel → 我方渠道名（非 FB/TT 的（如 Google/organic）跳过）。 */
const AF_CHANNEL_MAP: Record<string, string> = {
  Facebook: 'FB',
  Instagram: 'FB',
  AudienceNetwork: 'FB',
  'Off-Facebook': 'FB',
  TikTok: 'TT',
  Pangle: 'TT',
  tiktok: 'TT',
};

/** XMP report product_name → 我方产品名（带平台后缀）。 */
const XMP_PRODUCT_MAP: Record<string, string> = {
  'Romi: Make Friends, Have Fun': 'Romi iOS',
  'Dora: Create and connect': 'Dora iOS',
  'Dora: Find Real Companionship': 'Dora And',
  'Doni: Easy Connection': 'Doni',
  'Luma: Make Friends, Have Fun': 'Luma',
  'Jovia: Find Real Love': 'Jovia And',
  'Romi: Swipe, Chat & Connect': 'Romi And',
  GraceChat: 'GraceChat',
  'Kira: Creative Community': 'Kira iOS',
  'Kira: Find Your Romance': 'Kira And',
  'Nalo: Meet, Swipe & Chat': 'Nalo And',
  'Ruby: Meet, Chat & Date': 'Ruby And',
};

/** postback bundle_id / app_id → 我方产品名（带平台后缀）。 */
const APP_ID_MAP: Record<string, string> = {
  'com.doramatch.app': 'Dora And',
  id6746109957: 'Dora iOS',
  id6746782904: 'Romi iOS',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  id1658972379: 'GraceChat',
  id6759697686: 'Kira iOS',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
  'com.rubymatch.app': 'Ruby And',
  '6746109957': 'Dora iOS',
  '6746782904': 'Romi iOS',
  '1658972379': 'GraceChat',
  '6759697686': 'Kira iOS',
  '6746466099': 'Luma',
  'com.circleconnect.dora': 'Dora iOS',
  'com.chatsbridgeconnect.romi': 'Romi iOS',
  'com.odyssey.luma': 'Luma',
  id6746466099: 'Luma',
};

const AIGC_RE = /aigc/i;

/** AIGC 产品枚举（base product，无平台后缀）。 */
const AIGC_PRODUCTS = ['Doni', 'GraceChat', 'Jovia', 'Kira', 'Luma', 'Nalo', 'Romi', 'Vika'];
const AIGC_PRODUCT_SET = new Set(AIGC_PRODUCTS.map((p) => p.toLowerCase()));

// ══════════════════════════════════════════════════════════
// 名称解析（逐字复刻旧 fetch-creative-data.js）
// ══════════════════════════════════════════════════════════

// 旧规范并保留 product 段：MMDD_Designer_Product_Series_Number / MMDD_Product_Designer_Series_Number。
const RE_STD_P = new RegExp(`(\\d{4})_([A-Z]{2,3})_(${PRODUCTS_RE})_(.+?)_(\\d+)(?=[^\\d]|$)`);
const RE_ALT_P = new RegExp(`(\\d{4})_(${PRODUCTS_RE})_([A-Z]{2,3})_(.+?)_(\\d+)(?=[^\\d]|$)`);

interface OldName {
  date: string;
  designer: string;
  product: string;
  series: string;
  number: string;
}

function parseOldCreativeName(raw: string): OldName | null {
  if (!raw) return null;
  let date: string;
  let designer: string;
  let product: string;
  let series: string;
  let number: string;
  const std = RE_STD_P.exec(raw);
  if (std) {
    date = std[1] ?? '';
    designer = std[2] ?? '';
    product = std[3] ?? '';
    series = std[4] ?? '';
    number = std[5] ?? '';
  } else {
    const alt = RE_ALT_P.exec(raw);
    if (!alt) return null;
    date = alt[1] ?? '';
    product = alt[2] ?? '';
    designer = alt[3] ?? '';
    series = alt[4] ?? '';
    number = alt[5] ?? '';
  }
  const cleanSeries = series
    .replace(/_copy(?:_copy)*$/i, '')
    .replace(/_[A-Za-z0-9]{8}$/, '')
    .trim();
  return { date, designer, product, series: cleanSeries, number };
}

/** 兜底：任一段命中已知产品即取（补 productFromName 不识别 Dora 的缺口）。 */
function oldProductFromName(raw: string): string {
  if (!raw) return '';
  const seg = raw.split('_').find((s) => PRODUCTS.includes(s.trim()));
  return seg ? seg.trim() : '';
}

/** 取前导 YYMMDD → MM-DD（AIGC 规范），无则空串。 */
function aigcDateFromName(raw: string): string {
  const seg0 = raw.split('_')[0] ?? '';
  const dm = /^(\d{2})(\d{2})(\d{2})$/.exec(seg0);
  return dm ? `${dm[2] ?? ''}-${dm[3] ?? ''}` : '';
}

/** 平台后缀产品名（'Romi iOS'/'Dora And'）→ base product（'Romi'/'Dora'）。 */
function baseProduct(p: string): string {
  if (!p) return '';
  return p.replace(/\s+(iOS|And)$/i, '').trim();
}

/** 从 AIGC 素材/ad 名提取 base product：优先第 4 段（index 3），否则任一命中段。 */
function productFromName(rawName: string): string {
  if (!rawName) return '';
  let s = rawName;
  const m = /\.(mp4|mov|mpeg|m4v|avi|webm)/i.exec(s);
  if (m) s = s.slice(0, m.index);
  const segs = s.split('_');
  const cand = segs[3]?.trim() ?? '';
  if (cand && AIGC_PRODUCT_SET.has(cand.toLowerCase())) {
    return AIGC_PRODUCTS.find((p) => p.toLowerCase() === cand.toLowerCase()) ?? '';
  }
  const hit = segs.find((seg) => AIGC_PRODUCT_SET.has(seg.trim().toLowerCase()));
  return hit ? (AIGC_PRODUCTS.find((p) => p.toLowerCase() === hit.trim().toLowerCase()) ?? '') : '';
}

/**
 * 归一 AIGC ad/素材名 → 稳定匹配 key + 展示名。剥视频扩展名与真变体噪声
 * （_copy/_copy_copy、8 位随机哈希）。末尾 _<数字> 为命名规范正式编号，保留
 * （main f88d8165）：XMP 消耗与 AF/AD 收入两侧同带该编号，匹配 key 仍对齐。
 * product 不在此剥离——product 作为独立字段跟踪。
 */
function normalizeAigcName(rawName: string): { matchKey: string; displayName: string } {
  if (!rawName) return { matchKey: '', displayName: '' };
  let s = rawName;
  const m = /\.(mp4|mov|mpeg|m4v|avi|webm)/i.exec(s);
  if (m) s = s.slice(0, m.index);
  s = s
    .replace(/_copy(?:_copy)*$/i, '')
    .replace(/_[A-Za-z0-9]{8}$/, '')
    .trim();
  return { matchKey: s.toLowerCase(), displayName: s };
}

/** 跨源匹配 key：归一素材名 + base product。 */
function aigcMatchKey(rawName: string, product: string): string {
  const { matchKey } = normalizeAigcName(rawName);
  return `${matchKey}@@${product.toLowerCase()}`;
}

interface DynamicName {
  key: string;
  name: string;
  product: string;
  designer: string;
  series: string;
  number: string;
  date: string;
}

/** 动态解析：AIGC 规范 → 旧规范 → 脏名兜底，永不返回 null（一行都不丢）。 */
function parseCreativeNameDynamic(raw: string): DynamicName {
  const original = raw;
  const { matchKey, displayName } = normalizeAigcName(original);

  if (AIGC_RE.test(original)) {
    return {
      key: matchKey,
      name: displayName,
      product: productFromName(original),
      designer: '',
      series: '',
      number: '',
      date: aigcDateFromName(original),
    };
  }

  const old = parseOldCreativeName(original);
  if (old) {
    return {
      key: matchKey,
      name: displayName,
      product: old.product,
      designer: old.designer,
      series: old.series,
      number: old.number,
      date: old.date,
    };
  }

  return {
    key: matchKey,
    name: displayName,
    product: productFromName(original) || oldProductFromName(original),
    designer: '',
    series: '',
    number: '',
    date: '',
  };
}

// ══════════════════════════════════════════════════════════
// 日期 / 月表工具（北京时区，纯 epoch 偏移）
// ══════════════════════════════════════════════════════════

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** YYYY-MM-DD → records_YYYYMM。 */
function tableForMonth(dateStr: string): string {
  return `records_${dateStr.slice(0, 4)}${dateStr.slice(5, 7)}`;
}

/** 北京「今天」YYYY-MM-DD。 */
function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** dateStr 往前 n 天（本地日历减法，复刻旧 prevDate）。 */
function prevDate(dateStr: string, n = 1): string {
  const parts = dateStr.split('-').map(Number);
  const dt = new Date(parts[0] ?? 0, (parts[1] ?? 1) - 1, (parts[2] ?? 1) - n);
  return `${dt.getFullYear().toString()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** dateStr 次日 YYYY-MM-DD（本地日历加一）。 */
function nextDateStr(dateStr: string): string {
  const parts = dateStr.split('-').map(Number);
  const o = new Date(parts[0] ?? 0, (parts[1] ?? 1) - 1, (parts[2] ?? 1) + 1);
  return `${o.getFullYear().toString()}-${pad2(o.getMonth() + 1)}-${pad2(o.getDate())}`;
}

interface DayBounds {
  strLo: string;
  strHi: string;
  epLo: number;
  epHi: number;
}

/** 某北京自然日的 sargable 边界：af 用 UTC 字符串、ad 用 unix 秒。 */
function beijingDayBounds(dateStr: string): DayBounds {
  const loMs = Date.parse(`${dateStr}T00:00:00+08:00`);
  const hiMs = loMs + 86_400_000;
  const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return {
    strLo: fmt(loMs),
    strHi: fmt(hiMs),
    epLo: Math.floor(loMs / 1000),
    epHi: Math.floor(hiMs / 1000),
  };
}

// ══════════════════════════════════════════════════════════
// 通用小工具
// ══════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function prop(obj: unknown, key: string): unknown {
  return isRecord(obj) ? obj[key] : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** payload JSON 串取键（缺失/非法返回 ''，对齐 json_extract 宽松语义）。 */
function jsonField(payload: string | null, key: string): string {
  if (!payload) return '';
  try {
    const o: unknown = JSON.parse(payload);
    const v = prop(o, key);
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  } catch {
    return '';
  }
}

// ══════════════════════════════════════════════════════════
// XMP AD 级报表抓取
// ══════════════════════════════════════════════════════════

function xmpSign(): { timestamp: number; sign: string } {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = createHash('md5')
    .update(XMP_CLIENT_SECRET + timestamp.toString())
    .digest('hex');
  return { timestamp, sign };
}

/** POST account/report，返回 data 对象；code!=0 抛错。 */
function xmpAdRequest(body: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const payload = JSON.stringify(body);
    const req = httpsRequest(
      {
        hostname: XMP_HOST,
        path: XMP_ACCOUNT_REPORT_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 30_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += String(chunk);
        });
        res.on('end', () => {
          try {
            const j: unknown = JSON.parse(data);
            if (prop(j, 'code') !== 0) {
              reject(
                new Error(
                  `XMP API error: ${asString(prop(j, 'msg'))} (code ${String(prop(j, 'code'))})`,
                ),
              );
              return;
            }
            resolvePromise(prop(j, 'data'));
          } catch {
            reject(new Error(`XMP JSON parse error: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('XMP API timeout'));
    });
    req.write(payload);
    req.end();
  });
}

interface XmpRow {
  name: string;
  product: string;
  matchKey: string;
  designer: string;
  series: string;
  number: string;
  date: string;
  channel: string;
  cost: number;
  impressions: number;
  clicks: number;
}

/**
 * 抓取指定北京日的 XMP AD 级消耗（FB+TT）。aigcOnly=true 时仅保留名字含 aigc 的行。
 * 每行携带自身 product_name 与运营命名的 ad_name，product 优先取报表映射、回退命名解析。
 */
async function fetchXmpAdRows(dateStr: string, aigcOnly: boolean): Promise<XmpRow[]> {
  const rows: XmpRow[] = [];
  for (const module of ['facebook', 'tiktok']) {
    // 单渠道最多 50 页（page_size 1000），命中空页/不足页即停。
    for (let page = 1; page <= 50; page += 1) {
      const { timestamp, sign } = xmpSign();
      const data = await xmpAdRequest({
        client_id: XMP_CLIENT_ID,
        timestamp,
        sign,
        start_date: dateStr,
        end_date: dateStr,
        report_type: 'ad',
        dimension: ['ad_name', 'product_name'],
        metrics: ['cost', 'impression', 'click'],
        currency: 'USD',
        module,
        page,
        page_size: 1000,
      });

      const list = prop(data, 'list');
      if (!Array.isArray(list) || list.length === 0) break;

      for (const row of list) {
        const name = asString(prop(row, 'ad_name'));
        if (!name) continue;
        if (aigcOnly && !AIGC_RE.test(name)) continue;

        const rawProduct = asString(prop(row, 'product_name'));
        const mappedProduct = XMP_PRODUCT_MAP[rawProduct] ?? rawProduct;
        const parsed = parseCreativeNameDynamic(name);
        const product = baseProduct(mappedProduct) || parsed.product;

        rows.push({
          name: parsed.name,
          product,
          matchKey: aigcMatchKey(name, product),
          designer: parsed.designer,
          series: parsed.series,
          number: parsed.number,
          date: parsed.date,
          channel: XMP_CHANNEL_MAP[module] ?? module,
          cost: asNumber(prop(row, 'cost')),
          impressions: asNumber(prop(row, 'impression')),
          clicks: asNumber(prop(row, 'click')),
        });
      }

      if (list.length < 1000) break;
      await sleep(XMP_PAGE_DELAY_MS);
    }
    if (module === 'facebook') await sleep(XMP_PAGE_DELAY_MS);
  }
  return rows;
}

// ══════════════════════════════════════════════════════════
// AF/AD 新用户收入（PG records_YYYYMM）
// ══════════════════════════════════════════════════════════

interface RevenueRow {
  matchKey: string;
  channel: string;
  revenue: number;
}

interface RawPurchase {
  revenue: number | null;
  install_time: string | null;
  event_time: string | null;
  payload: string | null;
  app_id: string | null;
}

/** postback 应用标识 → base product，回退命名解析。 */
function productFromRevenue(
  bundleId: string,
  appId: string,
  name: string,
  allowOldFallback: boolean,
): string {
  const mapped =
    APP_ID_MAP[bundleId] ?? APP_ID_MAP[appId] ?? (appId ? (APP_ID_MAP[`id${appId}`] ?? '') : '');
  const base = baseProduct(mapped) || productFromName(name);
  if (base) return base;
  return allowOldFallback ? oldProductFromName(name) : '';
}

async function tableExists(tbl: string): Promise<boolean> {
  const rows = await query<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE tablename = $1',
    [tbl],
  );
  return rows.length > 0;
}

/**
 * 目标北京日新用户收入：安装日=dateStr 且安装后 24h 内付费。
 * af（ISO 字符串时间）+ ad（unix 秒时间）两类，扫当月+次月表（跨月付费落次月表），
 * 一行仅存在于一张表，无重复计数。aigcOnly=true 时仅保留名字含 aigc 的行。
 */
async function fetchNewUserRevenue(dateStr: string, aigcOnly: boolean): Promise<RevenueRow[]> {
  const currentTable = tableForMonth(dateStr);
  const nextTable = tableForMonth(nextDateStr(dateStr));
  const dB = beijingDayBounds(dateStr);

  const tables = [currentTable];
  if (nextTable !== currentTable) tables.push(nextTable);

  const results: RevenueRow[] = [];

  for (const table of tables) {
    if (!(await tableExists(table))) continue;

    // ── AF 付费（安装日在目标北京日、24h 内）──
    const afRows = await query<RawPurchase>(
      `SELECT revenue, install_time, event_time, payload, app_id FROM ${table}
       WHERE event_name = 'af_purchase'
         AND install_time >= $1 AND install_time < $2
         AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 >= 0
         AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 < 24`,
      [dB.strLo, dB.strHi],
    );
    for (const row of afRows) {
      const name = jsonField(row.payload, 'af_ad');
      if (!name) continue;
      if (aigcOnly && !AIGC_RE.test(name)) continue;
      const channel = AF_CHANNEL_MAP[jsonField(row.payload, 'af_channel')];
      if (!channel) continue; // 跳过 Google / organic
      const product = productFromRevenue(
        jsonField(row.payload, 'bundle_id'),
        row.app_id ?? '',
        name,
        !aigcOnly,
      );
      results.push({ matchKey: aigcMatchKey(name, product), channel, revenue: row.revenue ?? 0 });
    }

    // ── AD（Adjust）付费（安装日在目标北京日、24h 内，非自然量）──
    const adRows = await query<RawPurchase>(
      `SELECT revenue, install_time, event_time, payload, app_id FROM ${table}
       WHERE event_name = 'ad_purchase'
         AND install_time::bigint >= $1 AND install_time::bigint < $2
         AND event_time::bigint - install_time::bigint >= 0
         AND event_time::bigint - install_time::bigint < 86400`,
      [dB.epLo, dB.epHi],
    );
    for (const row of adRows) {
      if (jsonField(row.payload, 'is_organic') !== '0') continue;
      const rawCreative = jsonField(row.payload, 'creative');
      if (!rawCreative) continue;
      let creative: string;
      try {
        creative = decodeURIComponent(rawCreative.replaceAll('+', ' '));
      } catch {
        creative = rawCreative;
      }
      creative = creative.replace(/\s*\(\d+\)\s*$/, '');
      if (!creative) continue;
      if (aigcOnly && !AIGC_RE.test(creative)) continue;
      const product = productFromRevenue(
        jsonField(row.payload, 'bundle_id'),
        row.app_id ?? '',
        creative,
        !aigcOnly,
      );
      // AD 仅 iOS 且多为 FB，默认 FB（对齐旧实现）。
      results.push({
        matchKey: aigcMatchKey(creative, product),
        channel: 'FB',
        revenue: row.revenue ?? 0,
      });
    }
  }

  return results;
}

// ══════════════════════════════════════════════════════════
// 聚合
// ══════════════════════════════════════════════════════════

interface CreativeOut {
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

interface AigcOut {
  name: string;
  product: string;
  channel: string;
  cost: number;
  impressions: number;
  clicks: number;
  newUserRevenue: number;
}

interface XmpAgg {
  row: XmpRow;
  cost: number;
  impressions: number;
  clicks: number;
  product: string;
}

/** 消耗与收入均按 matchKey::channel 关联；product 缺失时用后到的补全。 */
function foldRevenue(revenueRows: RevenueRow[]): Map<string, number> {
  const revMap = new Map<string, number>();
  for (const row of revenueRows) {
    const k = `${row.matchKey}::${row.channel}`;
    revMap.set(k, (revMap.get(k) ?? 0) + row.revenue);
  }
  return revMap;
}

function foldXmp(xmpRows: XmpRow[]): Map<string, XmpAgg> {
  const xmpMap = new Map<string, XmpAgg>();
  for (const row of xmpRows) {
    const k = `${row.matchKey}::${row.channel}`;
    let agg = xmpMap.get(k);
    if (!agg) {
      agg = { row, cost: 0, impressions: 0, clicks: 0, product: row.product };
      xmpMap.set(k, agg);
    }
    if (!agg.product && row.product) agg.product = row.product;
    agg.cost += row.cost;
    agg.impressions += row.impressions;
    agg.clicks += row.clicks;
  }
  return xmpMap;
}

function aggregateCreative(xmpRows: XmpRow[], revenueRows: RevenueRow[]): CreativeOut[] {
  const xmpMap = foldXmp(xmpRows);
  const revMap = foldRevenue(revenueRows);
  const merged: CreativeOut[] = [];
  for (const [key, agg] of xmpMap) {
    merged.push({
      name: agg.row.name,
      product: agg.product,
      designer: agg.row.designer,
      series: agg.row.series,
      number: agg.row.number,
      date: agg.row.date,
      channel: agg.row.channel,
      cost: agg.cost,
      impressions: agg.impressions,
      clicks: agg.clicks,
      newUserRevenue: revMap.get(key) ?? 0,
    });
  }
  return merged;
}

function aggregateAigc(xmpRows: XmpRow[], revenueRows: RevenueRow[]): AigcOut[] {
  const xmpMap = foldXmp(xmpRows);
  const revMap = foldRevenue(revenueRows);
  const merged: AigcOut[] = [];
  for (const [key, agg] of xmpMap) {
    merged.push({
      name: agg.row.name,
      product: agg.product,
      channel: agg.row.channel,
      cost: agg.cost,
      impressions: agg.impressions,
      clicks: agg.clicks,
      newUserRevenue: revMap.get(key) ?? 0,
    });
  }
  return merged;
}

// ══════════════════════════════════════════════════════════
// 落库 daily_snapshots
// ══════════════════════════════════════════════════════════

async function saveSnapshot(
  kind: 'creative' | 'aigc',
  dateStr: string,
  creatives: unknown[],
): Promise<void> {
  const payload = { date: dateStr, fetchedAt: Date.now(), creatives };
  await query(
    `INSERT INTO daily_snapshots (kind, date, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (kind, date) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [kind, dateStr, JSON.stringify(payload)],
  );
}

async function fetchAndSaveCreative(dateStr: string): Promise<void> {
  console.log(`[creative] fetching ${dateStr}...`);
  const xmpRows = await fetchXmpAdRows(dateStr, false);
  console.log(`[creative]   XMP: ${xmpRows.length.toString()} ad rows`);
  const revenueRows = await fetchNewUserRevenue(dateStr, false);
  console.log(`[creative]   revenue: ${revenueRows.length.toString()} new-user events`);
  const aggregated = aggregateCreative(xmpRows, revenueRows);
  console.log(`[creative]   aggregated: ${aggregated.length.toString()} creative-channel combos`);
  await saveSnapshot('creative', dateStr, aggregated);
  console.log(`[creative]   saved daily_snapshots(creative, ${dateStr})`);
}

async function fetchAndSaveAigc(dateStr: string): Promise<void> {
  console.log(`[aigc] fetching ${dateStr}...`);
  const xmpRows = await fetchXmpAdRows(dateStr, true);
  console.log(`[aigc]   XMP: ${xmpRows.length.toString()} AIGC ad rows`);
  const revenueRows = await fetchNewUserRevenue(dateStr, true);
  console.log(`[aigc]   revenue: ${revenueRows.length.toString()} AIGC new-user events`);
  const aggregated = aggregateAigc(xmpRows, revenueRows);
  console.log(`[aigc]   aggregated: ${aggregated.length.toString()} AIGC material-channel combos`);
  await saveSnapshot('aigc', dateStr, aggregated);
  console.log(`[aigc]   saved daily_snapshots(aigc, ${dateStr})`);
}

/**
 * 素材 + AIGC 日抓取。dates 省略时默认取最近两个完整日（昨日、前日）：
 * 昨日为面板窗口最新所需日，前日用于把跨日新用户收入结算完整（幂等 upsert 可重复写）。
 * 失败按管线隔离，单条异常记日志不阻断其余日/管线。
 */
export async function fetchCreativeAll(dates?: readonly string[]): Promise<void> {
  const targetDates = dates ?? [prevDate(todayBeijing(), 2), prevDate(todayBeijing(), 1)];
  for (const dateStr of targetDates) {
    try {
      await fetchAndSaveCreative(dateStr);
    } catch (error) {
      console.error(`[creative] ${dateStr} failed:`, (error as Error).message);
    }
    try {
      await fetchAndSaveAigc(dateStr);
    } catch (error) {
      console.error(`[aigc] ${dateStr} failed:`, (error as Error).message);
    }
  }
}
