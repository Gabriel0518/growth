/**
 * sitin.ai 客户门户（/demo）的前端数据接入层 + 本地偏好。
 *
 * 两块内容，边界要分清：
 *   · **数据与登录走服务端**：所有业务内容来自 /api/demo/*，服务端从 PG + FB 官方 API 取真实
 *     合创投放数据（见 lib/demo/partnership.ts）；登录 cookie 是 httpOnly，前端拿不到也存不下
 *     口令，刷新后靠 GET /api/demo/session 恢复登录态。
 *   · **展示偏好留在本地**：语言 / 深浅色 / 展示名 / 头像纯属个人化设置，不涉及任何经营数据，
 *     继续按登录名分键存 localStorage（演示级，够用且不必为它加一张表）。
 */

import type { DemoOverview } from '@/lib/demo/types';

export type {
  DemoCampaignStat,
  DemoCreatorStat,
  DemoMaterialStat,
  DemoMetrics,
  DemoOverview,
  DemoPoolCreator,
  DemoProductSlotCell,
  DemoSummary,
  DemoTrendPoint,
} from '@/lib/demo/types';

export interface PortalUser {
  username: string;
  company: string;
}

/** 服务端在 overview 响应里附加的缓存信息。 */
export interface OverviewResponse extends DemoOverview {
  cachedAt: string;
  fromCache: boolean;
}

// ─────────────────────────── 服务端接口 ───────────────────────────

async function readError(resp: Response): Promise<string> {
  try {
    const body: unknown = await resp.json();
    if (body !== null && typeof body === 'object') {
      const msg = (body as Record<string, unknown>)['error'];
      if (typeof msg === 'string') return msg;
    }
  } catch {
    /* 非 JSON 响应：走下面的兜底文案 */
  }
  return `请求失败（HTTP ${resp.status.toString()}）`;
}

/** 登录。成功返回用户，失败返回错误文案。 */
export async function apiLogin(
  username: string,
  password: string,
): Promise<{ user: PortalUser } | { error: string }> {
  const resp = await fetch('/api/demo/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!resp.ok) return { error: await readError(resp) };
  return { user: (await resp.json()) as PortalUser };
}

/** 恢复登录态（cookie 是 httpOnly，只能问服务端）。 */
export async function apiSession(): Promise<PortalUser | null> {
  try {
    const resp = await fetch('/api/demo/session');
    if (!resp.ok) return null;
    const body = (await resp.json()) as { authenticated?: boolean } & PortalUser;
    return body.authenticated === true ? { username: body.username, company: body.company } : null;
  } catch {
    return null;
  }
}

export async function apiLogout(): Promise<void> {
  try {
    await fetch('/api/demo/session', { method: 'DELETE' });
  } catch {
    /* 网络异常也让前端登出，cookie 过期后自然失效 */
  }
}

/** 门户看板聚合区间（含首尾）。start/end 为 YYYY-MM-DD；不传即用服务端默认（近 14 天）。 */
export interface DateRange {
  start: string;
  end: string;
}

/** 拉门户全量只读数据。force=true 跳过服务端的小时级缓存；range 指定聚合区间。 */
export async function apiOverview(force = false, range?: DateRange): Promise<OverviewResponse> {
  const params = new URLSearchParams();
  if (force) params.set('refresh', '1');
  if (range) {
    params.set('start', range.start);
    params.set('end', range.end);
  }
  const qs = params.toString();
  const resp = await fetch(`/api/demo/overview${qs === '' ? '' : `?${qs}`}`);
  if (!resp.ok) throw new Error(await readError(resp));
  return (await resp.json()) as OverviewResponse;
}

// ─────────────────────────── 日期区间工具 ───────────────────────────

/** 本地今天 YYYY-MM-DD（门户按北京时区运营，浏览器本地时区差一天可接受，仅作选择器默认值）。 */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear().toString()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 从 anchor 往前推 days-1 天得到区间起点（含首尾共 days 天）。 */
export function shiftDayStr(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear().toString()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 近 n 天区间（含今天）。 */
export function lastNDays(n: number): DateRange {
  const end = todayStr();
  return { start: shiftDayStr(end, -(n - 1)), end };
}

// ─────────────────────────── 展示格式化 ───────────────────────────

/** 大数收敛成 12.3M / 45.6K，用于曝光、播放这类量级很大的指标。 */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

/** 整数千分位。 */
export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '-';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtUSD(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '-';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 比率 → 倍数文案（1.83 → 1.83x）。 */
export function fmtRatio(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '-';
  return `${n.toFixed(2)}x`;
}

/** 比率 → 百分比文案（0.0342 → 3.42%）。 */
export function fmtPct(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return '-';
  return `${(n * 100).toFixed(digits)}%`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** ISO 时间 → 北京时间 MM-DD HH:mm。 */
export function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '-';
  const d = new Date(t + 8 * 3_600_000);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * 由名字稳定派生一对渐变色 —— 创作者头像没有真实图片（FB 不给合作创作者的头像），
 * 用名字 hash 出固定配色 + 首字母，保证同一个创作者每次进来颜色一致。
 */
export function gradientOf(name: string): readonly [string, string] {
  const palette: readonly (readonly [string, string])[] = [
    ['#22d3ee', '#a855f7'],
    ['#ff3d81', '#fbbf24'],
    ['#a855f7', '#22d3ee'],
    ['#34d399', '#22d3ee'],
    ['#fbbf24', '#ff3d81'],
    ['#22d3ee', '#34d399'],
    ['#a855f7', '#ff3d81'],
    ['#38bdf8', '#818cf8'],
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + (name.codePointAt(i) ?? 0)) % 100_000;
  return palette[hash % palette.length] ?? ['#22d3ee', '#a855f7'];
}

/** 取首字母做头像文字：IG 用户名多是一串小写，取前两位比取词首更可读。 */
export function initials(name: string): string {
  const clean = name.replaceAll(/[^a-zA-Z一-龥]/g, '');
  return (clean.slice(0, 2) || name.slice(0, 2)).toUpperCase();
}

// ─────────────── 用户资料 / 偏好（localStorage，按登录名分键） ───────────────

export type Lang = 'zh' | 'en';
export type Theme = 'dark' | 'light';

/** 用户头像：渐变色 + 自定义字母，或上传的 1:1 图片（dataURL，已压到 128px）。 */
export interface UserAvatar {
  kind: 'gradient' | 'image';
  letters: string;
  gradient: readonly [string, string];
  image?: string;
}

/** 用户资料 + 偏好（与登录凭据分离；displayName 是展示用户名，非登录名）。 */
export interface Profile {
  displayName: string;
  avatar: UserAvatar;
  lang: Lang;
  theme: Theme;
}

/** 头像可选渐变预设。 */
export const AVATAR_GRADIENTS: readonly (readonly [string, string])[] = [
  ['#ff3d81', '#a855f7'],
  ['#22d3ee', '#4f7bff'],
  ['#34d399', '#22d3ee'],
  ['#fbbf24', '#ff3d81'],
  ['#a855f7', '#22d3ee'],
  ['#f87171', '#fbbf24'],
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? '';
  const b = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (a + b).toUpperCase() || 'U';
}

/** 由登录用户派生默认资料：展示名=公司名，头像=首字母渐变，中文 + 深色。 */
export function defaultProfile(company: string): Profile {
  return {
    displayName: company,
    avatar: {
      kind: 'gradient',
      letters: initialsOf(company),
      gradient: AVATAR_GRADIENTS[0] ?? ['#ff3d81', '#a855f7'],
    },
    lang: 'zh',
    theme: 'dark',
  };
}

const PROFILE_PREFIX = 'sitin_demo_profile_';

function sanitizeAvatar(a: unknown, fallback: UserAvatar): UserAvatar {
  if (typeof a !== 'object' || a === null) return fallback;
  const o = a as Record<string, unknown>;
  const img = o['image'];
  if (o['kind'] === 'image' && typeof img === 'string') {
    return { kind: 'image', letters: fallback.letters, gradient: fallback.gradient, image: img };
  }
  const lettersRaw = o['letters'];
  const letters =
    typeof lettersRaw === 'string' && lettersRaw !== '' ? lettersRaw : fallback.letters;
  let gradient: readonly [string, string] = fallback.gradient;
  const g = o['gradient'];
  if (Array.isArray(g)) {
    const g0: unknown = g[0];
    const g1: unknown = g[1];
    if (typeof g0 === 'string' && typeof g1 === 'string') gradient = [g0, g1];
  }
  return { kind: 'gradient', letters, gradient };
}

export function loadProfile(username: string, company: string): Profile {
  const fallback = defaultProfile(company);
  try {
    const raw = globalThis.localStorage.getItem(PROFILE_PREFIX + username);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Profile>;
    return {
      displayName:
        typeof parsed.displayName === 'string' && parsed.displayName !== ''
          ? parsed.displayName
          : fallback.displayName,
      avatar: sanitizeAvatar(parsed.avatar, fallback.avatar),
      lang: parsed.lang === 'en' ? 'en' : 'zh',
      theme: parsed.theme === 'light' ? 'light' : 'dark',
    };
  } catch {
    return fallback;
  }
}

export function saveProfile(username: string, profile: Profile): void {
  try {
    globalThis.localStorage.setItem(PROFILE_PREFIX + username, JSON.stringify(profile));
  } catch {
    /* 忽略：配额/隐私模式 */
  }
}
