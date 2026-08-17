/**
 * 汇总抓取 —— 复刻旧 dashboard/fetcher.js 的 fetchAll。
 * Athena 收入 API（直连 HTTPS）+ XMP 汇总（原生 TS，见 ./xmp），结果按北京自然日
 * 追加进 PG daily_snapshots(kind='main')，替代旧 data/{date}.json。
 * AF 数据已改由 /api/af-summary 走库查询，这里仅保留状态位以对齐旧 UI。
 */

import { get as httpsGet } from 'node:https';

import { query, queryOne } from '@agentic-ug/db';

import type { FetchStatus } from './status.js';
import { isFetchLockStale, readFetchStatus, writeFetchStatus } from './status.js';
import { fetchXmpCampaignsToCache, readXmpProductCostFromCache } from './xmp.js';

const ATHENA_API_URL =
  process.env['ATHENA_API_URL'] ?? 'https://admin-api-prod.sitin.ai/api/open/admin/revenue';
const ATHENA_API_KEY = process.env['ATHENA_API_KEY'] ?? '';
const ATHENA_MAX_RETRIES = 5;
const ATHENA_RETRY_DELAY = 10_000;

const PRODUCT_NAME_MAP: Record<string, string> = {
  Dora: 'Dora iOS',
  'Dora iOS': 'Dora iOS',
  Romi: 'Romi iOS',
  'Romi iOS': 'Romi iOS',
  GraceChat: 'GraceChat',
  'Dora And': 'Dora And',
  Doni: 'Doni',
  'Romi And': 'Romi And',
  Luma: 'Luma',
  'Jovia And': 'Jovia And',
  'Kira And': 'Kira And',
  'Kira iOS': 'Kira iOS',
  'Nalo And': 'Nalo And',
  'Ruby And': 'Ruby And',
  Kira: 'Kira iOS',
  'Kira: Creative Community': 'Kira iOS',
  'Kira: Find Your Romance': 'Kira And',
  'Nalo: Meet, Swipe & Chat': 'Nalo And',
  'Ruby: Meet, Chat & Date': 'Ruby And',
  'Kira: Face Effects': 'Kira iOS',
  'Mora iOS': 'Mora iOS',
};

const ATHENA_API_NAME_MAP: Record<string, string> = {
  Dora: 'Dora iOS',
  Romi: 'Romi iOS',
  Kira: 'Kira iOS',
  'Dora Android': 'Dora And',
  'Romi Android': 'Romi And',
  'Jovia Android': 'Jovia And',
  'Kira Android': 'Kira And',
  'Nalo Android': 'Nalo And',
  'Ruby Android': 'Ruby And',
  GraceChat: 'GraceChat',
  // 服务端迁移后 GraceChat 收入被拆成 GraceChat + gcv2 两条，
  // 两者都归并到同一产品名，由下方 mergeAthenaByProduct 求和。
  gcv2: 'GraceChat',
  Luma: 'Luma',
  Doni: 'Doni',
  Mora: 'Mora iOS',
};

const ATHENA_API_IGNORE = new Set(['Haven', 'Aura', 'AI Fantasy', 'Lovia', 'Elara']);

export interface AthenaItem {
  product: string;
  totalRevenue: number;
  newUserRevenue: number;
}

export interface AthenaResult {
  products: AthenaItem[];
  pwaWithdrawal: number;
}

export interface XmpSummaryItem {
  product: string;
  cost: number;
}

interface MainSnapshot {
  time: string;
  athena: AthenaItem[] | null;
  af: null;
  xmp: XmpSummaryItem[] | null;
  pwaWithdrawal: number | null;
}

interface MainDayData {
  date: string;
  snapshots: MainSnapshot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function prop(obj: unknown, key: string): unknown {
  return isRecord(obj) ? obj[key] : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeProductName(name: string): string {
  return PRODUCT_NAME_MAP[name] ?? name;
}

/**
 * 合并同名产品的收入（totalRevenue / newUserRevenue 分别求和）。
 * 用于服务端迁移后 GraceChat 被拆成 GraceChat + gcv2 两条 appName 的场景：
 * 二者经 ATHENA_API_NAME_MAP 都归一到 'GraceChat'，此处再按产品名累加为一条。
 * 保持首次出现顺序，通用于任何未来出现的同名拆分。
 */
function mergeAthenaByProduct(items: AthenaItem[]): AthenaItem[] {
  const result: AthenaItem[] = [];
  const byProduct = new Map<string, AthenaItem>();
  for (const item of items) {
    const existing = byProduct.get(item.product);
    if (existing) {
      existing.totalRevenue += item.totalRevenue;
      existing.newUserRevenue += item.newUserRevenue;
    } else {
      const copy = { ...item };
      byProduct.set(item.product, copy);
      result.push(copy);
    }
  }
  return result;
}

function parseMoney(val: unknown): number {
  if (val == null || val === 'N/A' || val === 'Error') return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val !== 'string') return 0;
  const cleaned = val.replaceAll(/[$,USD\s]/g, '');
  const num = Number.parseFloat(cleaned);
  return Number.isNaN(num) ? 0 : num;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** 把某北京时刻的 Date（已 +8h 偏移）按北京自然日格式化。 */
function ymdBeijing(offsetDate: Date): string {
  return `${offsetDate.getUTCFullYear().toString()}-${pad2(offsetDate.getUTCMonth() + 1)}-${pad2(offsetDate.getUTCDate())}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchAthenaApiRaw(dateStr: string | null): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const url = dateStr === null ? ATHENA_API_URL : `${ATHENA_API_URL}?date=${dateStr}`;
    const req = httpsGet(
      url,
      { headers: { Authorization: `Bearer ${ATHENA_API_KEY}` }, timeout: 15_000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += String(chunk);
        });
        res.on('end', () => {
          try {
            const json: unknown = JSON.parse(body);
            if (!isRecord(json) || json['success'] !== true) {
              reject(new Error(`Athena API error: ${body.slice(0, 200)}`));
              return;
            }
            resolvePromise(json['data']);
          } catch (error) {
            reject(new Error(`Athena parse error: ${(error as Error).message}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Athena API timeout'));
    });
  });
}

/** 拉取 Athena 收入，失败重试 5 次；就地更新 status.sources.athena。 */
async function fetchAthenaApi(
  dateStr: string | null,
  status: FetchStatus,
): Promise<AthenaResult | null> {
  status.sources.athena.status = 'fetching';
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= ATHENA_MAX_RETRIES; attempt += 1) {
    try {
      const data = await fetchAthenaApiRaw(dateStr);
      const mapped = asArray(prop(data, 'products'))
        .filter((p) => !ATHENA_API_IGNORE.has(asString(prop(p, 'appName'))))
        .map((p) => {
          const appName = asString(prop(p, 'appName'));
          return {
            product: ATHENA_API_NAME_MAP[appName] ?? normalizeProductName(appName),
            totalRevenue: parseMoney(prop(p, 'totalRevenue')),
            newUserRevenue: parseMoney(prop(p, 'newUserRevenue')),
          };
        });
      // 同一产品名的多条记录求和（如 GraceChat 迁移后被拆成 GraceChat + gcv2），
      // 保持返回顺序为各产品首次出现的顺序。
      const products = mergeAthenaByProduct(mapped);
      const pwaWithdrawal = parseMoney(prop(prop(data, 'pwaWithdrawal'), 'total'));
      const nowIso = new Date().toISOString();
      status.sources.athena.status = 'success';
      status.sources.athena.lastSuccess = nowIso;
      status.sources.athena.lastTime = nowIso;
      return { products, pwaWithdrawal };
    } catch (error) {
      lastErr = error as Error;
      if (attempt < ATHENA_MAX_RETRIES) {
        console.error(
          `[Fetcher] Athena attempt ${attempt.toString()}/${ATHENA_MAX_RETRIES.toString()} failed: ${lastErr.message}, retrying...`,
        );
        await sleep(ATHENA_RETRY_DELAY);
      }
    }
  }
  const nowIso = new Date().toISOString();
  status.sources.athena.status = 'error';
  status.sources.athena.lastError = lastErr?.message ?? 'unknown';
  status.sources.athena.lastTime = nowIso;
  console.error(`[Fetcher] Athena failed after ${ATHENA_MAX_RETRIES.toString()} attempts`);
  return null;
}

/**
 * 整点抓取 adset 级 XMP 成本并写入 xmp_cache：个人面板直接命中，
 * 汇总面板（/api/data + channel-summary）亦由该缓存加总得出 product 级消耗。
 * 就地更新 status.sources.xmp。替代原 product 级 fetchXmpSummary——
 * 不再单独抓 product 级、不再写快照 xmp 字段。
 */
async function warmXmpAdsetCache(targetDate: string | null, status: FetchStatus): Promise<void> {
  status.sources.xmp.status = 'fetching';
  try {
    const result = await fetchXmpCampaignsToCache(targetDate);
    const nowIso = new Date().toISOString();
    status.sources.xmp.status = 'success';
    status.sources.xmp.lastSuccess = nowIso;
    status.sources.xmp.lastTime = nowIso;
    console.log(
      `[Fetcher] XMP adset cache warmed for ${result.date}: ${result.rows.toString()} rows (complete: ${result.complete.toString()})`,
    );
  } catch (error) {
    const nowIso = new Date().toISOString();
    status.sources.xmp.status = 'error';
    status.sources.xmp.lastError = (error as Error).message;
    status.sources.xmp.lastTime = nowIso;
    console.error(`[Fetcher] XMP adset cache warm failed: ${(error as Error).message}`);
  }
}

/** 把快照按北京日追加进 daily_snapshots(kind='main')（复刻旧 loadDayData→push→saveDayData）。 */
async function appendMainSnapshot(date: string, snapshot: MainSnapshot): Promise<void> {
  const existing = await queryOne<{ payload: MainDayData }>(
    "SELECT payload FROM daily_snapshots WHERE kind = 'main' AND date = $1",
    [date],
  );
  const dayData: MainDayData = existing?.payload ?? { date, snapshots: [] };
  dayData.snapshots.push(snapshot);
  await query(
    `INSERT INTO daily_snapshots (kind, date, payload)
     VALUES ('main', $1, $2)
     ON CONFLICT (kind, date) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [date, JSON.stringify(dayData)],
  );
}

/**
 * 主抓取：整点抓当日实时；北京 0 点抓昨日收尾（复刻旧 fetchAll 的 hour===0 分支）。
 * 通过 PG fetch_status 做跨进程并发保护（isFetching）。
 */
export async function fetchAll(): Promise<void> {
  const status = await readFetchStatus('main');
  // isFetching=true 且锁未超时：确有另一个 Job 在跑，skip；若锁已超时（崩溃残留）则抢锁继续。
  if (status.isFetching && !isFetchLockStale(status)) {
    console.log('[Fetcher] Already fetching, skipping...');
    return;
  }
  if (status.isFetching) {
    console.warn(
      `[Fetcher] Stale fetch lock detected (started ${status.fetchStartedAt ?? 'unknown'}), reclaiming...`,
    );
  }
  status.isFetching = true;
  status.fetchStartedAt = new Date().toISOString();
  await writeFetchStatus(status, 'main');

  const nowIso = new Date().toISOString();
  const beijingNow = new Date(Date.now() + 8 * 3_600_000);
  const hour = beijingNow.getUTCHours();

  let targetDate: string;
  let xmpDate: string | null;
  if (hour === 0) {
    const beijingYesterday = new Date(Date.now() + 8 * 3_600_000 - 86_400_000);
    targetDate = ymdBeijing(beijingYesterday);
    xmpDate = targetDate;
    console.log(`[Fetcher] Midnight fetch: yesterday ${targetDate}`);
  } else {
    targetDate = ymdBeijing(beijingNow);
    xmpDate = null;
    console.log(`[Fetcher] Hourly fetch: today ${targetDate}`);
  }

  const athenaResult = await fetchAthenaApi(hour === 0 ? targetDate : null, status);
  const athena = athenaResult?.products ?? null;
  const pwaWithdrawal = athenaResult?.pwaWithdrawal ?? null;
  // XMP 改为整点抓 adset 级并写 xmp_cache（个人面板直接命中，汇总面板 /api/data +
  // channel-summary 由该缓存加总得出 product 级消耗），不再单独抓 product 级。
  await warmXmpAdsetCache(xmpDate, status);
  // 本次刚写进 xmp_cache 的 adset 数据按 product 加总成 product 级消耗，一并入快照，
  // 使当日趋势的「XMP 消耗」曲线与前一天同比生效（与看板 loadXmpProductCostRange 同口径）。
  // hour!==0 时 warmXmpAdsetCache(null) 抓当日→cache_key=当日=targetDate；
  // hour===0 时 xmpDate=targetDate=昨日→cache_key=昨日=targetDate；两分支读回 key 均为 targetDate。
  const xmpCost = await readXmpProductCostFromCache(targetDate);
  const xmpSummary = xmpCost.length > 0 ? xmpCost : null;

  // AF 现由 /api/af-summary 走库查询，这里仅保留成功状态以对齐旧 UI。
  const afIso = new Date().toISOString();
  status.sources.af.status = 'success';
  status.sources.af.lastSuccess = afIso;
  status.sources.af.lastTime = afIso;

  // athena 或 xmp 任一非空即写快照：即便某次 athena 抓取失败，XMP 消耗时序也不丢点。
  if (athena || xmpSummary) {
    await appendMainSnapshot(targetDate, {
      time: nowIso,
      athena,
      af: null,
      xmp: xmpSummary,
      pwaWithdrawal,
    });
    console.log(`[Fetcher] Snapshot saved for ${targetDate}`);
  }

  status.isFetching = false;
  status.fetchStartedAt = null;
  status.lastFetchTime = nowIso;
  status.lastFetchSuccess = Boolean(athena);
  await writeFetchStatus(status, 'main');
}
