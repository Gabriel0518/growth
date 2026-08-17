/**
 * 汇总面板纯逻辑 —— 逐行复刻旧 dashboard/public/app.js 的类型、产品行、增量配对、快照匹配等。
 * 保持零行为差异：产品顺序、ROI/CPI 公式、增量阈值 0.005、6 段每小时配对、30 分钟最小间隔。
 */

export interface AthenaItem {
  product: string;
  totalRevenue?: number;
  newUserRevenue?: number;
}

export interface XmpItem {
  product: string;
  cost?: number;
}

export interface AfSnapItem {
  product: string;
  revenueActual?: number;
  revenueLTV?: number;
  installs?: number;
}

export interface Snapshot {
  time?: string;
  athena?: AthenaItem[];
  af?: AfSnapItem[];
  xmp?: XmpItem[];
  ad?: unknown[];
}

export interface DayData {
  date?: string;
  startDate?: string;
  endDate?: string;
  isRange?: boolean;
  missingDates?: string[];
  snapshots: Snapshot[];
}

export interface AfSummaryProduct {
  revenueActual: number;
  revenueLTV: number;
  installs: number;
}

export interface AfSummaryResponse {
  startDate: string;
  endDate: string;
  date: string;
  products: Record<string, AfSummaryProduct>;
  missingDates?: string[];
}

export interface ChannelBucket {
  cost: number;
  revenue: number;
  installs: number;
  cpi: number | null;
  newUserRevenue: number;
  newUserRoas: number | null;
  d7Revenue: number;
  d7Roas: number | null;
}

export interface ChannelSummary extends ChannelBucket {
  products: Record<string, ChannelBucket>;
}

export interface ChannelSummaryResponse {
  startDate: string;
  endDate: string;
  channels: Record<string, ChannelSummary>;
  d7Incomplete: string[];
  xmpMissingDates: string[];
}

export interface StatusSource {
  status?: string;
  lastSuccess?: string | null;
}

export interface StatusResponse {
  sources: Record<string, StatusSource | undefined>;
  isFetching?: boolean;
}

export const PRODUCTS = [
  'GraceChat',
  'Dora iOS',
  'Dora And',
  'Doni',
  'Romi iOS',
  'Romi And',
  'Luma',
  'Jovia And',
  'Kira iOS',
  'Mora iOS',
  'Kira And',
  'Nalo And',
  'Ruby And',
];

export const CHANNEL_ORDER = ['FB', 'GG', 'TT'];
export const CHANNEL_LABELS: Record<string, string> = {
  FB: 'Facebook',
  GG: 'Google',
  TT: 'TikTok',
};

export type SortField =
  | 'product'
  | 'athenaTotal'
  | 'athenaNew'
  | 'afActual'
  | 'afLTV'
  | 'afInstalls'
  | 'xmpCost'
  | 'cpi'
  | 'roi';

export interface ProductRow {
  product: string;
  athenaTotal: number | null;
  athenaNew: number | null;
  afActual: number | null;
  afLTV: number | null;
  afInstalls: number | null;
  xmpCost: number | null;
  cpi: number | null;
  roi: number | null;
}

export function buildProductRow(
  product: string,
  snapshot: Snapshot,
  afSummary: AfSummaryResponse | null,
): ProductRow {
  const athena = (snapshot.athena ?? []).find((a) => a.product === product);
  const xmp = (snapshot.xmp ?? []).find((x) => x.product === product);
  const athenaTotal = athena ? (athena.totalRevenue ?? null) : null;
  const athenaNew = athena ? (athena.newUserRevenue ?? null) : null;
  const afP = afSummary ? afSummary.products[product] : undefined;
  const afActual = afP ? afP.revenueActual : null;
  const afLTV = afP ? afP.revenueLTV : null;
  const afInstalls = afP ? afP.installs : null;
  const xmpCost = xmp ? (xmp.cost ?? null) : null;
  const cpi = xmpCost != null && afInstalls != null && afInstalls > 0 ? xmpCost / afInstalls : null;
  const roi = athenaNew != null && xmpCost != null && xmpCost > 0 ? (athenaNew / xmpCost) * 100 : null;
  return { product, athenaTotal, athenaNew, afActual, afLTV, afInstalls, xmpCost, cpi, roi };
}

export function sortRows(rows: ProductRow[], field: SortField | null, dir: 'asc' | 'desc'): ProductRow[] {
  if (!field) return rows;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    if (field === 'product') {
      const va = a.product;
      const vb = b.product;
      return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    const raw = (r: ProductRow): number => {
      const v = r[field];
      return v ?? Number.NEGATIVE_INFINITY;
    };
    return dir === 'asc' ? raw(a) - raw(b) : raw(b) - raw(a);
  });
  return sorted;
}

function snapshotHasData(snap: Snapshot | undefined): boolean {
  if (!snap) return false;
  const hasAthena = Array.isArray(snap.athena) && snap.athena.length > 0;
  const hasAf = Array.isArray(snap.af) && snap.af.length > 0;
  const hasXmp = Array.isArray(snap.xmp) && snap.xmp.length > 0;
  const hasAd = Array.isArray(snap.ad) && snap.ad.length > 0;
  return hasAthena || hasAf || hasXmp || hasAd;
}

export function findSameTimeSnapshot(
  target: DayData | null,
  currentTimeISO: string,
): Snapshot | null {
  if (!target || target.snapshots.length === 0) return null;
  const current = new Date(currentTimeISO);
  const currentMinutes = current.getHours() * 60 + current.getMinutes();
  let bestSnapshot: Snapshot | null = null;
  let bestMinutes = -1;
  for (const snap of target.snapshots) {
    if (!snapshotHasData(snap)) continue;
    if (snap.time == null) continue;
    const snapDate = new Date(snap.time);
    const snapMinutes = snapDate.getHours() * 60 + snapDate.getMinutes();
    if (snapMinutes > currentMinutes) continue;
    if (snapMinutes > bestMinutes) {
      bestMinutes = snapMinutes;
      bestSnapshot = snap;
    }
  }
  return bestSnapshot;
}

export type HourlySource = 'athena' | 'af' | 'xmp';
export type CardKey = 'athena' | 'athena-new' | 'af' | 'af-ltv' | 'xmp';

interface SourceSnap {
  time: string;
  vals: Record<string, number>;
}

function extractSource(source: HourlySource, s: Snapshot): Record<string, number> | null {
  if (source === 'athena') {
    if (!Array.isArray(s.athena) || s.athena.length === 0) return null;
    return {
      totalRevenue: s.athena.reduce((sum, a) => sum + (a.totalRevenue ?? 0), 0),
      newUserRevenue: s.athena.reduce((sum, a) => sum + (a.newUserRevenue ?? 0), 0),
    };
  }
  if (source === 'af') {
    if (!Array.isArray(s.af) || s.af.length === 0) return null;
    return {
      revenueActual: s.af.reduce((sum, a) => sum + (a.revenueActual ?? 0), 0),
      revenueLTV: s.af.reduce((sum, a) => sum + (a.revenueLTV ?? 0), 0),
    };
  }
  if (!Array.isArray(s.xmp) || s.xmp.length === 0) return null;
  return { cost: s.xmp.reduce((sum, x) => sum + (x.cost ?? 0), 0) };
}

function getSourceSnapshots(day: DayData | null, source: HourlySource): SourceSnap[] {
  if (!day) return [];
  const out: SourceSnap[] = [];
  for (const s of day.snapshots) {
    if (s.time == null) continue;
    const vals = extractSource(source, s);
    if (vals) out.push({ time: s.time, vals });
  }
  return out;
}

function findPrevHourSnap(snaps: SourceSnap[], refTimeISO: string): SourceSnap | null {
  const refMs = new Date(refTimeISO).getTime();
  const minGapMs = 30 * 60 * 1000;
  let best: SourceSnap | null = null;
  for (const s of snaps) {
    const ms = new Date(s.time).getTime();
    if (ms >= refMs - minGapMs) continue;
    if (!best || ms > new Date(best.time).getTime()) best = s;
  }
  return best;
}

function timeToMinutes(isoStr: string): number {
  const d = new Date(isoStr);
  const parts = d
    .toLocaleString('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    })
    .split(':');
  return Number.parseInt(parts[0] ?? '0', 10) * 60 + Number.parseInt(parts[1] ?? '0', 10);
}

export interface HourlyPair {
  from: string;
  to: string;
  delta: number;
  yoy: { from: string; to: string; delta: number } | null;
}

function findYesterdayMatchingPair(
  todayToISO: string,
  field: string,
  yesterdaySnaps: SourceSnap[],
): { from: string; to: string; delta: number } | null {
  if (yesterdaySnaps.length < 2) return null;
  const toMins = timeToMinutes(todayToISO);
  let prevTo: SourceSnap | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const s of yesterdaySnaps) {
    const diff = Math.abs(timeToMinutes(s.time) - toMins);
    if (diff < bestDiff) {
      bestDiff = diff;
      prevTo = s;
    }
  }
  if (!prevTo) return null;
  const prevFrom = findPrevHourSnap(yesterdaySnaps, prevTo.time);
  if (!prevFrom) return null;
  return {
    from: prevFrom.time,
    to: prevTo.time,
    delta: (prevTo.vals[field] ?? 0) - (prevFrom.vals[field] ?? 0),
  };
}

export function buildHourlyPairs(
  day: DayData | null,
  prevDay: DayData | null,
  source: HourlySource,
  field: string,
): HourlyPair[] {
  const snaps = getSourceSnapshots(day, source);
  if (snaps.length < 2) return [];
  const yesterdaySnaps = getSourceSnapshots(prevDay, source);
  const pairs: HourlyPair[] = [];
  let cursor = snaps.at(-1);
  for (let i = 0; i < 6; i++) {
    if (!cursor) break;
    const prev = findPrevHourSnap(snaps, cursor.time);
    if (!prev) break;
    const delta = (cursor.vals[field] ?? 0) - (prev.vals[field] ?? 0);
    const yoy = findYesterdayMatchingPair(cursor.time, field, yesterdaySnaps);
    pairs.push({ from: prev.time, to: cursor.time, delta, yoy });
    cursor = prev;
  }
  return pairs;
}

export const EXPAND_CARD_CONFIG: Record<CardKey, { source: HourlySource; field: string }> = {
  athena: { source: 'athena', field: 'totalRevenue' },
  'athena-new': { source: 'athena', field: 'newUserRevenue' },
  af: { source: 'af', field: 'revenueActual' },
  'af-ltv': { source: 'af', field: 'revenueLTV' },
  xmp: { source: 'xmp', field: 'cost' },
};

export function fmtDeltaMoney(val: number | null): string {
  if (val == null || Number.isNaN(val)) return '--';
  const abs = Math.abs(val);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val > 0.005) return `+$${str}`;
  if (val < -0.005) return `-$${str}`;
  return `$${str}`;
}

export function deltaClass(val: number | null): 'positive' | 'negative' | 'neutral' {
  if (val == null || Number.isNaN(val)) return 'neutral';
  if (val > 0.005) return 'positive';
  if (val < -0.005) return 'negative';
  return 'neutral';
}
