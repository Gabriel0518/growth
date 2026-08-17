import { yesterdayBeijing, getDateRange } from '@/lib/dashboard/dates';
import { computePersonal } from '@/lib/dashboard/personal';
import { readXmpCacheForDate } from '@/lib/dashboard/xmp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mia —— 「投放协同中心」实时数据源（公开，无鉴权）。
 *
 * 背景：同事的 owner-center 原先靠 dashboard.py 登录看板、串行拉 /api/postback/personal
 * + /api/ext/xmp，本地跑生成器把数据烤进单文件 HTML（out/投放协同中心.html）。并入本仓库
 * 后，这两个接口的数据本就在同一个 PG 库里，故此路由**直接读库**（复用 computePersonal /
 * readXmpCacheForDate），跳过登录 + HTTP + 静态生成，页面打开即实时最新。
 *
 * 口径 100% 复刻 generate.py：
 *  - 窗口锚点 = 北京时间昨天（看板当天数据不完整，不取）；内嵌 HISTORY 天逐日明细供前端任选区间。
 *  - aggregate：App×渠道×投手，主负责人 = 占比最高的**真人**投手；噪音门槛 7 天 < $50 不展示，
 *    投手占比 < 0.5% 不进详情。
 *  - cross_check：postback 聚合消耗 vs XMP 媒体侧消耗，相对偏差 > 2% 告警。
 *  - pack_daily：字符串池 + 数字数组压缩逐日明细，前端按选定区间现算。
 * 产出的 payload 结构与旧 SEED 完全一致，前端零改动即可消费。
 */

const WINDOW = 7; // 页面默认选中窗口天数
const HISTORY = 60; // 内嵌逐日明细天数（决定日期选择器能选多远）
const XMP_TOLERANCE = 0.02; // postback 与 XMP 消耗允许的相对偏差
const MIN_SPEND = 50; // 噪音门槛：窗口内 < $50 的组合不展示
const MIN_SHARE = 0.005; // 投手占比 < 0.5% 不进详情

// 投手 code → 中文名（与 lib/dashboard/operators.ts 的 OPERATOR_CODES 一致）。
// 只有出现在此表里的 code 才算「真人」投手（test_creative / other 不是真人）。
const NAME: Record<string, string> = {
  syh: '苏屹恒',
  zm1: '张苗',
  zme: '赵媚儿',
  wcx: '武春香',
  zmf: '张梦凡',
  mcy: '马崇岩',
  lh: '刘欢',
  ymt: '杨梅亭',
  wty: '吴天越',
  wvv: '王维维',
  zjc: '张嘉铖',
};

const PLAT: Record<string, string> = {
  'Romi iOS': 'iOS',
  Luma: 'iOS',
  GraceChat: 'iOS',
  'Dora iOS': 'iOS',
  'Kira iOS': 'iOS',
  'Kira And': 'Android',
  Doni: 'Android',
  'Dora And': 'Android',
  'Jovia And': 'Android',
  'Nalo And': 'Android',
  'Romi And': 'Android',
  'Ruby And': 'Android',
};

const CHN: Record<string, string> = { FB: 'Facebook', GG: 'Google', TT: 'TikTok' };

interface DailyRow {
  date: string;
  op: string;
  product: string;
  channel: string;
  cost: number;
  rev: number;
  reg: number;
}

/** 锚点 = 北京昨天。返回 [最早 … 最晚] 的北京日列表（含 n 天）。 */
function buildWindow(n: number): string[] {
  const anchor = yesterdayBeijing();
  const start = getDateRange(anchor, anchor); // [anchor]
  void start;
  // 从 anchor 往前推 n-1 天：用 getDateRange(earliest, anchor)
  const earliest = shiftDays(anchor, -(n - 1));
  return getDateRange(earliest, anchor);
}

/** 在 YYYY-MM-DD 上加 delta 天（UTC 计算，不受时区影响，纯日期算术）。 */
function shiftDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + delta * 86_400_000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${String(yy)}-${mm}-${dd}`;
}

/** 字符串池去重取下标：已存在返回原下标，否则追加。 */
function poolIndex(pool: string[], v: string): number {
  const i = pool.indexOf(v);
  if (i !== -1) return i;
  pool.push(v);
  return pool.length - 1;
}

/** 把逐日明细压成紧凑结构（字符串池 + 数字数组）。复刻 generate.py pack_daily。 */
function packDaily(rows: DailyRow[]): {
  days: string[];
  prods: string[];
  chans: string[];
  ops: string[];
  rows: number[][];
} {
  const prods: string[] = [];
  const chans: string[] = [];
  const ops: string[] = [];
  const days = [...new Set(rows.map((r) => r.date))].sort();
  const dmap = new Map(days.map((d, i) => [d, i]));
  const packed = rows.map((r) => [
    dmap.get(r.date) ?? 0,
    poolIndex(prods, r.product),
    poolIndex(chans, r.channel),
    poolIndex(ops, r.op),
    round2(r.cost),
    round2(r.rev),
    r.reg,
  ]);
  return { days, prods, chans, ops, rows: packed };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface AggRow {
  app: string;
  platform: string;
  channel: string;
  channelName: string;
  spend7d: number;
  dailyAvg: number;
  rev7d: number;
  owner: string;
  ownerName: string;
  ownerShare: number;
  people: {
    code: string;
    name: string;
    spend: number;
    share: number;
    reg: number;
    rev: number;
    real: boolean;
  }[];
  note: string;
  updatedAt: string;
  updatedBy: string;
}

/** (product, channel, operator) 三元组的聚合 map key。 */
function aggKey(p: string, ch: string, op: string): string {
  return `${p}\u0000${ch}\u0000${op}`;
}

/** App×渠道×投手聚合，主负责人 = 占比最高真人。复刻 generate.py aggregate。 */
function aggregate(rows: DailyRow[], nDays: number): AggRow[] {
  const agg = new Map<string, number>();
  const reg = new Map<string, number>();
  const rev = new Map<string, number>();
  for (const r of rows) {
    const k = aggKey(r.product, r.channel, r.op);
    agg.set(k, (agg.get(k) ?? 0) + r.cost);
    reg.set(k, (reg.get(k) ?? 0) + r.reg);
    rev.set(k, (rev.get(k) ?? 0) + r.rev);
  }

  // 按 (product, channel) 归组，值为 [(cost, op), …]
  const byc = new Map<string, { cost: number; op: string }[]>();
  for (const [k, c] of agg) {
    const [p, ch, op] = k.split('\u0000') as [string, string, string];
    const ck = `${p}\u0000${ch}`;
    let bucket = byc.get(ck);
    if (!bucket) {
      bucket = [];
      byc.set(ck, bucket);
    }
    bucket.push({ cost: c, op });
  }

  const out: AggRow[] = [];
  for (const [ck, lst] of byc) {
    const [p, ch] = ck.split('\u0000') as [string, string];
    lst.sort((a, b) => b.cost - a.cost); // 降序
    const tot = lst.reduce((s, x) => s + x.cost, 0);
    if (tot < MIN_SPEND) continue; // 噪音门槛
    const people = lst
      .filter((x) => x.cost / tot >= MIN_SHARE)
      .map((x) => ({
        code: x.op,
        name: NAME[x.op] ?? x.op,
        spend: round2(x.cost),
        share: round2Frac(x.cost / tot),
        reg: reg.get(aggKey(p, ch, x.op)) ?? 0,
        rev: round2(rev.get(aggKey(p, ch, x.op)) ?? 0),
        real: x.op in NAME,
      }));
    const firstPerson = people[0];
    if (!firstPerson) continue;
    const owner = people.find((x) => x.real) ?? firstPerson; // 主负责人只从真人里选
    out.push({
      app: p,
      platform: PLAT[p] ?? '?',
      channel: ch,
      channelName: CHN[ch] ?? ch,
      spend7d: round2(tot),
      dailyAvg: round2(tot / nDays),
      rev7d: round2(lst.reduce((s, x) => s + (rev.get(aggKey(p, ch, x.op)) ?? 0), 0)),
      owner: owner.code,
      ownerName: owner.name,
      ownerShare: owner.share,
      people,
      note: '',
      updatedAt: '',
      updatedBy: '',
    });
  }
  out.sort((a, b) => b.spend7d - a.spend7d);
  return out;
}

function round2Frac(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** postback 聚合消耗 vs XMP 媒体侧消耗，偏差 > 2% 告警。复刻 generate.py cross_check。 */
function crossCheck(
  rows: DailyRow[],
  xmpByDay: Map<string, Map<string, number>>,
  warnings: string[],
): void {
  const pb = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.date}\u0000${r.channel}`;
    pb.set(k, (pb.get(k) ?? 0) + r.cost);
  }
  for (const [day, by] of xmpByDay) {
    for (const [ch, xc] of by) {
      if (xc <= 0) continue;
      const pc = pb.get(`${day}\u0000${ch}`) ?? 0;
      const diff = Math.abs(pc - xc) / xc;
      if (diff > XMP_TOLERANCE) {
        warnings.push(
          `${day} ${ch}: postback $${fmt(pc)} vs XMP $${fmt(xc)}（差 ${(diff * 100).toFixed(1)}%）`,
        );
      }
    }
  }
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 渠道字段归一：computePersonal 的 channel 已是 FB/GG/TT，这里保守兜底大写化。 */
function normChannel(ch: string): string {
  const u = ch.toUpperCase();
  if (u === 'FB' || u === 'GG' || u === 'TT') return u;
  return ch;
}

export async function GET(): Promise<Response> {
  try {
    const days = buildWindow(HISTORY);
    const earliest = days[0];
    const latest = days.at(-1);
    if (earliest === undefined || latest === undefined) {
      throw new Error('empty date window');
    }

    // 一次多日查询即可拿全部逐日明细（computePersonal 支持范围）。但页面要「逐日」拆分，
    // 而 computePersonal 多日返回的是区间聚合。故这里逐日调用（与同事 generate.py 同粒度），
    // 直接读库无网络/无锁竞争，60 次 PG 查询在同进程内很快。
    const rows: DailyRow[] = [];
    const failed: string[] = [];
    for (const day of days) {
      try {
        const j = await computePersonal({ startDate: day, endDate: day });
        for (const op of j.operators) {
          for (const p of op.products) {
            for (const ch of p.channels) {
              const cost = ch.cost || 0;
              if (cost <= 0) continue;
              rows.push({
                date: day,
                op: op.operator,
                product: p.product,
                channel: normChannel(ch.channel),
                cost,
                rev: ch.revenue || 0,
                reg: ch.count || 0,
              });
            }
          }
        }
      } catch (error) {
        failed.push(day);
        void error;
      }
    }

    const warnings: string[] = [];

    // 交叉校验只看最近 WINDOW 天（默认窗口）。
    const xmpByDay = new Map<string, Map<string, number>>();
    const checkDays = days.slice(-WINDOW);
    for (const day of checkDays) {
      const entry = await readXmpCacheForDate(day);
      if (entry) {
        const by = new Map<string, number>();
        for (const r of entry.data) {
          const ch = normChannel(r.channel);
          by.set(ch, (by.get(ch) ?? 0) + (r.cost || 0));
        }
        xmpByDay.set(day, by);
      } else {
        warnings.push(`${day}: XMP 缓存里没有该日，无法校验`);
      }
    }

    if (failed.length > 0) {
      warnings.push(
        `以下 ${String(failed.length)} 天取数失败，日期选到这几天会缺数据：` +
          failed.slice(0, 8).join('、') +
          (failed.length > 8 ? '…' : ''),
      );
    }

    crossCheck(rows, xmpByDay, warnings);

    const defDays = days.slice(-WINDOW);
    const defSet = new Set(defDays);
    const defRows = aggregate(
      rows.filter((r) => defSet.has(r.date)),
      defDays.length,
    );

    const generated = new Date(Date.now() + 8 * 3_600_000)
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ');

    const windowStart = defDays[0] ?? '';
    const windowEnd = defDays.at(-1) ?? '';
    const payload = {
      window: `${windowStart} ~ ${windowEnd}`,
      generated,
      warnings,
      roster: Object.entries(NAME).map(([code, name]) => ({ code, name })),
      avatars: {}, // 头像走前端首字兜底（并入库版暂不内联 base64 头像）
      rows: defRows,
      daily: packDaily(rows),
      defaultWindow: WINDOW,
      plat: PLAT,
      chn: CHN,
      minSpend: MIN_SPEND,
      minShare: MIN_SHARE,
      source: 'live-db', // 标记：实时读库（区别于旧的静态生成 SEED）
      range: `${earliest} ~ ${latest}`,
    };

    return Response.json(payload, {
      headers: { 'Cache-Control': 'public, max-age=60' },
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message, source: 'live-db' }, { status: 500 });
  }
}
