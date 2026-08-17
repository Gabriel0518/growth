/**
 * 修正系数 —— 全仓库唯一真源。
 *
 * factor = 某北京自然日的 athena 收入 / 同日付费渠道（非 organic）收入。
 * Android 直接用 af_purchase 非 organic 收入作分母，产出标量；
 * iOS 因 SKAN 归因低报，FB 渠道先乘固定倍率再作分母，产出 { fb, other } 分渠道系数。
 *
 * 【为什么放在 core】此前本文件的映射表与计算主体在两处各存一份：
 *   写侧 packages/fetcher/src/correction.ts（scheduler 每日写库）
 *   读侧 apps/web/src/lib/dashboard/correction-factors.ts（看板读取、缺失现算）
 * 靠注释约定「必须逐字一致」维护，实际漂移过两次：一次是 FB 倍率调整需要手工同步两侧，
 * 一次是 Mora iOS 上线只改了读侧（commit 87390f5），导致写库快照里始终没有 Mora，
 * 所有读持久化的下游（飞书日报、/api/daily-report、/api/ext/correction-factors）
 * 都静默兜底成 1，而现算路径又是对的，同一产品出现两套值且两周无人察觉。
 * 现收敛到本模块，两侧只做薄封装，映射表与公式不可能再分叉。
 *
 * 【为什么用依赖注入】core 是零运行时依赖的纯逻辑包。这里不 import @agentic-ug/db，
 * 而由调用方传入 query/queryOne，保持 core 可被任意执行环境（Next.js / Node CLI）复用。
 */

import { beijingDayBounds, tableForMonth } from './tables.js';

/**
 * 数据库访问注入点，直接接受 @agentic-ug/db 的 query/queryOne。
 * 刻意不带泛型：db 侧的类型参数约束在 pg.QueryResultRow 上，core 不依赖 pg 类型，
 * 两边泛型约束无法互相赋值。行类型在下面各查询处按 SQL select 列断言——
 * 数据库返回值本就是运行时形状，断言集中在这一层边界即可。
 */
export interface CorrectionDb {
  query: (text: string, params?: readonly unknown[]) => Promise<unknown[]>;
  queryOne: (text: string, params?: readonly unknown[]) => Promise<unknown>;
}

/** af_purchase 的 app_id（带 id 前缀）→ 产品名。 */
export const ANDROID_APP_IDS: Record<string, string> = {
  'com.doramatch.app': 'Dora And',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
  'com.rubymatch.app': 'Ruby And',
};

/** iOS af_purchase 的 app_id（带 id 前缀）→ 产品名。 */
export const IOS_AF_APP_IDS: Record<string, string> = {
  id6746109957: 'Dora iOS',
  id6746782904: 'Romi iOS',
  id6746466099: 'Luma',
  id1658972379: 'GraceChat',
  id6761983452: 'Mora iOS',
};

/** iOS ad_purchase 的 app_id（纯数字）→ 产品名，与 IOS_AF_APP_IDS 一一对应。 */
export const IOS_AD_APP_IDS: Record<string, string> = {
  '6746109957': 'Dora iOS',
  '6746782904': 'Romi iOS',
  '6746466099': 'Luma',
  '1658972379': 'GraceChat',
  '6761983452': 'Mora iOS',
};

/**
 * iOS FB 渠道固定低报倍率：SKAN 归因下 FB 上报收入系统性偏低，先按经验倍率放大再求 base。
 * 未列出的产品取 1（如 Mora iOS——其收入 99% 来自 FB，倍率只影响 fb/other 的拆分比例，
 * 对 FB 渠道最终系数近乎无影响，故暂不设定；若后续 TikTok 放量需重新评估）。
 */
export const IOS_FB_FIXED: Record<string, number> = {
  GraceChat: 1.5,
  'Dora iOS': 1.4,
  'Romi iOS': 1.25,
  Luma: 1.2,
};

/** 单产品修正系数：Android 为标量；iOS 为 { fb, other } 分渠道。 */
export type CorrectionFactor = number | { fb: number; other: number };
export type FactorMap = Record<string, CorrectionFactor>;

/**
 * FB 渠道判定：含 facebook/instagram/restricted/unattributed，但排除 W2A/web。
 * 先 lower 且把 '+' 换空格再判子串（媒体源里 'Facebook+Ads' 这类编码形式常见）。
 */
export function isFbSource(ms: string | null | undefined): boolean {
  if (!ms) return false;
  const lower = ms.toLowerCase().replaceAll('+', ' ');
  if (lower.includes('w2a') || lower.includes('web')) return false;
  if (lower.includes('facebook') || lower.includes('instagram') || lower.includes('off-facebook')) {
    return true;
  }
  if (ms === 'restricted' || ms === 'Unattributed') return true;
  return false;
}

interface AthenaItem {
  product: string;
  totalRevenue?: number;
}

interface DayDataShape {
  snapshots?: { athena?: AthenaItem[] }[];
}

interface RevRow {
  app_id: string;
  rev: number;
}

interface MsRevRow {
  app_id: string;
  media_source: string;
  rev: number;
}

/** $start..$(start+n-1) 占位符串，用于参数化 IN 子句。 */
function placeholders(count: number, start: number): string {
  return Array.from({ length: count }, (_, i) => `$${(i + start).toString()}`).join(',');
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * 计算某北京自然日 dataDate 的全产品修正系数。
 *
 * 分母口径：af_purchase 用 event_time 的 UTC 字符串范围；ad_purchase 用 unix 秒范围
 * （两列存储格式不同，见 beijingDayBounds）。ROUND(SUM(revenue)::numeric,4)::float8 是
 * 因为 PG 没有 round(double precision, int) 重载。月表不存在时全部回退为 1。
 */
export async function computeCorrectionFactors(
  dataDate: string,
  db: CorrectionDb,
): Promise<FactorMap> {
  const factors: FactorMap = {};
  const dayRow = (await db.queryOne(
    "SELECT payload FROM daily_snapshots WHERE kind = 'main' AND date = $1",
    [dataDate],
  )) as { payload: DayDataShape } | undefined;
  const lastSnap = dayRow?.payload.snapshots?.at(-1);
  const athenaMap = new Map<string, number>();
  for (const item of lastSnap?.athena ?? []) {
    athenaMap.set(item.product, item.totalRevenue ?? 0);
  }

  const tableName = tableForMonth(dataDate);
  const tableExists = await db.queryOne('SELECT tablename FROM pg_tables WHERE tablename = $1', [
    tableName,
  ]);
  if (!tableExists) {
    for (const p of [...Object.values(ANDROID_APP_IDS), ...Object.values(IOS_AF_APP_IDS)]) {
      factors[p] = 1;
    }
    return factors;
  }

  const { strLo: evtStart, strHi: evtEnd, epLo: tsStart, epHi: tsEnd } = beijingDayBounds(dataDate);

  // Android: athena / af_non_organic
  const androidIds = Object.keys(ANDROID_APP_IDS);
  if (androidIds.length > 0) {
    const rows = (await db.query(
      `SELECT app_id, ROUND(SUM(revenue)::numeric, 4)::float8 as rev
       FROM ${tableName}
       WHERE event_name='af_purchase'
         AND event_time >= $1 AND event_time < $2
         AND media_source != 'organic'
         AND app_id IN (${placeholders(androidIds.length, 3)})
       GROUP BY app_id`,
      [evtStart, evtEnd, ...androidIds],
    )) as RevRow[];
    for (const row of rows) {
      const product = ANDROID_APP_IDS[row.app_id];
      if (product === undefined) continue;
      const athenaRev = athenaMap.get(product) ?? 0;
      if (row.rev > 0 && athenaRev > 0) {
        factors[product] = round4(athenaRev / row.rev);
      }
    }
  }
  for (const p of Object.values(ANDROID_APP_IDS)) {
    factors[p] ??= 1;
  }

  // iOS: FB fixed multiplier then base factor
  const iosAfIds = Object.keys(IOS_AF_APP_IDS);
  const afRows = (await db.query(
    `SELECT app_id, media_source, ROUND(SUM(revenue)::numeric, 4)::float8 as rev
     FROM ${tableName}
     WHERE event_name='af_purchase'
       AND event_time >= $1 AND event_time < $2
       AND media_source != 'organic'
       AND app_id IN (${placeholders(iosAfIds.length, 3)})
     GROUP BY app_id, media_source`,
    [evtStart, evtEnd, ...iosAfIds],
  )) as MsRevRow[];
  const iosAdIds = Object.keys(IOS_AD_APP_IDS);
  const adRows = (await db.query(
    `SELECT app_id, media_source, ROUND(SUM(revenue)::numeric, 4)::float8 as rev
     FROM ${tableName}
     WHERE event_name='ad_purchase'
       AND event_time >= $1 AND event_time < $2
       AND media_source NOT IN ('Organic', 'organic')
       AND app_id IN (${placeholders(iosAdIds.length, 3)})
     GROUP BY app_id, media_source`,
    [tsStart.toString(), tsEnd.toString(), ...iosAdIds],
  )) as MsRevRow[];

  const iosProdRevenue = new Map<string, { fb: number; nonFb: number }>();
  for (const p of Object.values(IOS_AF_APP_IDS)) iosProdRevenue.set(p, { fb: 0, nonFb: 0 });
  for (const row of afRows) {
    const p = IOS_AF_APP_IDS[row.app_id];
    if (p === undefined) continue;
    const acc = iosProdRevenue.get(p);
    if (!acc) continue;
    if (isFbSource(row.media_source)) acc.fb += row.rev;
    else acc.nonFb += row.rev;
  }
  for (const row of adRows) {
    const p = IOS_AD_APP_IDS[row.app_id];
    if (p === undefined) continue;
    const acc = iosProdRevenue.get(p);
    if (!acc) continue;
    const ms = row.media_source.replaceAll('+', ' ');
    if (isFbSource(ms)) acc.fb += row.rev;
    else acc.nonFb += row.rev;
  }

  for (const p of Object.values(IOS_AF_APP_IDS)) {
    const athenaRev = athenaMap.get(p) ?? 0;
    const { fb, nonFb } = iosProdRevenue.get(p) ?? { fb: 0, nonFb: 0 };
    const fbFixed = IOS_FB_FIXED[p] ?? 1;
    const fbAdjusted = fb * fbFixed;
    const totalBase = fbAdjusted + nonFb;
    if (totalBase > 0 && athenaRev > 0) {
      const baseFactor = round4(athenaRev / totalBase);
      const fbFactor = round4(baseFactor * fbFixed);
      factors[p] = { fb: fbFactor, other: baseFactor };
    } else {
      factors[p] = { fb: fbFixed, other: 1 };
    }
  }
  return factors;
}
