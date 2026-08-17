/**
 * eLTV 倍率 —— 复刻旧 dashboard/server.js 的 /api/eltv-multipliers。
 * 双指数拟合 f(t)=a1·e^{-l1(t-1)}+(1-a1)·e^{-l2(t-1)}，D30 未折现累加，按产品×渠道。
 * 缓存迁到 PG eltv_cache：key='cache'（按日期分桶的结果）、key='hwm'（置信度高水位线）。
 * SQLite→PG：julianday 差 → FLOOR(EXTRACT(EPOCH ...)/86400)；月表枚举 pg_tables；
 *   revenue 双精度直接取；event_time/install_time 文本列按原语义（af 为 UTC 串，ad 为 epoch 串）。
 */

import { query, queryOne } from '@agentic-ug/db';

type Confidence = 'green' | 'yellow' | 'red';
type Params = [number, number, number];

interface EltvProductCfg {
  af: string[];
  ad: string[];
}

export type EltvChannelResult =
  | { d180: null }
  | { d180: null; records: number; d1Span: number }
  | { d180: number; params: number[]; records: number; d1Span: number; confidence: Confidence };

export type EltvMultipliers = Record<string, Record<string, EltvChannelResult>>;

export interface EltvCacheEntry {
  date: string;
  multipliers: EltvMultipliers;
}

type EltvCache = Record<string, EltvCacheEntry>;
type HwmMap = Record<string, Confidence>;

// eLTV 各产品×渠道数据源规则：每产品定义按渠道查询的 event_name + app_ids。
const ELTV_PRODUCTS: Record<string, EltvProductCfg> = {
  'Dora And': { af: ['com.doramatch.app'], ad: [] },
  'Dora iOS': { af: ['id6746109957'], ad: [] },
  'Romi iOS': { af: ['id6746782904'], ad: ['6746782904'] }, // FB=AD, TT=AF
  'Jovia And': { af: ['com.qiga.vio'], ad: [] },
  Doni: { af: ['com.doni.appa'], ad: [] },
  'Romi And': { af: ['com.romiandroid.appmatch'], ad: [] },
  GraceChat: { af: ['id1658972379'], ad: [] },
  'Kira iOS': { af: ['id6759697686'], ad: [] },
  'Kira And': { af: ['com.meraki.kira'], ad: [] },
  'Nalo And': { af: ['com.cavalier.nalo'], ad: [] },
  'Ruby And': { af: ['com.rubymatch.app'], ad: [] },
  Luma: { af: [], ad: ['6746466099'] }, // All channels from AD
  'Mora iOS': { af: ['id6761983452'], ad: [] },
};

// 渠道映射（organic 排除，restricted→FB）。
const ELTV_CHANNEL_MAP: Record<string, 'FB' | 'GG' | 'TT' | null> = {
  'Facebook Ads': 'FB',
  'Facebook+Installs': 'FB',
  'Instagram+Installs': 'FB',
  'Off-Facebook+Installs': 'FB',
  'Facebook+web': 'FB',
  'Luma+ios+FB+W2A': 'FB',
  restricted: 'FB',
  Unattributed: 'FB',
  Social_facebook: 'FB',
  googleadwords_int: 'GG',
  'Google Ads ACI': 'GG',
  'Google+Ads+ACI': 'GG',
  tiktokglobal_int: 'TT',
  'TikTok+SAN': 'TT',
  'TikTok SAN': 'TT',
  organic: null,
  Organic: null,
};

function mapEltvChannel(src: string | null | undefined): 'FB' | 'GG' | 'TT' | null {
  if (!src) return null;
  const mapped = ELTV_CHANNEL_MAP[src];
  if (mapped !== undefined) return mapped;
  const lower = src.toLowerCase();
  if (lower.includes('w2a') || lower.includes('web')) return 'FB';
  return null;
}

interface EltvQuery {
  event: string;
  appIds: string[];
  type: 'af' | 'ad';
}

/** 某产品×渠道组合的查询定义（复刻 getEltvQueries）。 */
function getEltvQueries(product: string, channel: string): EltvQuery[] {
  const p = ELTV_PRODUCTS[product];
  if (!p) return [];
  if (product === 'Romi iOS') {
    if (channel === 'FB') return [{ event: 'ad_purchase', appIds: p.ad, type: 'ad' }];
    if (channel === 'TT') return [{ event: 'af_purchase', appIds: p.af, type: 'af' }];
    return []; // GG: no data
  }
  if (product === 'Luma') {
    return [{ event: 'ad_purchase', appIds: p.ad, type: 'ad' }]; // All channels from AD
  }
  if (p.af.length === 0) return [];
  return [{ event: 'af_purchase', appIds: p.af, type: 'af' }];
}

/**
 * 双指数拟合（梯度下降，3 参数 [a1,l1,l2]）。逐字对齐旧 fitDoubleExp：
 * 初值 [0.75,2,0.05]，lr 自适应，bounds 约束，50000 步。
 */
function fitDoubleExp(xArr: number[], yArr: number[]): Params {
  const n = xArr.length;
  const f = (t: number, p: Params): number => {
    const [a1, l1, l2] = p;
    return a1 * Math.exp(-l1 * (t - 1)) + (1 - a1) * Math.exp(-l2 * (t - 1));
  };
  const loss = (p: Params): number => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const r = (yArr[i] ?? 0) - f(xArr[i] ?? 0, p);
      s += r * r;
    }
    return s;
  };
  let p: Params = [0.75, 2, 0.05];
  let lr = 1e-4;
  const bounds: [number, number][] = [
    [0.3, 0.95],
    [0.5, 15],
    [0.005, 0.5],
  ];
  for (let iter = 0; iter < 50_000; iter++) {
    const eps = 1e-6;
    const grad = p.map((_, i) => {
      const pp = p.map((v, j) => (j === i ? v + eps : v)) as Params;
      const pm = p.map((v, j) => (j === i ? v - eps : v)) as Params;
      return (loss(pp) - loss(pm)) / (2 * eps);
    });
    const newP = p.map((pi, i) => {
      const [lo, hi] = bounds[i] ?? [0, 1];
      return Math.max(lo, Math.min(hi, pi - lr * (grad[i] ?? 0)));
    }) as Params;
    if (loss(newP) < loss(p)) {
      p = newP;
      lr *= 1.05;
    } else {
      lr *= 0.5;
    }
    if (lr < 1e-12) break;
  }
  return p;
}

/** D30 未折现 LTV 倍率（拟合日收入累加，d=1..30）。 */
function computeD30Ltv(params: Params): number {
  const [a1, l1, l2] = params;
  const a2 = 1 - a1;
  let ltv = 0;
  for (let d = 1; d <= 30; d++) {
    ltv += a1 * Math.exp(-l1 * (d - 1)) + a2 * Math.exp(-l2 * (d - 1));
  }
  return ltv;
}

function confidenceRank(c: Confidence): number {
  if (c === 'green') return 2;
  if (c === 'yellow') return 1;
  return 0;
}

/** 置信度高水位线：一旦达到某等级永不回落（就地更新 hwm 映射）。 */
function applyConfidenceHWM(hwm: HwmMap, key: string, computed: Confidence): Confidence {
  const prev = hwm[key] ?? 'red';
  const best = confidenceRank(computed) >= confidenceRank(prev) ? computed : prev;
  hwm[key] = best;
  return best;
}

async function loadEltvCache(): Promise<EltvCache> {
  const row = await queryOne<{ payload: EltvCache }>(
    "SELECT payload FROM eltv_cache WHERE key = 'cache'",
  );
  return row?.payload ?? {};
}

async function saveEltvCache(cache: EltvCache): Promise<void> {
  await query(
    `INSERT INTO eltv_cache (key, payload)
     VALUES ('cache', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [JSON.stringify(cache)],
  );
}

async function loadHwm(): Promise<HwmMap> {
  const row = await queryOne<{ payload: HwmMap }>(
    "SELECT payload FROM eltv_cache WHERE key = 'hwm'",
  );
  return row?.payload ?? {};
}

async function saveHwm(hwm: HwmMap): Promise<void> {
  await query(
    `INSERT INTO eltv_cache (key, payload)
     VALUES ('hwm', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [JSON.stringify(hwm)],
  );
}

interface EltvRow {
  install_time: string;
  revenue: number;
  media_source: string | null;
  day_num: number;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * 计算全产品×渠道 D30 倍率。窗口用「当前北京时间」滚动 30 天（复刻原逻辑：
 * 与请求的 date 无关，date 仅作缓存键）。就地更新 hwm。
 */
async function computeMultipliers(hwm: HwmMap): Promise<EltvMultipliers> {
  const multipliers: EltvMultipliers = {};

  // 北京「今天」往前 30 天。+8h 后一律取 UTC 分量、并用 Date.UTC 构造，全程与系统时区解耦：
  // 原写法混用了本地分量(getFullYear…)与 UTC 输出(toISOString)，仅在容器 TZ=UTC 时才恰好正确。
  const now = new Date(Date.now() + 8 * 3_600_000);
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 30));
  const installCutoff = cutoff.toISOString().slice(0, 10);
  const adCutoffTs = Math.floor(
    (new Date(`${installCutoff}T00:00:00Z`).getTime() - 8 * 3_600_000) / 1000,
  ).toString();

  const minTable = `records_${installCutoff.slice(0, 4)}${installCutoff.slice(5, 7)}`;
  const tableRows = await query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename LIKE 'records_%' AND tablename >= $1
     ORDER BY tablename`,
    [minTable],
  );
  const tables = tableRows.map((r) => r.tablename);
  const CHANNELS = ['FB', 'GG', 'TT'];

  for (const product of Object.keys(ELTV_PRODUCTS)) {
    const perChannel: Record<string, EltvChannelResult> = {};
    for (const ch of CHANNELS) {
      const queries = getEltvQueries(product, ch);
      if (queries.length === 0) {
        perChannel[ch] = { d180: null };
        continue;
      }

      const dayRevenue = new Map<number, number>();
      const dayCohorts = new Map<number, Set<string>>();
      let totalRecords = 0;

      for (const q of queries) {
        for (const appId of q.appIds) {
          for (const table of tables) {
            const rows =
              q.type === 'af'
                ? await query<EltvRow>(
                    `SELECT install_time, revenue, media_source,
                       (FLOOR(EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 86400) + 1)::int as day_num
                     FROM ${table}
                     WHERE app_id = $1 AND event_name = 'af_purchase'
                       AND install_time >= $2 AND revenue > 0 AND event_time >= install_time`,
                    [appId, installCutoff],
                  )
                : await query<EltvRow>(
                    `SELECT install_time, revenue, media_source,
                       ((event_time::bigint - install_time::bigint) / 86400 + 1)::int as day_num
                     FROM ${table}
                     WHERE app_id = $1 AND event_name = 'ad_purchase'
                       AND install_time >= $2 AND revenue > 0
                       AND event_time::bigint >= install_time::bigint`,
                    [appId, adCutoffTs],
                  );
            for (const row of rows) {
              if (mapEltvChannel(row.media_source) !== ch) continue;
              const d = row.day_num;
              if (d < 1 || d > 220) continue;
              totalRecords++;
              dayRevenue.set(d, (dayRevenue.get(d) ?? 0) + row.revenue);
              const installDate =
                q.type === 'af'
                  ? row.install_time.slice(0, 10)
                  : new Date((Number.parseInt(row.install_time, 10) + 8 * 3600) * 1000)
                      .toISOString()
                      .slice(0, 10);
              let cohort = dayCohorts.get(d);
              if (!cohort) {
                cohort = new Set<string>();
                dayCohorts.set(d, cohort);
              }
              cohort.add(installDate);
            }
          }
        }
      }

      const day1Rev = dayRevenue.get(1);
      const day1Cohort = dayCohorts.get(1);
      if (!day1Rev || !day1Cohort || totalRecords < 5) {
        perChannel[ch] = { d180: null, records: totalRecords, d1Span: 0 };
        continue;
      }

      const d1PerCohort = day1Rev / day1Cohort.size;
      const xArr: number[] = [];
      const yArr: number[] = [];
      for (let d = 1; d <= 220; d++) {
        const cohort = dayCohorts.get(d);
        if (!cohort || cohort.size === 0) continue;
        yArr.push((dayRevenue.get(d) ?? 0) / cohort.size / d1PerCohort);
        xArr.push(d);
      }

      const params = fitDoubleExp(xArr, yArr);
      const d180 = computeD30Ltv(params);
      const d1Span = day1Cohort.size;
      let rawConf: Confidence = 'red';
      if (d1Span >= 30) rawConf = 'green';
      else if (d1Span >= 10) rawConf = 'yellow';
      const confidence = applyConfidenceHWM(hwm, `${product}_${ch}`, rawConf);
      perChannel[ch] = {
        d180,
        params: params.map((v) => round4(v)),
        records: totalRecords,
        d1Span,
        confidence,
      };
    }
    multipliers[product] = perChannel;
  }

  return multipliers;
}

/**
 * campaign-context 用的 per-channel D30 静态兜底（缓存无值时用）。
 * 逐字对齐旧 server.js 的 eltvStaticByChannel。
 */
const ELTV_STATIC_BY_CHANNEL: Record<string, Record<string, { d180: number }>> = {
  'Dora iOS': { FB: { d180: 1.75 }, TT: { d180: 2.62 } },
  'Romi iOS': { FB: { d180: 1.97 }, TT: { d180: 1.71 } },
  Luma: { FB: { d180: 2.18 }, TT: { d180: 2.12 } },
  GraceChat: { FB: { d180: 1.89 } },
  'Dora And': { FB: { d180: 8.44 }, GG: { d180: 20.31 } },
  'Jovia And': { FB: { d180: 4.18 }, GG: { d180: 6.8 }, TT: { d180: 4.39 } },
  Doni: { FB: { d180: 2.59 }, GG: { d180: 3.36 }, TT: { d180: 3.24 } },
  'Kira And': { FB: { d180: 2.61 }, GG: { d180: 2.34 }, TT: { d180: 4.57 } },
  'Nalo And': { FB: { d180: 7.76 }, TT: { d180: 18.24 } },
};

export interface ContextEltv {
  d180: number | null;
  confidence: Confidence;
}

/** 取最近一天缓存里某产品的 per-channel 倍率（无则 null）。 */
function latestCachedForProduct(
  cache: EltvCache,
  product: string,
): Record<string, EltvChannelResult> | null {
  const dates = Object.keys(cache).sort().reverse();
  for (const d of dates) {
    const m = cache[d]?.multipliers[product];
    if (m) return m;
  }
  return null;
}

/**
 * 解析某产品×渠道用于 campaign-context 的 eLTV D180 与置信度（含 HWM 持久化）。
 * 优先取最近缓存值，缺失用静态兜底；均无则置信度 red、d180 null。复刻旧 eltv 计算块。
 */
export async function resolveContextEltv(product: string, channel: string): Promise<ContextEltv> {
  const cache = await loadEltvCache();
  const cachedForProduct = latestCachedForProduct(cache, product);
  const staticByChannel = ELTV_STATIC_BY_CHANNEL[product] ?? null;
  const campChannel = channel === '' ? 'FB' : channel;
  const eltvInfo = cachedForProduct?.[campChannel] ?? staticByChannel?.[campChannel] ?? null;

  const hwm = await loadHwm();
  const hwmKey = `${product}_${campChannel}`;
  const d180Val = eltvInfo?.d180 ?? null;

  let result: ContextEltv;
  if (d180Val != null && d180Val > 0) {
    const d180 = Math.round(d180Val * 100) / 100;
    const info = eltvInfo as { confidence?: Confidence; d1Span?: number };
    if (info.confidence) {
      result = { d180, confidence: applyConfidenceHWM(hwm, hwmKey, info.confidence) };
    } else {
      const d1span = info.d1Span ?? 0;
      let rawConf: Confidence = 'red';
      if (d1span >= 30) rawConf = 'green';
      else if (d1span >= 10) rawConf = 'yellow';
      result = { d180, confidence: applyConfidenceHWM(hwm, hwmKey, rawConf) };
    }
  } else {
    result = { d180: null, confidence: applyConfidenceHWM(hwm, hwmKey, 'red') };
  }
  await saveHwm(hwm);
  return result;
}

/** 取某日期 eLTV 倍率（缓存命中直接返回，否则现算并写回 PG）。 */
export async function getEltvMultipliers(date: string): Promise<EltvCacheEntry> {
  const cache = await loadEltvCache();
  const hit = cache[date];
  if (hit) return hit;

  const hwm = await loadHwm();
  const multipliers = await computeMultipliers(hwm);
  const entry: EltvCacheEntry = { date, multipliers };
  cache[date] = entry;
  await saveEltvCache(cache);
  await saveHwm(hwm);
  return entry;
}

/**
 * 只读某日期 eLTV 倍率缓存（**绝不触发现算/写库**），缺失返回 null。
 * 供对外接口 /api/ext/eltv 使用：只读 eltv_cache 按日期分桶的结果，纯读不写。
 */
export async function readCachedEltvMultipliers(date: string): Promise<EltvCacheEntry | null> {
  const cache = await loadEltvCache();
  return cache[date] ?? null;
}
