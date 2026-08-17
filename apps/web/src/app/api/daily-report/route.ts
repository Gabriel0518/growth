/**
 * GET /api/daily-report — 全自动投手日报数据接口。
 *
 * 从最近有数据的一天到最早有数据的一天，按投手×渠道聚合返回。
 * 查询参数：
 *   operator - 投手代码（必传，先调一次获取最近/最早日期的列表再调具体数据）
 *   date     - 可选，指定某天的数据（默认返回所有天的数据）
 *
 * 返回的 sheets 包含「汇总」sheet（该投手所有产品的渠道聚合）
 * 和「产品 渠道」明细 sheet。
 */

import { query, queryOne } from '@agentic-ug/db';

import { requireApiAuth } from '@/lib/dashboard/auth';
import { withGuard } from '@/lib/dashboard/guard';
import { RETIRED_OPERATORS } from '@/lib/dashboard/operators';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OPERATOR_NAMES: Record<string, string> = {
  syh: '苏屹恒',
  lh: '刘欢',
  zm1: '张苗',
  zme: '赵媚儿',
  wcx: '武春香',
  zmf: '张梦凡',
  mcy: '马崇岩',
  wvv: '王维维',
  ymt: '杨梅亭',
  zjc: '张嘉铖',
  wty: '吴天越',
};

interface PersonalChannel {
  channel: string;
  count?: number;
  cost?: number;
  revenue?: number;
  newUserRevenue?: number;
  deductedRevenue?: number;
}
interface PersonalProduct {
  product: string;
  count?: number;
  cost?: number;
  revenue?: number;
  newUserRevenue?: number;
  deductedRevenue?: number;
  channels?: PersonalChannel[];
}
interface PersonalOperator {
  operator: string;
  count?: number;
  cost?: number;
  revenue?: number;
  products?: PersonalProduct[];
}
interface PersonalSnapshot {
  operators: PersonalOperator[];
}
interface FactorMapEntry {
  fb: number;
  other: number;
}
type FactorMap = Record<string, number | FactorMapEntry>;
interface DauItem {
  product: string;
  dau: number;
}

function getChannelFactor(factors: FactorMap, product: string, channel: string): number {
  const f = factors[product];
  if (f === undefined) return 1;
  if (typeof f === 'number') return f;
  return channel === 'FB' ? f.fb : f.other;
}

/**
 * 推理成本费率按数据日分段生效 —— 推理成本不落库，每次查询都由当日快照实时算，
 * 所以改费率会连带重算历史。费率表按 from 倒序匹配：取第一个 date >= from 的档位，
 * 2026-08-01 起降为 5%，此前各日仍按 7% 呈现，历史口径不被新费率污染。
 * 后续再调费率就往表里加一条，不要改旧档位。
 */
const REASONING_RATES: readonly { from: string; rate: number }[] = [
  { from: '2026-08-01', rate: 0.05 },
  { from: '0000-00-00', rate: 0.07 },
];

/** 取该数据日适用的推理成本费率。date 为 YYYY-MM-DD，可直接字典序比较。 */
function reasoningRate(date: string): number {
  return REASONING_RATES.find((r) => date >= r.from)?.rate ?? 0.07;
}

/** 14列表头，对应飞书「苏屹恒汇总」sheet */
const COLUMNS = [
  '日期',
  '渠道',
  '消耗',
  '原始收入',
  '总收入',
  '修正后扣费收入',
  '投放利润',
  '返点',
  'PWA成本',
  '运营净利润',
  '纯利润',
  '纯利率',
  '推理成本',
  '总ROAS',
];

/** 汇总表列：原始收入与修正后扣费收入只在产品分表看，汇总表不展示。 */
const SUMMARY_COLUMNS = COLUMNS.filter((c) => c !== '原始收入' && c !== '修正后扣费收入');

/** 日报单行 */
interface ReportRow {
  date: string;
  channel: string;
  /** 消耗 */
  cost: number;
  /** 原始收入（未乘修正系数，所有渠道×产品加总） */
  rawRevenue: number;
  /** 总收入（=修正收入，所有渠道×产品加总） */
  totalRevenue: number;
  /** 修正后扣费收入 = 扣费收入 × 修正系数 */
  deductedRevenue: number;
  /** 投放利润 = deductedRevenue - cost */
  totalProfit: number;
  /** 返点：TT×2.5% */
  rebate: number;
  /** PWA成本按DAU分摊 */
  pwaCost: number;
  /** 运营净利润 = totalProfit - pwaCost + rebate */
  netProfit: number;
  /** 纯利润 = netProfit - reasoningCost */
  pureProfit: number;
  /** 纯利率 = pureProfit / totalRevenue */
  pureRate: number;
  /** 推理成本 = totalRevenue × 当日费率（见 REASONING_RATES） */
  reasoningCost: number;
  /** 总ROAS = ROUND(totalRevenue / cost, 3) */
  roas: number;
}

/**
 * 明细行 —— 产品 × 渠道 × 日，投放利润/返点/PWA成本都在这一层算出来。
 * 汇总行只是把同一天的明细行加总（见 summarizeByDate），不再自行计算，
 * 保证「汇总 = 各产品分表之和」恒成立。
 * revenue = 修正收入（= 原始收入 × 修正系数），与分表口径一致。
 */
interface DetailRow {
  date: string;
  product: string;
  channel: string;
  cost: number;
  count: number;
  /** 原始收入（未乘修正系数） */
  rawRevenue: number;
  /** 修正收入 = 原始收入 × 修正系数 */
  revenue: number;
  /** 修正后扣费收入 = 扣费收入 × 修正系数 */
  deductedRevenue: number;
  /** 投放利润 = deductedRevenue - cost */
  totalProfit: number;
  /** 返点：TT×2.5% */
  rebate: number;
  /** PWA成本：产品分摊额 × 该行修正收入占该产品修正收入总额的比例 */
  pwaCost: number;
  /** 推理成本 = revenue × 当日费率（见 REASONING_RATES）。费率随日期变，故由后端按行算好，前端不再自行乘系数。 */
  reasoningCost: number;
}

/** 由加总后的基础量派生出比值类字段，凑成一条完整报表行。 */
function finalizeRow(base: {
  date: string;
  channel: string;
  cost: number;
  rawRevenue: number;
  totalRevenue: number;
  deductedRevenue: number;
  totalProfit: number;
  rebate: number;
  pwaCost: number;
}): ReportRow {
  const netProfit = base.totalProfit - base.pwaCost + base.rebate;
  const reasoningCost = base.totalRevenue * reasoningRate(base.date);
  const pureProfit = netProfit - reasoningCost;
  return {
    ...base,
    netProfit,
    pureProfit,
    pureRate: base.totalRevenue > 0 ? pureProfit / base.totalRevenue : 0,
    reasoningCost,
    roas: base.cost > 0 ? Math.round((base.totalRevenue / base.cost) * 1000) / 1000 : 0,
  };
}

/**
 * 汇总表 = 明细行按日加总。金额类逐项相加，比值类（纯利率/ROAS）加总后再派生。
 * dates 传入以固定输出顺序（与可用日期一致，倒序）。
 */
function summarizeByDate(detailRows: DetailRow[], dates: readonly string[]): ReportRow[] {
  const byDate = new Map<string, ReturnType<typeof emptyAcc>>();
  for (const r of detailRows) {
    let acc = byDate.get(r.date);
    if (!acc) {
      acc = emptyAcc();
      byDate.set(r.date, acc);
    }
    acc.cost += r.cost;
    acc.rawRevenue += r.rawRevenue;
    acc.totalRevenue += r.revenue;
    acc.deductedRevenue += r.deductedRevenue;
    acc.totalProfit += r.totalProfit;
    acc.rebate += r.rebate;
    acc.pwaCost += r.pwaCost;
  }
  const rows: ReportRow[] = [];
  for (const date of dates) {
    const acc = byDate.get(date);
    if (!acc) continue;
    rows.push(finalizeRow({ date, channel: 'FB/TT/GG', ...acc }));
  }
  return rows;
}

function emptyAcc(): {
  cost: number;
  rawRevenue: number;
  totalRevenue: number;
  deductedRevenue: number;
  totalProfit: number;
  rebate: number;
  pwaCost: number;
} {
  return {
    cost: 0,
    rawRevenue: 0,
    totalRevenue: 0,
    deductedRevenue: 0,
    totalProfit: 0,
    rebate: 0,
    pwaCost: 0,
  };
}

export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  return withGuard(request, auth, async () => {
    const q = new URL(request.url).searchParams;
    const operatorCode = q.get('operator');

    // 有 operator 时就返回数据
    if (!operatorCode) {
      // 返回最近天数范围和投手列表
      const dateRows = await query<{ date: string }>(
        "SELECT DISTINCT date FROM daily_snapshots WHERE kind = 'personal' ORDER BY date DESC",
      );
      // 从最新的一天提取投手列表
      const latestPersonal = await queryOne<{ payload: PersonalSnapshot }>(
        "SELECT payload FROM daily_snapshots WHERE kind = 'personal' AND date = $1",
        [dateRows[0]?.date ?? ''],
      );
      const ops =
        latestPersonal?.payload.operators
          .filter(
            (op) =>
              op.operator !== 'other' &&
              op.operator !== 'test_creative' &&
              !RETIRED_OPERATORS.has(op.operator),
          )
          .map((op) => ({
            code: op.operator,
            name: OPERATOR_NAMES[op.operator] ?? op.operator,
          })) ?? [];
      return Response.json({
        operators: ops,
        availableDates: dateRows.map((r) => r.date),
      });
    }

    // 已撤销的投手：列表里已过滤掉，这里再挡一道，防止手工构造 ?operator=cy1 仍能读到
    // 历史快照里的遗留条目。返回结构与「有该投手但当期无数据」一致，前端无需特判。
    if (RETIRED_OPERATORS.has(operatorCode)) {
      return Response.json({
        availableDates: [],
        operator: { code: operatorCode, name: operatorCode },
        columns: COLUMNS,
        summaryRows: [],
        detailSheets: {},
        sheetNames: ['汇总'],
      });
    }

    // 获取可用日期范围
    const dateRows = await query<{ date: string }>(
      "SELECT DISTINCT date FROM daily_snapshots WHERE kind = 'personal' ORDER BY date DESC",
    );
    const dates = dateRows.map((r) => r.date);
    if (dates.length === 0) {
      return Response.json({ error: 'No data available', sheets: [] });
    }

    // 修正系数：按日逐天读，每日用对应日期的系数（不能全部套用最新一版）。
    // correction 快照由 scheduler 每日定稿昨日后 upsert（kind='correction', date=<数据日>）永久留存，故每天都可按日取。
    // 缺失某天（历史早期还没开始持久化）时回退为空 map， getChannelFactor 自然得 1。
    const correctionRows = await query<{ date: string; payload: FactorMap }>(
      "SELECT date, payload FROM daily_snapshots WHERE kind = 'correction' AND date = ANY($1)",
      [dates],
    );
    const factorsByDate = new Map<string, FactorMap>(
      correctionRows.map((r) => [r.date, r.payload]),
    );

    // ── PWA 成本：逐日取数 ──
    // 日报是逐日展示的，每一行必须用「那一天」的 PWA 池、DAU 与分母，三者量纲一致。
    // 早期把 DAU / 提现 / XMP 都按 latestDate 单取再套用到所有日期行，且分母用了全区间
    // 累计收入（分子却是单日），导致每行只能分到应得份额的几十分之一，PWA 池绝大部分凭空消失。
    const dauRows = await query<{ date: string; payload: DauItem[] }>(
      "SELECT date, payload FROM daily_snapshots WHERE kind = 'dau' AND date = ANY($1)",
      [dates],
    );
    const dauByDate = new Map<string, DauItem[]>(dauRows.map((r) => [r.date, r.payload]));

    // 当日提现额取该日 main 快照的最后一个整点快照（当日累计值）。
    const mainRows = await query<{ date: string; payload: Record<string, unknown> }>(
      "SELECT date, payload FROM daily_snapshots WHERE kind = 'main' AND date = ANY($1)",
      [dates],
    );
    const withdrawalByDate = new Map<string, number>(
      mainRows.map((r) => {
        const snapshots = r.payload['snapshots'] as Record<string, unknown>[] | undefined;
        const lastSnap = snapshots?.at(-1);
        const w = lastSnap?.['pwaWithdrawal'];
        return [r.date, typeof w === 'number' ? w : 0];
      }),
    );

    const xmpRows = await query<{ cache_key: string; payload: Record<string, unknown> }>(
      'SELECT cache_key, payload FROM xmp_cache WHERE cache_key = ANY($1) AND expires_at > now()',
      [dates.map((d) => `xmp-campaigns-${d}`)],
    );
    const xmpPwaByDate = new Map<string, number>(
      xmpRows.map((r) => {
        const data = (r.payload['data'] as Record<string, unknown>[] | undefined) ?? [];
        const cost = data
          .filter((x) => x['product'] === 'PWA')
          .reduce((s, x) => s + (typeof x['cost'] === 'number' ? x['cost'] : 0), 0);
        return [r.cache_key.replace('xmp-campaigns-', ''), cost];
      }),
    );

    // 每日 PWA 池按当日各产品 DAU 占比分到产品。缺 DAU 的日期该日不分摊（留空）。
    const pwaCostByDateProduct = new Map<string, Map<string, number>>();
    for (const date of dates) {
      const dauItems = dauByDate.get(date) ?? [];
      const totalDau = dauItems.reduce((s, d) => s + d.dau, 0);
      const totalPwaCost = (xmpPwaByDate.get(date) ?? 0) + (withdrawalByDate.get(date) ?? 0);
      if (totalDau <= 0 || totalPwaCost <= 0) continue;
      const byProduct = new Map<string, number>();
      for (const d of dauItems) byProduct.set(d.product, totalPwaCost * (d.dau / totalDau));
      pwaCostByDateProduct.set(date, byProduct);
    }

    // 读取所有天的 personal 数据来算 PWA 分配比例
    const allPersonalRows = await query<{ date: string; payload: PersonalSnapshot }>(
      "SELECT date, payload FROM daily_snapshots WHERE kind = 'personal' AND date = ANY($1) ORDER BY date ASC",
      [dates],
    );

    // 二级分摊的分母：**当日**该产品的全投手修正收入（与分子、PWA 池同为单日口径）。
    const prodRevByDateProduct = new Map<string, Map<string, number>>();
    for (const snap of allPersonalRows) {
      const dayFactors = factorsByDate.get(snap.date) ?? {};
      const byProduct = new Map<string, number>();
      for (const op of snap.payload.operators) {
        for (const prod of op.products ?? []) {
          for (const ch of prod.channels ?? []) {
            if ((ch.cost ?? 0) <= 0 && (ch.revenue ?? 0) <= 0) continue;
            const cf = getChannelFactor(dayFactors, prod.product, ch.channel);
            byProduct.set(
              prod.product,
              (byProduct.get(prod.product) ?? 0) + (ch.revenue ?? 0) * cf,
            );
          }
        }
      }
      prodRevByDateProduct.set(snap.date, byProduct);
    }

    // 明细 sheet（所有产品×渠道组合，每日一行）——投放利润/返点/PWA成本都在这层算出来，
    // 汇总 sheet 随后由这些明细行按日加总得到，两者恒等。
    const detailSheets = new Map<string, DetailRow[]>();
    const allDetailRows: DetailRow[] = [];
    const allPersonalDetail = await query<{ date: string; payload: PersonalSnapshot }>(
      "SELECT date, payload FROM daily_snapshots WHERE kind = 'personal' AND date = ANY($1) ORDER BY date DESC",
      [dates],
    );
    for (const snap of allPersonalDetail) {
      const op = snap.payload.operators.find((o) => o.operator === operatorCode);
      if (!op) continue;
      const dayFactors = factorsByDate.get(snap.date) ?? {};
      const dayPwaByProduct = pwaCostByDateProduct.get(snap.date);
      const dayProdRev = prodRevByDateProduct.get(snap.date);
      for (const prod of op.products ?? []) {
        for (const ch of prod.channels ?? []) {
          // 消耗和收入都是 0 才跳过：有些渠道当天没花钱但仍有前几天投放带来的收入，不能漏计。
          if ((ch.cost ?? 0) <= 0 && (ch.revenue ?? 0) <= 0) continue;
          const key = `${prod.product} ${ch.channel}`;
          if (!detailSheets.has(key)) detailSheets.set(key, []);
          const existing = detailSheets.get(key);
          if (existing) {
            const rawRevenue = ch.revenue ?? 0;
            const cf = getChannelFactor(dayFactors, prod.product, ch.channel);
            const cost = ch.cost ?? 0;
            const revenue = rawRevenue * cf;
            const deductedRevenue = (ch.deductedRevenue ?? 0) * cf;
            // PWA 成本二级分摊：当日该产品的分摊额 × 该行修正收入占当日该产品全投手修正收入的比例。
            const productPwaCost = dayPwaByProduct?.get(prod.product) ?? 0;
            const productTotalRev = dayProdRev?.get(prod.product) ?? 0;
            const row: DetailRow = {
              date: snap.date,
              product: prod.product,
              channel: ch.channel,
              cost,
              count: ch.count ?? 0,
              rawRevenue,
              revenue,
              deductedRevenue,
              totalProfit: deductedRevenue - cost,
              rebate: ch.channel === 'TT' ? cost * 0.025 : 0,
              pwaCost: productTotalRev > 0 ? productPwaCost * (revenue / productTotalRev) : 0,
              reasoningCost: revenue * reasoningRate(snap.date),
            };
            existing.push(row);
            allDetailRows.push(row);
          }
        }
      }
    }

    // 汇总 sheet：明细行按日加总，自身不做任何业务计算。
    const sheetRows = summarizeByDate(allDetailRows, dates);

    // sheet 列表：「汇总」固定在最前，其余按消耗从大到小排列
    const detailKeysByCostDesc = [...detailSheets.entries()]
      .sort(([, a], [, b]) => {
        const costA = a.reduce((s, r) => s + r.cost, 0);
        const costB = b.reduce((s, r) => s + r.cost, 0);
        return costB - costA;
      })
      .map(([key]) => key);
    const sheetNames = ['汇总', ...detailKeysByCostDesc];

    return Response.json({
      availableDates: dates,
      operator: { code: operatorCode, name: OPERATOR_NAMES[operatorCode] ?? operatorCode },
      columns: COLUMNS,
      summaryColumns: SUMMARY_COLUMNS,
      summaryRows: sheetRows,
      detailSheets: Object.fromEntries(detailSheets),
      sheetNames,
    });
  });
}
