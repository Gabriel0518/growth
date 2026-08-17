/**
 * XMP Open API 客户端与缓存 —— 复刻旧 dashboard/server.js 的 fetchXmpCampaigns。
 * 按渠道（facebook/google/tiktok）分页拉取 campaign×adset×product 的 cost/曝光/点击。
 * SQLite/文件缓存 → PG：xmp_cache(cache_key, payload, expires_at)；payload 存
 * { data, fetchedAt, complete }，TTL 逻辑（30min 完整 / 5min 不完整 / staleOk）在代码里判定。
 * expires_at 写「极远未来」——历史 adgroup 级消耗永久留存，看板与对外接口可查任意历史日期；
 * 「当天每小时刷新」完全由 payload.fetchedAt 新鲜度判定（见下 XMP_CACHE_TTL），与 expires_at 无关。
 */

import { createHash } from 'node:crypto';

import { query, queryOne } from '@agentic-ug/db';

import { config } from '../config';

export interface XmpRow {
  product: string;
  campaign: string;
  adset: string;
  channel: string;
  cost: number;
  impressions: number;
  clicks: number;
}

interface XmpCacheEntry {
  data: XmpRow[];
  fetchedAt: number;
  complete: boolean;
}

interface XmpFetchOptions {
  staleOk?: boolean;
  needAdset?: boolean;
}

const XMP_CACHE_TTL = 30 * 60 * 1000; // 30 min（完整）
const XMP_CACHE_TTL_SHORT = 5 * 60 * 1000; // 5 min（不完整）
// expires_at 写极远未来 → 缓存永不因窗口过期，历史行永久留存（当天刷新只看 fetchedAt）。
const XMP_CACHE_EXPIRES_AT = '9999-12-31T23:59:59Z';
const XMP_REQ_TIMEOUT = 30 * 1000;

/**
 * PWA 归集产品名。XMP 里 product_name 为空（PWA 投放未挂产品）以及 'Smart Reply'、
 * 'Savvy: Paid to Create' 这类 PWA 站点，统一归到这个名下，行照常写进 xmp_cache
 * （不再丢弃），但**不参与任何产品级口径**：
 * 汇总面板、渠道汇总、个人面板、快照 XMP 消耗均在聚合处跳过它，
 * 只有投手日报按 DAU 占比分摊 PWA 成本时才读它。
 * ⚠️ 必须与 packages/fetcher/src/xmp.ts 的 XMP_PWA_PRODUCT 逐字一致（两处写同一张 xmp_cache）。
 */
export const XMP_PWA_PRODUCT = 'PWA';

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
  'Mora: Unique Frequencies': 'Mora iOS',
  'Smart Reply': XMP_PWA_PRODUCT,
  'Savvy: Paid to Create': XMP_PWA_PRODUCT,
};

const XMP_CHANNEL_SHORT: Record<string, string> = { facebook: 'FB', google: 'GG', tiktok: 'TT' };
const XMP_CHANNELS = ['facebook', 'google', 'tiktok'];

// ===== 全局限速闸门 =====
// XMP Open API 限额约 10 QPM（每分钟 10 次，超限即返回 "request too frequently"）。旧看板实测
// 经验值（见 archive/ 下脚本）：调用间隔 12s、跨日 20s、命中限流后等 60~90s 让窗口复位。这里把
// 进程内所有 XMP 调用（报表 + 透传）串行 + 全局限速：相邻间隔 ≥ XMP_MIN_INTERVAL_MS；任一调用
// 命中限流即设全局冷却，期间所有排队调用一起暂停到窗口复位，避免「边退避边打满、窗口永不恢复」。
const XMP_MIN_INTERVAL_MS = 8000; // 相邻调用最小间隔（10 QPM 上限，取 ~7.5/min 留余量）
const XMP_COOLDOWN_MS = 60_000; // 命中限流后的全局冷却（对齐旧看板 60s 窗口复位）
const XMP_RATE_RETRY_MAX = 3;

let xmpGate: Promise<void> = Promise.resolve();
let xmpLastCallAt = 0;
let xmpCooldownUntil = 0; // 全局冷却截止时刻：命中限流后所有调用一起等到此刻

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 触发全局限流冷却：此后所有 XMP 调用暂停到 now + XMP_COOLDOWN_MS。 */
function tripXmpCooldown(): void {
  xmpCooldownUntil = Math.max(xmpCooldownUntil, Date.now() + XMP_COOLDOWN_MS);
}

/**
 * 把一次 XMP 网络调用串行化并纳入全局限速：进程内不并发、相邻间隔 ≥ XMP_MIN_INTERVAL_MS，
 * 且若处于全局冷却期则先等冷却结束。10 QPM 是硬上限，宁慢勿被封。
 */
async function runThrottled<T>(fn: () => Promise<T>): Promise<T> {
  const prev = xmpGate;
  let release!: () => void;
  // 本次调用成为新的队尾；下一个调用者会 await 我们持有的这把锁。
  xmpGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await prev;
    // 冷却优先，其次是最小间隔；两者取较晚者，直到都满足再发起。
    for (;;) {
      const now = Date.now();
      const wait = Math.max(xmpCooldownUntil - now, xmpLastCallAt + XMP_MIN_INTERVAL_MS - now);
      if (wait <= 0) break;
      await sleep(wait);
    }
    try {
      return await fn();
    } finally {
      xmpLastCallAt = Date.now();
    }
  } finally {
    release();
  }
}

/** XMP 是否因限流拒绝（"request too frequently" 及常见变体）。 */
function isRateLimited(resp: { code?: number | string; msg?: string }): boolean {
  if (resp.code === 0) return false;
  const msg = (resp.msg ?? '').toLowerCase();
  return (
    msg.includes('frequent') ||
    msg.includes('too many') ||
    msg.includes('rate limit') ||
    msg.includes('频繁')
  );
}

interface XmpSignedBody {
  timestamp: number;
  sign: string;
}

export function xmpSign(): XmpSignedBody {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = createHash('md5')
    .update(config.xmp.clientSecret + timestamp.toString())
    .digest('hex');
  return { timestamp, sign };
}

/** XMP Open API 原始响应（passthrough 用，保留全部字段）。 */
export interface XmpRawResponse {
  code?: number | string;
  msg?: string;
  [key: string]: unknown;
}

/**
 * 通用 XMP Open API POST —— 任意端点 path/body/headers。
 * 供 /api/ext/xmp-* 全量透传使用（30s 硬超时防上游挂起）。
 */
export async function xmpApiRequestPath(
  apiPath: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<XmpRawResponse> {
  return runThrottled(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, XMP_REQ_TIMEOUT);
    try {
      const resp = await fetch(`https://${config.xmp.apiHost}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await resp.text();
      try {
        return JSON.parse(text) as XmpRawResponse;
      } catch {
        throw new Error(`XMP non-JSON response: ${text.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  });
}

interface XmpReportRow {
  cost?: number;
  product_name?: string;
  campaign_name?: string;
  adset_name?: string;
  impression?: number;
  click?: number;
}

interface XmpApiResponse {
  code?: number;
  msg?: string;
  data?: { list?: XmpReportRow[] };
}

/** 单次报表 POST：自带新签名（供限流重试每次刷新 timestamp）。30s 硬超时防上游挂起。 */
async function xmpReportOnce(body: Record<string, unknown>): Promise<XmpApiResponse> {
  const { timestamp, sign } = xmpSign();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, XMP_REQ_TIMEOUT);
  try {
    const resp = await fetch(`https://${config.xmp.apiHost}/v2/media/account/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, timestamp, sign }),
      signal: controller.signal,
    });
    const text = await resp.text();
    try {
      return JSON.parse(text) as XmpApiResponse;
    } catch {
      throw new Error(`XMP non-JSON response: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 报表 POST：全局限速排队 + 命中限流触发全局冷却后重试。调用方无需再自带 timestamp/sign。 */
async function xmpApiRequest(body: Record<string, unknown>): Promise<XmpApiResponse> {
  let resp = await runThrottled(() => xmpReportOnce(body));
  for (let attempt = 1; attempt <= XMP_RATE_RETRY_MAX && isRateLimited(resp); attempt += 1) {
    tripXmpCooldown(); // 全局冷却：连同其它排队调用一起等 QPM 窗口复位，而非只退避自己
    console.warn(
      `[XMP API] rate limited (${resp.msg ?? ''}); global cooldown ${(XMP_COOLDOWN_MS / 1000).toString()}s, retry ${attempt.toString()}/${XMP_RATE_RETRY_MAX.toString()}`,
    );
    resp = await runThrottled(() => xmpReportOnce(body));
  }
  return resp;
}

/** 读缓存条目：未过期才返回（改永久后历史行天然全部命中，不再被 3 天窗口挡掉）。 */
async function getXmpCacheEntry(cacheKey: string): Promise<XmpCacheEntry | null> {
  const row = await queryOne<{ payload: XmpCacheEntry }>(
    'SELECT payload FROM xmp_cache WHERE cache_key = $1 AND expires_at > now()',
    [cacheKey],
  );
  return row?.payload ?? null;
}

/** 若某北京日缓存存在且不完整则删除，供 backfill 强制重拉（复刻旧 setXmpCacheEntry(key,null)）。 */
export async function purgeIncompleteXmpCache(date: string): Promise<void> {
  const cacheKey = `xmp-campaigns-${date}`;
  const cached = await getXmpCacheEntry(cacheKey);
  if (cached != null && !cached.complete) {
    await query('DELETE FROM xmp_cache WHERE cache_key = $1', [cacheKey]);
  }
}

export interface XmpDayCache {
  data: XmpRow[];
  fetchedAt: number;
}

/**
 * disk-only 批量读取某区间各北京日的 XMP 缓存（不触发 live fetch）。
 * 供 channel-summary 用：既取 cost 数据，也用 fetchedAt 作范围缓存指纹（复刻旧 mtime 指纹）。
 */
export async function loadXmpCacheRange(
  dates: readonly string[],
): Promise<Map<string, XmpDayCache>> {
  const map = new Map<string, XmpDayCache>();
  if (dates.length === 0) return map;
  const keys = dates.map((d) => `xmp-campaigns-${d}`);
  const rows = await query<{ cache_key: string; payload: XmpCacheEntry }>(
    'SELECT cache_key, payload FROM xmp_cache WHERE cache_key = ANY($1) AND expires_at > now()',
    [keys],
  );
  const prefixLen = 'xmp-campaigns-'.length;
  for (const row of rows) {
    map.set(row.cache_key.slice(prefixLen), {
      data: row.payload.data,
      fetchedAt: row.payload.fetchedAt,
    });
  }
  return map;
}

/**
 * 从 adset 级 xmp_cache（disk-only，不触发 live fetch）按 product 加总得出区间消耗。
 * 供 /api/data 用：汇总面板主表的 product 级 XMP 消耗与 channel-summary 同源（均自 adset 级加总）。
 * 返回 Map<product, cost>；缓存缺失的日期不计入（由调用方回退旧快照）。
 * PWA 行不计入——它只供投手日报分摊，不作为独立产品出现在面板上。
 */
export async function loadXmpProductCostRange(
  dates: readonly string[],
): Promise<Map<string, number>> {
  const map = await loadXmpCacheRange(dates);
  const byProduct = new Map<string, number>();
  for (const entry of map.values()) {
    for (const row of entry.data) {
      if (!row.product || row.product === XMP_PWA_PRODUCT) continue;
      byProduct.set(row.product, (byProduct.get(row.product) ?? 0) + row.cost);
    }
  }
  return byProduct;
}

/** 某单日 adset 级 xmp_cache 是否命中（未过期）。供 /api/data 判断是否需回退旧快照。 */
export async function hasXmpCache(date: string): Promise<boolean> {
  const map = await loadXmpCacheRange([date]);
  return map.has(date);
}

export interface XmpCacheReadResult {
  data: XmpRow[];
  fetchedAt: number;
  complete: boolean;
}

/**
 * 只读某北京日的 adgroup 级 XMP 缓存（**绝不触发 live fetch**），缺失返回 null。
 * 供对外接口 /api/ext/xmp 使用：当天=活缓存最新每小时值、历史=永久留存值，均直接读库。
 */
export async function readXmpCacheForDate(date: string): Promise<XmpCacheReadResult | null> {
  const entry = await getXmpCacheEntry(`xmp-campaigns-${date}`);
  if (!entry) return null;
  return { data: entry.data, fetchedAt: entry.fetchedAt, complete: entry.complete };
}

/** 写缓存条目，expires_at = 极远未来（永久留存；当天新鲜度由 payload.fetchedAt 判定）。 */
async function setXmpCacheEntry(cacheKey: string, entry: XmpCacheEntry): Promise<void> {
  await query(
    `INSERT INTO xmp_cache (cache_key, payload, expires_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
    [cacheKey, JSON.stringify(entry), XMP_CACHE_EXPIRES_AT],
  );
}

/**
 * 拉取某北京日的 XMP campaign 成本（复刻旧 fetchXmpCampaigns）。
 * 仅当 FB/GG/TT 三渠道都有花费时才作为「完整」长缓存；部分数据短缓存 5min。
 * needAdset：个人面板要求 adset 维度，旧缓存无 adset 时强制重拉。
 */
export async function fetchXmpCampaigns(
  date: string,
  options: XmpFetchOptions = {},
): Promise<XmpRow[]> {
  const { staleOk = false, needAdset = false } = options;
  const cacheKey = `xmp-campaigns-${date}`;
  const cached = await getXmpCacheEntry(cacheKey);

  const cachedHasAdset =
    cached != null &&
    Array.isArray(cached.data) &&
    (cached.data.length === 0 || cached.data.some((r) => 'adset' in r));
  const forceRefetch = needAdset && cached != null && !cachedHasAdset;
  if (forceRefetch) {
    console.log(`[XMP API] Cached ${date} predates adset dimension — forcing refetch`);
  } else if (cached != null) {
    if (cached.complete && Date.now() - cached.fetchedAt < XMP_CACHE_TTL) {
      return cached.data;
    }
    if (!cached.complete && Date.now() - cached.fetchedAt < XMP_CACHE_TTL_SHORT) {
      return cached.data;
    }
    if (staleOk && cached.data.length > 0) {
      const ageMin = Math.round((Date.now() - cached.fetchedAt) / 60_000);
      console.log(`[XMP API] Returning stale cache for ${date} (age ${ageMin.toString()} min)`);
      return cached.data;
    }
  }

  const allRows: XmpRow[] = [];
  let allChannelsOk = true;
  for (const channel of XMP_CHANNELS) {
    let page = 1;
    let channelOk = false;
    for (;;) {
      let resp: XmpApiResponse;
      try {
        resp = await xmpApiRequest({
          client_id: config.xmp.clientId,
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
        console.error(`[XMP API] ${channel} request error: ${(error as Error).message}`);
        allChannelsOk = false;
        break;
      }
      if (resp.code !== 0) {
        console.error(`[XMP API] ${channel} error: ${resp.msg ?? ''}`);
        allChannelsOk = false;
        break;
      }
      const list = resp.data?.list ?? [];
      if (list.length === 0) {
        channelOk = true;
        break;
      }
      channelOk = true;
      for (const row of list) {
        if ((row.cost ?? 0) > 0) {
          const xmpName = row.product_name ?? '';
          allRows.push({
            // product_name 为空 = PWA 投放未挂产品：归到 XMP_PWA_PRODUCT 保留下来，
            // 不能丢——丢了日报的 PWA 成本就没了（与 packages/fetcher/src/xmp.ts 同口径）。
            product: xmpName ? (XMP_PRODUCT_MAP[xmpName] ?? xmpName) : XMP_PWA_PRODUCT,
            campaign: (row.campaign_name ?? '').trim(),
            adset: (row.adset_name ?? '').trim(),
            channel: XMP_CHANNEL_SHORT[channel] ?? channel,
            cost: row.cost ?? 0,
            impressions: row.impression ?? 0,
            clicks: row.click ?? 0,
          });
        }
      }
      page++;
      if (page > 50) break;
    }
    if (!channelOk) allChannelsOk = false;
  }

  const channelsWithCost = new Set(allRows.map((r) => r.channel));
  const allChannelsHaveData = ['FB', 'GG', 'TT'].every((ch) => channelsWithCost.has(ch));

  // 部分渠道本次没抓到（如 GG 限流失败）：用旧缓存里缺失渠道的行补齐，绝不让某渠道
  // 在缓存里凭空消失（与 scheduler 端 fetchXmpCampaignsToCache 的保护一致）。补齐结果
  // 既用于写缓存，也作为本次返回值，保证当前请求不缺 GG。
  let resultRows = allRows;
  if (allChannelsOk && allChannelsHaveData) {
    await setXmpCacheEntry(cacheKey, { data: allRows, fetchedAt: Date.now(), complete: true });
  } else if (allRows.length > 0 && !allChannelsHaveData) {
    const preserved = [...allRows];
    const preservedChannels: string[] = [];
    if (cached != null && Array.isArray(cached.data)) {
      for (const ch of ['FB', 'GG', 'TT']) {
        if (!channelsWithCost.has(ch)) {
          const chRows = cached.data.filter((r) => r.channel === ch);
          if (chRows.length > 0) {
            preserved.push(...chRows);
            preservedChannels.push(ch);
          }
        }
      }
    }
    if (preservedChannels.length > 0) {
      console.warn(
        `[XMP API] ${date}: channels [${preservedChannels.join(',')}] missing this fetch — preserved from cache`,
      );
    }
    resultRows = preserved;
    await setXmpCacheEntry(cacheKey, { data: preserved, fetchedAt: Date.now(), complete: false });
  }
  if (forceRefetch && allRows.length === 0 && cached.data.length > 0) {
    console.log(
      `[XMP API] Forced refetch for ${date} returned no rows — falling back to cached (adset-less) cost`,
    );
    return cached.data;
  }
  console.log(
    `[XMP API] Fetched ${allRows.length.toString()} campaigns for ${date} (complete: ${allChannelsOk.toString()})`,
  );
  return resultRows;
}
