/**
 * 素材 / AIGC 面板共享纯逻辑与类型 —— 逐行复刻旧 app.js 的命名解析
 * (parseAigcName)、修正系数解析 (getAigcCorrectionFactor)、指标计算
 * (computeAigcMetrics/computeCreativeMetrics 同构)、筛选/排序/跨产品复用。
 * 素材面板与 AIGC 面板在旧代码里完全平行，故公共逻辑集中于此。
 */

import { getJsonSoft } from './api';

export type FactorValue = number | { fb?: number; other?: number };
export type AigcCorrectionFactors = Record<string, FactorValue | undefined>;

export interface CreativeRow {
  name: string;
  product: string;
  channel: string;
  cost: number;
  impressions: number;
  clicks: number;
  newUserRevenue: number;
}

export interface CreativeMetrics extends CreativeRow {
  cpm: number;
  cpc: number;
  ctr: number;
  roas: number;
}

export interface CreativeDataResponse {
  days?: number;
  dates?: string[];
  dateRange?: string;
  missingDates?: string[];
  fb?: CreativeRow[];
  tt?: CreativeRow[];
}

export type NumMetric = 'newUserRevenue' | 'cost' | 'roas' | 'cpm' | 'cpc' | 'ctr';
export type NumOp = 'gt' | 'gte' | 'eq' | 'lte' | 'lt';

export interface NumFilter {
  metric: NumMetric;
  op: NumOp;
  value: number | null;
}

export interface NameFilters {
  owner: string;
  product: string;
  form: string;
  type: string;
  creative: string;
  date: string;
}

export type SortField = 'name' | 'product' | NumMetric;
export interface SortObj {
  field: SortField;
  dir: 'asc' | 'desc';
}

export const AIGC_OWNERS = ['ZHT', 'WXT', 'LSY', 'WYM', 'ZKN', 'XZH', 'CKY'];
export const AIGC_PRODUCTS = ['Doni', 'GraceChat', 'Jovia', 'Kira', 'Luma', 'Nalo', 'Romi', 'Vika'];
export const AIGC_FORMS = ['剧情类', '口播类', '展示类'];
export const AIGC_TYPES = ['创新', '迭代', '铺量'];
export const AIGC_CREATIVES = [
  '暗示',
  '自我展示',
  '女性主动',
  '男性爽感',
  '找对象',
  '产品安利',
  '痛点对比',
  '社会证明',
  '挑战承诺',
  '情绪求助',
  '反差冲突',
];
export const AIGC_ACTORS = [
  'Emily',
  'Ashley',
  'Jessica',
  'Sarah',
  'Amanda',
  'Megan',
  'Hannah',
  'Brittany',
  'Lauren',
  'Nicole',
  'Rachel',
  'Samantha',
  'Lisa',
];

/** 素材面板复用目标产品集：AIGC 产品集 + Dora（老命名素材，AIGC 产品集里没有）。 */
export const CREATIVE_PRODUCTS = ['Dora', 'Doni', 'GraceChat', 'Jovia', 'Kira', 'Luma', 'Nalo', 'Romi', 'Vika'];

export const AIGC_NUM_METRICS: { key: NumMetric; label: string }[] = [
  { key: 'newUserRevenue', label: '新用户收入' },
  { key: 'cost', label: '消耗' },
  { key: 'roas', label: 'ROAS' },
  { key: 'cpm', label: 'CPM' },
  { key: 'cpc', label: 'CPC' },
  { key: 'ctr', label: 'CTR(%)' },
];

export const AIGC_NUM_OPS: { key: NumOp; label: string }[] = [
  { key: 'gt', label: '>' },
  { key: 'gte', label: '≥' },
  { key: 'eq', label: '=' },
  { key: 'lte', label: '≤' },
  { key: 'lt', label: '<' },
];

/**
 * AIGC 用基础产品名（无 iOS/And 后缀）；修正系数按完整产品名（区分平台）索引。
 * 决策（屹恒 2026-06-30）：Romi 一律用 Romi iOS。
 */
const AIGC_FACTOR_PRODUCT: Record<string, string | undefined> = {
  Doni: 'Doni',
  GraceChat: 'GraceChat',
  Jovia: 'Jovia And',
  Kira: 'Kira And',
  Luma: 'Luma',
  Nalo: 'Nalo And',
  Romi: 'Romi iOS',
  Dora: 'Dora iOS',
};

/** 解析某素材行的修正系数（基础产品 + 渠道 FB/TT）：Android 单值；iOS 风格 {fb,other} 按渠道取。 */
export function getAigcCorrectionFactor(
  factors: AigcCorrectionFactors,
  product: string,
  channel: string,
): number {
  const key = AIGC_FACTOR_PRODUCT[product];
  if (key == null) return 1;
  const f = factors[key];
  if (f == null) return 1;
  if (typeof f === 'number') return f;
  if (channel === 'FB') return f.fb ?? 1;
  return f.other ?? 1;
}

/** 计算派生指标；correctionMode 时对 newUserRevenue 套修正系数并重算 ROAS。 */
export function computeMetrics(
  c: CreativeRow,
  correctionMode: boolean,
  factors: AigcCorrectionFactors,
): CreativeMetrics {
  let rev = c.newUserRevenue;
  if (correctionMode) rev *= getAigcCorrectionFactor(factors, c.product, c.channel);
  return {
    ...c,
    newUserRevenue: rev,
    cpm: c.impressions > 0 ? (c.cost / c.impressions) * 1000 : 0,
    cpc: c.clicks > 0 ? c.cost / c.clicks : 0,
    ctr: c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
    roas: c.cost > 0 ? rev / c.cost : 0,
  };
}

export function aigcNumCompare(actual: number, op: NumOp, target: number): boolean {
  switch (op) {
    case 'gt': {
      return actual > target;
    }
    case 'gte': {
      return actual >= target;
    }
    case 'eq': {
      return Math.abs(actual - target) < 1e-9;
    }
    case 'lte': {
      return actual <= target;
    }
    case 'lt': {
      return actual < target;
    }
    default: {
      return true;
    }
  }
}

/** 枚举值匹配：按 '_' 分段命中或子串命中（子串兜底让 GraceChat 等复合名不被误拆）。 */
function aigcMatchEnum(name: string, segs: string[], values: string[]): string[] {
  const hit: string[] = [];
  for (const v of values) {
    if (segs.includes(v) || name.includes(v)) hit.push(v);
  }
  return hit;
}

export interface ParsedName {
  owner: string;
  product: string;
  form: string;
  type: string;
  actor: string;
  refCode: string;
  date: string;
  owners: string[];
  products: string[];
  forms: string[];
  types: string[];
  actors: string[];
  creatives: string[];
  refCodes: string[];
  dates: string[];
}

interface SubName {
  owner: string;
  product: string;
  form: string;
  type: string;
  creatives: string[];
  actor: string;
  refCode: string;
  date: string;
}

/** 解析单个（子）素材名为约定字段。 */
function parseAigcSubName(name: string): SubName {
  const segs = name.split('_');
  const owners = aigcMatchEnum(name, segs, AIGC_OWNERS);
  const products = aigcMatchEnum(name, segs, AIGC_PRODUCTS);
  const forms = aigcMatchEnum(name, segs, AIGC_FORMS);
  const types = aigcMatchEnum(name, segs, AIGC_TYPES);
  const actors = aigcMatchEnum(name, segs, AIGC_ACTORS);
  const creatives = AIGC_CREATIVES.filter((cr) => name.includes(cr));
  const refMatch = /竞品学习([A-Za-z0-9]+)/.exec(name);
  let date = '';
  const dm = /^(\d{2})(\d{2})(\d{2})$/.exec(segs[0] ?? '');
  if (dm) date = `${dm[2] ?? ''}-${dm[3] ?? ''}`;
  return {
    owner: owners[0] ?? '',
    product: products[0] ?? '',
    form: forms[0] ?? '',
    type: types[0] ?? '',
    creatives,
    actor: actors[0] ?? '',
    refCode: refMatch ? (refMatch[1] ?? '') : '',
    date,
  };
}

/** 解析（可能是多产品打包的）素材名；打包名以 ' | ' 拼接，行级字段取各子名的并集。 */
export function parseAigcName(name: string): ParsedName {
  const parts = name.split(' | ');
  const ownerSet = new Set<string>();
  const productSet = new Set<string>();
  const formSet = new Set<string>();
  const typeSet = new Set<string>();
  const creativeSet = new Set<string>();
  const actorSet = new Set<string>();
  const refSet = new Set<string>();
  const dateSet = new Set<string>();
  for (const part of parts) {
    const p = parseAigcSubName(part);
    if (p.owner) ownerSet.add(p.owner);
    if (p.product) productSet.add(p.product);
    if (p.form) formSet.add(p.form);
    if (p.type) typeSet.add(p.type);
    if (p.actor) actorSet.add(p.actor);
    if (p.refCode) refSet.add(p.refCode);
    if (p.date) dateSet.add(p.date);
    for (const cr of p.creatives) creativeSet.add(cr);
  }
  const owners = [...ownerSet];
  const products = [...productSet];
  const forms = [...formSet];
  const types = [...typeSet];
  const actors = [...actorSet];
  const creatives = [...creativeSet];
  const refCodes = [...refSet];
  const dates = [...dateSet];
  return {
    owner: owners[0] ?? '',
    product: products[0] ?? '',
    form: forms[0] ?? '',
    type: types[0] ?? '',
    actor: actors[0] ?? '',
    refCode: refCodes[0] ?? '',
    date: dates[0] ?? '',
    owners,
    products,
    forms,
    types,
    actors,
    creatives,
    refCodes,
    dates,
  };
}

/**
 * 跨产品复用：把素材名里的产品字段替换为目标产品，返回新完整素材名。
 * 素材名按 '_' 分段，产品是其中一段；打包名（' | '）逐子名替换；无独立产品段时子串兜底。
 */
export function replaceProduct(name: string, targetProduct: string, products: string[]): string {
  if (!name || !targetProduct) return name;
  const replaceOne = (sub: string): string => {
    const segs = sub.split('_');
    let replaced = false;
    for (let i = 0; i < segs.length; i++) {
      if (products.includes(segs[i] ?? '')) {
        segs[i] = targetProduct;
        replaced = true;
      }
    }
    if (!replaced) {
      for (const p of products) {
        if (sub.includes(p)) return sub.split(p).join(targetProduct);
      }
    }
    return segs.join('_');
  };
  return name
    .split(' | ')
    .map((s) => replaceOne(s))
    .join(' | ');
}

/** 保留其解析字段包含所有已选筛选值的行（字段间 AND）。产品优先看行 product，再回退命名解析。 */
export function applyFilters(
  data: CreativeRow[],
  filters: NameFilters,
  numFilter: NumFilter,
  correctionMode: boolean,
  factors: AigcCorrectionFactors,
): CreativeRow[] {
  const hasNum = numFilter.value != null && !Number.isNaN(numFilter.value);
  if (
    !filters.owner &&
    !filters.product &&
    !filters.form &&
    !filters.type &&
    !filters.creative &&
    !filters.date &&
    !hasNum
  ) {
    return data;
  }
  return data.filter((c) => {
    const p = parseAigcName(c.name);
    if (filters.owner && !p.owners.includes(filters.owner)) return false;
    if (filters.product && c.product !== filters.product && !p.products.includes(filters.product)) return false;
    if (filters.form && !p.forms.includes(filters.form)) return false;
    if (filters.type && !p.types.includes(filters.type)) return false;
    if (filters.creative && !p.creatives.includes(filters.creative)) return false;
    if (filters.date && !p.dates.includes(filters.date)) return false;
    if (hasNum) {
      const m = computeMetrics(c, correctionMode, factors);
      if (!aigcNumCompare(m[numFilter.metric], numFilter.op, numFilter.value ?? 0)) return false;
    }
    return true;
  });
}

/** 排序（返回新数组）：name/product 按 localeCompare，其余按派生指标数值。 */
export function sortRows(
  list: CreativeRow[],
  sortObj: SortObj,
  correctionMode: boolean,
  factors: AigcCorrectionFactors,
): CreativeRow[] {
  return [...list].sort((a, b) => {
    if (sortObj.field === 'name' || sortObj.field === 'product') {
      const av = a[sortObj.field];
      const bv = b[sortObj.field];
      return sortObj.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    const am = computeMetrics(a, correctionMode, factors);
    const bm = computeMetrics(b, correctionMode, factors);
    return sortObj.dir === 'asc'
      ? am[sortObj.field] - bm[sortObj.field]
      : bm[sortObj.field] - am[sortObj.field];
  });
}

/** 取最新单日（昨日北京时间，最近一份完整系数）的修正系数。软失败返回 {}。 */
export async function fetchCorrectionFactors(): Promise<AigcCorrectionFactors> {
  const now = new Date(Date.now() + 8 * 3_600_000);
  now.setUTCDate(now.getUTCDate() - 1);
  const d = now.toISOString().slice(0, 10);
  const data = await getJsonSoft<{ factors?: AigcCorrectionFactors }>(`/api/correction-factors?date=${d}`);
  return data?.factors ?? {};
}

/** 生成并触发 CSV 下载（BOM + 表头 #/素材名称/产品/新用户收入/消耗/ROAS/CPM/CPC/CTR(%)）。 */
export function downloadCsv(
  rows: CreativeRow[],
  correctionMode: boolean,
  factors: AigcCorrectionFactors,
  filename: string,
): void {
  const headers = ['#', '素材名称', '产品', '新用户收入', '消耗', 'ROAS', 'CPM', 'CPC', 'CTR(%)'];
  const csvRows = [headers.join(',')];
  for (const [i, c] of rows.entries()) {
    const m = computeMetrics(c, correctionMode, factors);
    const name = `"${c.name.replaceAll('"', '""')}"`;
    const product = `"${c.product.replaceAll('"', '""')}"`;
    csvRows.push(
      [
        (i + 1).toString(),
        name,
        product,
        m.newUserRevenue.toFixed(2),
        m.cost.toFixed(2),
        m.roas.toFixed(2),
        m.cpm.toFixed(2),
        m.cpc.toFixed(2),
        m.ctr.toFixed(2),
      ].join(','),
    );
  }

  const blob = new Blob([`\uFEFF${csvRows.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
