/**
 * XMP Open API 成本抓取 —— 原生 TS 实现，替代旧 scripts/fetch-xmp-api.{sh,js} 调用链。
 * 按 md5(CLIENT_SECRET + unix_timestamp) 签名，POST xmp-open.mobvista.com 分页拉取
 * facebook/google/tiktok 三渠道 campaign 成本，聚合成 {product,cost}[]（product 汇总，降序）。
 * XMP 数据时区为北京（UTC+8），date 直接传北京自然日。
 */

import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

import { query, queryOne } from '@agentic-ug/db';

const CLIENT_ID = process.env['XMP_CLIENT_ID'] ?? '';
const CLIENT_SECRET = process.env['XMP_CLIENT_SECRET'] ?? '';
const API_HOST = process.env['XMP_API_HOST'] ?? 'xmp-open.mobvista.com';
const REPORT_PATH = '/v2/media/account/report';

const CHANNELS = ['facebook', 'google', 'tiktok'] as const;

/** 渠道 → 简称，与 web 端 apps/web/.../xmp.ts 的 XMP_CHANNEL_SHORT 逐字一致（缓存被 web 读取）。 */
const CHANNEL_SHORT: Record<string, string> = { facebook: 'FB', google: 'GG', tiktok: 'TT' };

// XMP Open API 限额约 10 QPM。整点单次 adset 级全渠道抓取实测 ~21s/1286 行、不触发限流，
// 但仍保留相邻调用最小间隔，避免与 web 端惰性请求叠加时打满窗口。
const XMP_MIN_INTERVAL_MS = 8000;
// expires_at 写极远未来 → xmp_cache 永久留存（与 web 端一致）；当天刷新只看 payload.fetchedAt。
const XMP_CACHE_EXPIRES_AT = '9999-12-31T23:59:59Z';
const XMP_RATE_COOLDOWN_MS = 60_000; // 命中限流后的冷却（对齐老看板 60s 窗口复位经验）
const XMP_CHANNEL_RETRY_MAX = 3; // 单渠道限流/失败重试次数（含冷却），降低单渠道漏抓概率

/**
 * PWA 归集产品名。XMP 里 product_name 为空（PWA 投放未挂产品）以及 'Smart Reply'、
 * 'Savvy: Paid to Create' 这类 PWA 站点，统一归到这个名下，行照常写进 xmp_cache，
 * 但**不参与任何产品级口径**——
 * 汇总面板、渠道汇总、个人面板、快照 XMP 消耗均在聚合处跳过它，
 * 只有投手日报按 DAU 占比分摊 PWA 成本时才读它。
 * ⚠️ 必须与 web 端 apps/web/src/lib/dashboard/xmp.ts 的 XMP_PWA_PRODUCT 逐字一致。
 */
export const XMP_PWA_PRODUCT = 'PWA';

/**
 * XMP product_name → 我方产品名。
 * ⚠️ 必须与 web 端 apps/web/src/lib/dashboard/xmp.ts 的 XMP_PRODUCT_MAP 逐字一致：
 * 本表用于 scheduler 整点预热写 xmp_cache（个人面板/汇总面板直接命中该缓存），web 端惰性补齐
 * 走各自的表；两处不同步会导致同一产品在不同抓取路径下产品名不一致（如 Nalo 曾漏映射，
 * 缓存里同时出现 'Nalo: Meet, Swipe & Chat' 与 'Nalo And'，与 AF 侧 'Nalo And' 对不上）。
 */
const PRODUCT_MAP: Record<string, string> = {
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
  'Mora: Unique Frequencies': 'Mora iOS',
  'Smart Reply': XMP_PWA_PRODUCT,
  'Savvy: Paid to Create': XMP_PWA_PRODUCT,
};

export interface XmpSummaryRow {
  product: string;
  cost: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** XMP 是否因限流拒绝（"request too frequently" 及常见变体）。 */
function isRateLimited(resp: unknown): boolean {
  if (prop(resp, 'code') === 0) return false;
  const msg = asString(prop(resp, 'msg')).toLowerCase();
  return (
    msg.includes('frequent') ||
    msg.includes('too many') ||
    msg.includes('rate limit') ||
    msg.includes('频繁')
  );
}

function makeSign(): { timestamp: number; sign: string } {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = createHash('md5')
    .update(CLIENT_SECRET + timestamp.toString())
    .digest('hex');
  return { timestamp, sign };
}

function apiRequest(body: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const payload = JSON.stringify(body);
    const req = httpsRequest(
      {
        hostname: API_HOST,
        path: REPORT_PATH,
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
            resolvePromise(JSON.parse(data));
          } catch {
            reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
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

/** 分页拉取单渠道当日 campaign 成本（cost>0）。 */
async function fetchChannel(channel: string, date: string): Promise<XmpSummaryRow[]> {
  const rows: XmpSummaryRow[] = [];
  let page = 1;
  for (;;) {
    const { timestamp, sign } = makeSign();
    const resp = await apiRequest({
      client_id: CLIENT_ID,
      timestamp,
      sign,
      start_date: date,
      end_date: date,
      dimension: ['campaign_name', 'product_name'],
      module: channel,
      metrics: ['cost'],
      currency: 'USD',
      page,
      page_size: 1000,
    });

    if (prop(resp, 'code') !== 0) {
      throw new Error(
        `[XMP API] ${channel} page ${page.toString()} error: ${asString(prop(resp, 'msg'))} (code ${String(prop(resp, 'code'))})`,
      );
    }

    const list = prop(prop(resp, 'data'), 'list');
    if (!Array.isArray(list) || list.length === 0) break;

    for (const row of list) {
      const cost = Number(prop(row, 'cost'));
      if (Number.isFinite(cost) && cost > 0) {
        const xmpName = asString(prop(row, 'product_name'));
        rows.push({ product: PRODUCT_MAP[xmpName] ?? xmpName, cost });
      }
    }

    page += 1;
    if (page > 50) break;
  }
  return rows;
}

function prop(obj: unknown, key: string): unknown {
  return isRecord(obj) ? obj[key] : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function ymdBeijing(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 抓取指定北京自然日的 XMP 成本，按产品聚合并降序返回 {product,cost}[]。
 * date 为 null 时取今天（北京）。复刻旧 fetch-xmp-api.js summary 模式输出。
 */
export async function fetchXmpApiSummary(date: string | null): Promise<XmpSummaryRow[]> {
  const targetDate = date ?? ymdBeijing();
  const all: XmpSummaryRow[] = [];
  for (const channel of CHANNELS) {
    const channelRows = await fetchChannel(channel, targetDate);
    all.push(...channelRows);
    console.error(`[XMP API] ${channel}: ${channelRows.length.toString()} active campaigns`);
  }

  const totals = new Map<string, number>();
  for (const row of all) {
    totals.set(row.product, (totals.get(row.product) ?? 0) + row.cost);
  }
  return [...totals.entries()]
    .map(([product, cost]) => ({ product, cost }))
    .sort((a, b) => b.cost - a.cost);
}

// ===== adset 级抓取 + 写 xmp_cache（供 scheduler 整点预热个人面板 / 汇总面板）=====

/**
 * adset 级 XMP 行 —— 结构必须与 web 端 apps/web/src/lib/dashboard/xmp.ts 的 XmpRow 逐字一致
 * （web 端惰性读取同一 xmp_cache，字段错位会导致命中失败或口径错乱）。
 */
export interface XmpCampaignRow {
  product: string;
  campaign: string;
  adset: string;
  channel: string;
  cost: number;
  impressions: number;
  clicks: number;
}

/** xmp_cache payload —— 与 web 端 XmpCacheEntry 一致：{ data, fetchedAt, complete }。 */
interface XmpCacheEntry {
  data: XmpCampaignRow[];
  fetchedAt: number;
  complete: boolean;
}

interface XmpReportRow {
  cost?: number;
  product_name?: string;
  campaign_name?: string;
  adset_name?: string;
  impression?: number;
  click?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 已写入 xmp_cache（未过期）的完整缓存直接返回，避免整点重复抓当前小时。 */
async function getCompleteXmpCache(date: string): Promise<XmpCacheEntry | null> {
  const cacheKey = `xmp-campaigns-${date}`;
  const row = await queryOne<{ payload: XmpCacheEntry }>(
    'SELECT payload FROM xmp_cache WHERE cache_key = $1 AND expires_at > now()',
    [cacheKey],
  );
  return row?.payload ?? null;
}

/** 写 xmp_cache，expires_at = 极远未来（永久留存，与 web 端 setXmpCacheEntry 一致）。 */
async function writeXmpCache(date: string, entry: XmpCacheEntry): Promise<void> {
  const cacheKey = `xmp-campaigns-${date}`;
  await query(
    `INSERT INTO xmp_cache (cache_key, payload, expires_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
    [cacheKey, JSON.stringify(entry), XMP_CACHE_EXPIRES_AT],
  );
}

/**
 * 分页拉取单渠道 adset 级成本（cost>0 才保留），带最小调用间隔限速。
 * 命中限流（"request too frequently"）时，冷却 XMP_RATE_COOLDOWN_MS 后重试当前页，
 * 最多 XMP_CHANNEL_RETRY_MAX 次；重试耗尽仍限流则本渠道判失败（ok=false），
 * 交由上层用旧缓存的该渠道数据补齐，绝不因单渠道失败丢掉整日其它渠道数据。
 */
async function fetchChannelAdset(
  channel: string,
  date: string,
): Promise<{ rows: XmpCampaignRow[]; ok: boolean }> {
  const rows: XmpCampaignRow[] = [];
  const shortName = CHANNEL_SHORT[channel] ?? channel;
  let page = 1;
  let pageRetries = 0;
  for (;;) {
    const { timestamp, sign } = makeSign();
    let resp: unknown;
    try {
      resp = await apiRequest({
        client_id: CLIENT_ID,
        timestamp,
        sign,
        start_date: date,
        end_date: date,
        dimension: ['campaign_name', 'adset_name', 'product_name'],
        module: channel,
        metrics: ['cost', 'impression', 'click'],
        currency: 'USD',
        page,
        page_size: 1000,
      });
    } catch (error) {
      console.error(`[XMP API] ${channel} adset request error: ${(error as Error).message}`);
      return { rows, ok: false };
    }

    // 限流：冷却后重试当前页（不推进 page、不丢已抓行），窗口复位再继续。
    if (isRateLimited(resp)) {
      if (pageRetries >= XMP_CHANNEL_RETRY_MAX) {
        console.error(
          `[XMP API] ${channel} adset page ${page.toString()} rate limited, retries exhausted — channel marked failed`,
        );
        return { rows, ok: false };
      }
      pageRetries += 1;
      console.warn(
        `[XMP API] ${channel} adset page ${page.toString()} rate limited; cooldown ${(XMP_RATE_COOLDOWN_MS / 1000).toString()}s, retry ${pageRetries.toString()}/${XMP_CHANNEL_RETRY_MAX.toString()}`,
      );
      await sleep(XMP_RATE_COOLDOWN_MS);
      continue;
    }

    if (prop(resp, 'code') !== 0) {
      console.error(
        `[XMP API] ${channel} adset page ${page.toString()} error: ${asString(prop(resp, 'msg'))} (code ${String(prop(resp, 'code'))})`,
      );
      return { rows, ok: false };
    }

    const list = prop(prop(resp, 'data'), 'list');
    if (!Array.isArray(list) || list.length === 0) break;

    for (const raw of list) {
      const row = raw as XmpReportRow;
      if ((row.cost ?? 0) > 0) {
        const xmpName = row.product_name ?? '';
        rows.push({
          product: xmpName ? (PRODUCT_MAP[xmpName] ?? xmpName) : XMP_PWA_PRODUCT,
          campaign: (row.campaign_name ?? '').trim(),
          adset: (row.adset_name ?? '').trim(),
          channel: shortName,
          cost: row.cost ?? 0,
          impressions: row.impression ?? 0,
          clicks: row.click ?? 0,
        });
      }
    }

    page += 1;
    pageRetries = 0;
    if (page > 50) break;
    await sleep(XMP_MIN_INTERVAL_MS);
  }
  return { rows, ok: true };
}

/**
 * 从已写入 xmp_cache 的某北京日 adset 级数据按 product 加总得出 product 级消耗。
 * 与 web 端 loadXmpProductCostRange（apps/web/src/lib/dashboard/xmp.ts）同口径：
 * 均自 adset 级 cost 按 product 相加、跳过空 product 与 PWA，保证快照 XMP 消耗与看板同源一致。
 * 缓存缺失/为空返回空数组；结果按 cost 降序（对齐 fetchXmpApiSummary 输出）。
 */
export async function readXmpProductCostFromCache(date: string): Promise<XmpSummaryRow[]> {
  const entry = await getCompleteXmpCache(date);
  if (!entry) return [];
  const byProduct = new Map<string, number>();
  for (const row of entry.data) {
    if (!row.product || row.product === XMP_PWA_PRODUCT) continue;
    byProduct.set(row.product, (byProduct.get(row.product) ?? 0) + row.cost);
  }
  return [...byProduct.entries()]
    .map(([product, cost]) => ({ product, cost }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * 抓取某北京自然日的 adset 级 XMP 成本并写入 xmp_cache（供个人面板直接命中，
 * 汇总面板 channel-summary / /api/data 亦由此缓存加总得出 product 级消耗）。
 * 仅当三渠道都成功且都有花费时标记 complete（对齐 web 端 fetchXmpCampaigns 的完整判定）。
 * date 为 null 时取今天（北京）。返回抓取行数与是否 complete。
 */
export async function fetchXmpCampaignsToCache(
  date: string | null,
): Promise<{ date: string; rows: number; complete: boolean }> {
  const targetDate = date ?? ymdBeijing();

  // 抓取前先读旧缓存：任一渠道本次失败/无数据时，用旧缓存该渠道的行补齐，
  // 绝不让某渠道（如 GG 限流失败）在缓存里凭空消失。
  const existing = await getCompleteXmpCache(targetDate);
  const existingByChannel = new Map<string, XmpCampaignRow[]>();
  for (const row of existing?.data ?? []) {
    const list = existingByChannel.get(row.channel) ?? [];
    list.push(row);
    existingByChannel.set(row.channel, list);
  }

  // 逐渠道抓取，记录本次成功且拿到数据的渠道。
  const freshByChannel = new Map<string, XmpCampaignRow[]>();
  const freshOkChannels = new Set<string>();
  for (const channel of CHANNELS) {
    const shortName = CHANNEL_SHORT[channel] ?? channel;
    const { rows, ok } = await fetchChannelAdset(channel, targetDate);
    if (ok) {
      // 成功（含正常空：该渠道当日确无花费）→ 以本次结果为准。
      freshByChannel.set(shortName, rows);
      if (rows.length > 0) freshOkChannels.add(shortName);
    }
    console.error(
      `[XMP API] ${channel} adset: ${rows.length.toString()} rows (ok: ${ok.toString()})`,
    );
    await sleep(XMP_MIN_INTERVAL_MS);
  }

  // 合成最终数据：每渠道优先用本次成功结果，失败渠道回退旧缓存该渠道的行。
  const merged: XmpCampaignRow[] = [];
  const preservedChannels: string[] = [];
  for (const ch of ['FB', 'GG', 'TT']) {
    if (freshByChannel.has(ch)) {
      merged.push(...(freshByChannel.get(ch) ?? []));
    } else if (existingByChannel.has(ch)) {
      merged.push(...(existingByChannel.get(ch) ?? []));
      preservedChannels.push(ch);
    }
  }
  if (preservedChannels.length > 0) {
    console.warn(
      `[XMP API] ${targetDate}: channels [${preservedChannels.join(',')}] failed this run — preserved from existing cache`,
    );
  }

  const mergedChannels = new Set(merged.map((r) => r.channel));
  const allChannelsHaveData = ['FB', 'GG', 'TT'].every((ch) => mergedChannels.has(ch));
  // complete 仅当三渠道本次都新鲜成功且有数据（回退补齐的不算完整，短缓存促使下次重拉）。
  const complete = ['FB', 'GG', 'TT'].every((ch) => freshOkChannels.has(ch));

  if (complete) {
    await writeXmpCache(targetDate, { data: merged, fetchedAt: Date.now(), complete: true });
  } else if (merged.length > 0 || existing == null) {
    // 有数据（含补齐）就写；即便空也在无旧缓存时写空占位，避免读侧误判缺失。
    await writeXmpCache(targetDate, { data: merged, fetchedAt: Date.now(), complete: false });
  } else {
    console.error(`[XMP API] adset fetch for ${targetDate} empty — keeping existing cache`);
  }

  console.error(
    `[XMP API] Cached ${merged.length.toString()} adset rows for ${targetDate} (complete: ${complete.toString()}, channels: ${[...mergedChannels].sort().join('/')}, allHaveData: ${allChannelsHaveData.toString()})`,
  );
  return { date: targetDate, rows: merged.length, complete };
}
