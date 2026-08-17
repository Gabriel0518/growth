/**
 * 个人面板（Postback Personal）纯逻辑与类型 —— 逐行复刻旧 app.js 的
 * 修正系数(correctionFactors)、eLTV 倍数、投手/产品/渠道/campaign/adset/ad 聚合。
 * 保持零行为差异：iOS 拆 fb/other 修正、区间模式用后端预算修正值、eLTV 按渠道回退。
 */

// isPartnership 为纯字符串判定（无副作用），供前端合成「合创」聚合维度复用后端同一份口径。
import { isPartnership } from '@/lib/dashboard/operators';

export interface PbAd {
  ad: string;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
}

export interface PbAdset {
  adset: string;
  cost?: number;
  impressions?: number;
  clicks?: number;
  adsetIds?: string[];
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
  ads?: PbAd[];
}

export interface PbCampaign {
  campaign: string;
  cost?: number;
  impressions?: number;
  clicks?: number;
  installs?: number;
  campaignIds?: string[];
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
  adsets?: PbAdset[];
}

export interface PbChannel {
  channel: string;
  cost?: number;
  cpm?: number;
  cpc?: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
  campaigns?: PbCampaign[];
}

export interface PbProduct {
  product: string;
  channels: PbChannel[];
}

export interface PbOperator {
  operator: string;
  cost?: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  correctedDeductedRevenue?: number;
  products: PbProduct[];
}

export interface PbPersonalData {
  operators: PbOperator[];
  organic: { revenue: number; newUserRevenue: number; deductedRevenue?: number };
  restricted?: { revenue: number; deductedRevenue?: number };
}

export type CorrectionFactor = number | { fb?: number; other?: number };
export type CorrectionFactors = Record<string, CorrectionFactor | undefined>;

export interface CorrectionFactorsResponse {
  factors?: CorrectionFactors;
  dailyFactors?: unknown;
}

export interface EltvEntry {
  d180?: number;
  records?: number;
  d1Span?: number;
  confidence?: string;
}

export type EltvChannelMap = EltvEntry & Partial<Record<'FB' | 'GG' | 'TT', EltvEntry>>;
export type EltvMultipliers = Record<string, EltvChannelMap | undefined>;

export interface EltvMultipliersResponse {
  multipliers?: EltvMultipliers;
}

/** 合创(partnership)广告桶名。与后端 operators.ts 的 PARTNERSHIP_OPERATOR 一致。 */
export const PARTNERSHIP_OPERATOR = 'partnership';

export const OPERATOR_LABELS: Record<string, string> = {
  syh: '苏屹恒',
  zm1: '张苗',
  zme: '赵媚儿',
  wcx: '武春香',
  zmf: '张梦凡',
  mcy: '马崇岩',
  lh: '刘欢',
  ymt: '杨梅亭',
  dsk: '邓世坤',
  wty: '吴天越',
  wvv: '王维维',
  zjc: '张嘉铖',
  partnership: '🤝 合创',
  test_creative: '🧪 测素材',
  other: '未匹配',
};

const FB_CHANNELS = new Set(['FB']);

export function getCorrectionFactor(
  factors: CorrectionFactors,
  product: string,
  channel: string | undefined,
): number {
  const f = factors[product];
  if (f == null) return 1;
  if (typeof f === 'number') return f;
  if (channel != null && FB_CHANNELS.has(channel)) return f.fb ?? 1;
  return f.other ?? 1;
}

/** 复刻 applyCorrection：非修正模式返回原值；区间模式优先用后端预算修正值；否则乘系数。 */
export function applyCorrection(
  value: number,
  product: string,
  channel: string | undefined,
  correctedValue: number | undefined,
  correctionMode: boolean,
  isRangeMode: boolean,
  factors: CorrectionFactors,
): number {
  if (!correctionMode) return value;
  if (isRangeMode && correctedValue != null) return correctedValue;
  return value * getCorrectionFactor(factors, product, channel);
}

export function getEltvMultiplier(
  mult: EltvMultipliers,
  product: string,
  channel: string | undefined,
): number | null {
  const m = mult[product];
  if (!m) return null;
  if (channel != null) {
    const perCh = m[channel as 'FB' | 'GG' | 'TT'];
    if (perCh?.d180 != null) return perCh.d180;
  }
  for (const ch of ['FB', 'GG', 'TT'] as const) {
    const perCh = m[ch];
    if (perCh?.d180 != null) return perCh.d180;
  }
  if (m.d180 != null) return m.d180;
  return null;
}

export interface EltvConfidence {
  label: string;
  cls: string;
}

export function getEltvConfidence(
  mult: EltvMultipliers,
  product: string,
  channel: string | undefined,
): EltvConfidence | null {
  const m = mult[product];
  if (!m) return null;
  const entry =
    channel != null && m[channel as 'FB' | 'GG' | 'TT'] ? m[channel as 'FB' | 'GG' | 'TT'] : m;
  if (entry?.d180 == null) return null;
  const conf = entry.confidence;
  if (conf === 'green') return { label: '可信', cls: 'text-green' };
  if (conf === 'yellow') return { label: '供参考', cls: 'text-yellow' };
  return { label: '不可信', cls: 'text-red' };
}

export interface OperatorTotals {
  rev: number;
  newRev: number;
  deducted: number;
  roas: number | null;
  eltvRoas: number | null;
}

/** 投手级汇总：总收入/新用户收入/扣费收入（均修正后）、新用户 ROAS、按消耗加权的 eLTV ROAS。 */
export function computeOperatorTotals(
  op: PbOperator,
  correctionMode: boolean,
  isRangeMode: boolean,
  factors: CorrectionFactors,
  mult: EltvMultipliers,
): OperatorTotals {
  let rev = 0;
  let newRev = 0;
  let deducted = 0;
  let eltvWeightedSum = 0;
  let eltvWeightedCost = 0;
  // 合创(partnership)：修正/eLTV 一律按真实产品 + 渠道默认 FB 口径。此处 op 仍是正常结构
  // （p.product = 真实产品），故只需把渠道替换为 'FB'。
  const isPartner = op.operator === PARTNERSHIP_OPERATOR;
  for (const p of op.products) {
    for (const c of p.channels) {
      const chKey = isPartner ? 'FB' : c.channel;
      rev += applyCorrection(
        c.revenue,
        p.product,
        chKey,
        c.correctedRevenue,
        correctionMode,
        isRangeMode,
        factors,
      );
      deducted += applyCorrection(
        c.deductedRevenue ?? 0,
        p.product,
        chKey,
        c.correctedDeductedRevenue,
        correctionMode,
        isRangeMode,
        factors,
      );
      const cNewRev = applyCorrection(
        c.newUserRevenue,
        p.product,
        chKey,
        c.correctedNewUserRevenue,
        correctionMode,
        isRangeMode,
        factors,
      );
      newRev += cNewRev;
      const m = getEltvMultiplier(mult, p.product, chKey);
      const cCost = c.cost ?? 0;
      if (m != null && cCost > 0) {
        const chEltvRoas = (cNewRev / cCost) * m;
        eltvWeightedSum += chEltvRoas * cCost;
        eltvWeightedCost += cCost;
      }
    }
  }
  const hasCost = op.cost != null && op.cost > 0;
  return {
    rev,
    newRev,
    deducted,
    roas: hasCost ? (newRev / (op.cost ?? 1)) * 100 : null,
    eltvRoas: eltvWeightedCost > 0 ? (eltvWeightedSum / eltvWeightedCost) * 100 : null,
  };
}

/** 复刻旧 ROAS 着色：ratio >= 1 → 绿，< 1 → 红，无消耗 → 灰。 */
export function roasClass(newRev: number, cost: number | undefined): string {
  if (cost == null || cost <= 0) return 'text-text-dim';
  return newRev / cost >= 1 ? 'text-green' : 'text-red';
}

interface RevFields {
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
}

/** 把 s 的 6 项收入指标累加到 t（含扣费与三项修正后收入，缺失按 0）。 */
function addRev(t: RevFields, s: RevFields): void {
  t.revenue += s.revenue;
  t.newUserRevenue += s.newUserRevenue;
  t.deductedRevenue = (t.deductedRevenue ?? 0) + (s.deductedRevenue ?? 0);
  t.correctedRevenue = (t.correctedRevenue ?? 0) + (s.correctedRevenue ?? 0);
  t.correctedNewUserRevenue = (t.correctedNewUserRevenue ?? 0) + (s.correctedNewUserRevenue ?? 0);
  t.correctedDeductedRevenue =
    (t.correctedDeductedRevenue ?? 0) + (s.correctedDeductedRevenue ?? 0);
}

/**
 * 合创广告组名的「第一轮分组键」：忽略 `&&` 及其之后的标识符，取前缀并去首尾空白。
 * 例：`victoria_meadows420 && 268011_1` → `victoria_meadows420`，同前缀不同后缀的广告组归为一组。
 * 无 `&&` 时返回去空白后的完整名，与旧版顶层分组行为一致。
 */
export function partnershipGroupKey(adset: string): string {
  const i = adset.indexOf('&&');
  return (i === -1 ? adset : adset.slice(0, i)).trim();
}

/**
 * 合创(partnership)广告展示重排：正常结构（真实产品→渠道→campaign→广告组→广告）重组为
 * 「广告组名前缀→真实产品→campaign→广告组名(完整)→广告」。渠道分组层丢弃（合创按渠道默认 FB，
 * 修正/eLTV 见 computeOperatorTotals 与渲染侧）。指标自「广告组」层自底向上累加；campaign 级
 * installs 不跨层重排、故省略（CPI 显示 '-'）。输出仍是 PbOperator，语义变为：
 * PbProduct.product = 广告组名前缀（partnershipGroupKey，`&&` 前），PbChannel.channel = 真实产品；
 * operator 顶层字段原样保留。
 * 第一轮（顶层）按前缀分组：`x && 1`、`x && 2` 归入同一顶层组 `x`；叶子 adset 层仍保留完整名以区分。
 */
export function regroupPartnershipOperator(op: PbOperator): PbOperator {
  interface AdsetNode {
    adset: PbAdset;
    ads: Map<string, PbAd>;
  }
  // 广告组名前缀 → 真实产品 → campaign → 完整广告组名 → adset 节点（含 ads）
  const g1 = new Map<string, Map<string, Map<string, Map<string, AdsetNode>>>>();

  for (const prod of op.products) {
    for (const ch of prod.channels) {
      for (const camp of ch.campaigns ?? []) {
        for (const aset of camp.adsets ?? []) {
          const fullName = aset.adset;
          const groupKey = partnershipGroupKey(fullName);
          let m2 = g1.get(groupKey);
          if (!m2) {
            m2 = new Map();
            g1.set(groupKey, m2);
          }
          let m3 = m2.get(prod.product);
          if (!m3) {
            m3 = new Map();
            m2.set(prod.product, m3);
          }
          let m4 = m3.get(camp.campaign);
          if (!m4) {
            m4 = new Map();
            m3.set(camp.campaign, m4);
          }
          let node = m4.get(fullName);
          if (!node) {
            node = {
              adset: {
                adset: fullName,
                cost: 0,
                impressions: 0,
                clicks: 0,
                revenue: 0,
                newUserRevenue: 0,
                deductedRevenue: 0,
                correctedRevenue: 0,
                correctedNewUserRevenue: 0,
                correctedDeductedRevenue: 0,
                ads: [],
              },
              ads: new Map(),
            };
            m4.set(fullName, node);
          }
          const a = node.adset;
          a.cost = (a.cost ?? 0) + (aset.cost ?? 0);
          a.impressions = (a.impressions ?? 0) + (aset.impressions ?? 0);
          a.clicks = (a.clicks ?? 0) + (aset.clicks ?? 0);
          addRev(a, aset);
          for (const ad of aset.ads ?? []) {
            let ta = node.ads.get(ad.ad);
            if (!ta) {
              ta = {
                ad: ad.ad,
                revenue: 0,
                newUserRevenue: 0,
                deductedRevenue: 0,
                correctedRevenue: 0,
                correctedNewUserRevenue: 0,
                correctedDeductedRevenue: 0,
              };
              node.ads.set(ad.ad, ta);
            }
            addRev(ta, ad);
          }
        }
      }
    }
  }

  const products: PbProduct[] = [];
  for (const [groupKey, m2] of g1) {
    const channels: PbChannel[] = [];
    for (const [realProduct, m3] of m2) {
      const campaigns: PbCampaign[] = [];
      for (const [campName, m4] of m3) {
        // 同一 campaign 下可有多个完整广告组名（前缀相同、`&&` 后缀不同），各自成一行 adset。
        const adsets: PbAdset[] = [];
        for (const node of m4.values()) {
          node.adset.ads = [...node.ads.values()].sort((x, y) => y.revenue - x.revenue);
          adsets.push(node.adset);
        }
        adsets.sort((x, y) => y.revenue - x.revenue);
        const campNode: PbCampaign = {
          campaign: campName,
          cost: 0,
          impressions: 0,
          clicks: 0,
          revenue: 0,
          newUserRevenue: 0,
          deductedRevenue: 0,
          correctedRevenue: 0,
          correctedNewUserRevenue: 0,
          correctedDeductedRevenue: 0,
          adsets,
        };
        for (const a of adsets) {
          campNode.cost = (campNode.cost ?? 0) + (a.cost ?? 0);
          campNode.impressions = (campNode.impressions ?? 0) + (a.impressions ?? 0);
          campNode.clicks = (campNode.clicks ?? 0) + (a.clicks ?? 0);
          addRev(campNode, a);
        }
        campaigns.push(campNode);
      }
      campaigns.sort((x, y) => y.revenue - x.revenue);
      const chNode: PbChannel = {
        channel: realProduct,
        cost: 0,
        revenue: 0,
        newUserRevenue: 0,
        deductedRevenue: 0,
        correctedRevenue: 0,
        correctedNewUserRevenue: 0,
        correctedDeductedRevenue: 0,
        campaigns,
      };
      for (const camp of campaigns) {
        chNode.cost = (chNode.cost ?? 0) + (camp.cost ?? 0);
        addRev(chNode, camp);
      }
      channels.push(chNode);
    }
    channels.sort((x, y) => y.revenue - x.revenue);
    products.push({ product: groupKey, channels });
  }
  products.sort(
    (x, y) =>
      y.channels.reduce((s, c) => s + c.revenue, 0) - x.channels.reduce((s, c) => s + c.revenue, 0),
  );

  // 顶层 operator 字段原样保留（含可选字段的精确类型），仅替换 products。
  return { ...op, products };
}

/**
 * 合成「合创(partnership)」聚合维度：扫描所有 operator 桶里 isPartnership 的 campaign，
 * 汇总成一个正常结构（真实产品→渠道→campaign→广告组→广告）的 'partnership' PbOperator。
 * 这是叠加在各投手/test/未匹配桶之上的**额外视图**——同一 campaign 仍留在其投手桶内，
 * 本桶只做聚合展示（渠道/op 级指标重算自入选 campaign）。渲染侧再用 regroupPartnershipOperator
 * 出广告组名视图、按 FB 口径修正。无任何 partnership campaign 时返回 null。
 * 注意：本桶与投手桶数据有意重叠，故**不计入顶部卡片合计**（卡片仍只汇总各投手桶）。
 */
export function buildPartnershipOverlay(operators: PbOperator[]): PbOperator | null {
  const agg: PbOperator = {
    operator: PARTNERSHIP_OPERATOR,
    cost: 0,
    revenue: 0,
    newUserRevenue: 0,
    deductedRevenue: 0,
    correctedDeductedRevenue: 0,
    products: [],
  };
  let found = false;
  for (const op of operators) {
    if (op.operator === PARTNERSHIP_OPERATOR) continue; // 防御：不并入已存在的合创桶
    for (const prod of op.products) {
      for (const ch of prod.channels) {
        for (const camp of ch.campaigns ?? []) {
          if (!isPartnership(camp.campaign)) continue;
          found = true;
          let p = agg.products.find((x) => x.product === prod.product);
          if (!p) {
            p = { product: prod.product, channels: [] };
            agg.products.push(p);
          }
          let c = p.channels.find((x) => x.channel === ch.channel);
          if (!c) {
            c = {
              channel: ch.channel,
              cost: 0,
              revenue: 0,
              newUserRevenue: 0,
              deductedRevenue: 0,
              correctedRevenue: 0,
              correctedNewUserRevenue: 0,
              correctedDeductedRevenue: 0,
              campaigns: [],
            };
            p.channels.push(c);
          }
          const camps = c.campaigns ?? (c.campaigns = []);
          camps.push(camp);
          c.cost = (c.cost ?? 0) + (camp.cost ?? 0);
          addRev(c, camp);
          agg.cost = (agg.cost ?? 0) + (camp.cost ?? 0);
          agg.revenue += camp.revenue;
          agg.newUserRevenue += camp.newUserRevenue;
          agg.deductedRevenue = (agg.deductedRevenue ?? 0) + (camp.deductedRevenue ?? 0);
          agg.correctedDeductedRevenue =
            (agg.correctedDeductedRevenue ?? 0) + (camp.correctedDeductedRevenue ?? 0);
        }
      }
    }
  }
  return found ? agg : null;
}
