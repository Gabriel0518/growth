/**
 * 鉴权 —— 复刻旧 dashboard/server.js 的 express-session + authCheck 语义。
 *
 * 旧实现：express-session（内存 store）+ 每次启动随机 secret（crypto.randomBytes）。
 * 可观测行为：登录种 cookie → 认证；进程重启 → 所有会话失效；7 天 httpOnly。
 *
 * 本实现：无状态 HMAC 签名 cookie，签名密钥优先取 SESSION_SECRET；未设置时从 admin 口令
 * 稳定派生（而非每进程随机），使会话在重启与多副本间保持一致——否则 replicas>1 时各副本
 * 密钥不同、且每次重启都换密钥，会导致「刷新即掉登录」。cookie/token 有效期 7 天。
 */

import crypto from 'node:crypto';

import { config } from '../config';

const SESSION_COOKIE = 'dashboard_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const SESSION_MAX_AGE_SEC = Math.floor(MAX_AGE_MS / 1000);

// 优先显式 SESSION_SECRET；缺省时从 admin 口令稳定派生（跨副本/重启一致），
// 避免旧版「每进程随机」造成会话频繁失效。生产建议仍显式配置 SESSION_SECRET。
const SECRET =
  process.env['SESSION_SECRET'] && process.env['SESSION_SECRET'].length > 0
    ? process.env['SESSION_SECRET']
    : crypto
        .createHmac('sha256', 'agentic-ug-dashboard/session-v1')
        .update(config.adminPass)
        .digest('hex');

export interface Session {
  authenticated: boolean;
  panelAccess: boolean;
  /** 历史飞书会话字段，仅用于兼容已有投手权限数据。 */
  openId?: string;
  /** 当前账号展示名，用于审计广告操作。 */
  name?: string;
}

interface TokenPayload {
  a: 0 | 1;
  p: 0 | 1;
  exp: number;
  // oid 仅兼容历史飞书会话；nm 是当前账号展示名。
  oid?: string;
  nm?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(data: string): string {
  return b64url(crypto.createHmac('sha256', SECRET).update(data).digest());
}

/** 通用「body.sig」签名序列化。 */
function encodeSigned(payload: object): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body)}`;
}

/** 校验签名并解出 JSON；签名不符 / 解析失败一律 undefined。过期由各调用方自行按 exp 判。 */
function decodeSigned(token: string): Record<string, unknown> | undefined {
  const dot = token.indexOf('.');
  if (dot === -1) return undefined;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(body);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 仅生成签名 token 值（供 next/headers cookies().set 使用）。 */
export function buildSessionToken(session: Session): string {
  const payload: TokenPayload = {
    a: session.authenticated ? 1 : 0,
    p: session.panelAccess ? 1 : 0,
    exp: Date.now() + MAX_AGE_MS,
  };
  // 可选字段存在才写，保持老 token 向后兼容。
  if (session.openId !== undefined) payload.oid = session.openId;
  if (session.name !== undefined) payload.nm = session.name;
  return encodeSigned(payload);
}

/** 序列化 Set-Cookie 值。 */
export function sessionCookie(session: Session): string {
  const token = buildSessionToken(session);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC.toString()}${secure}`;
}

/** 清除会话 cookie（登出）。 */
export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    out[key] = part.slice(eq + 1).trim();
  }
  return out;
}

function verifyToken(token: string): TokenPayload | undefined {
  const obj = decodeSigned(token);
  if (!obj) return undefined;
  const exp = obj['exp'];
  if (typeof exp !== 'number' || exp < Date.now()) return undefined;
  const payload: TokenPayload = {
    a: obj['a'] === 1 ? 1 : 0,
    p: obj['p'] === 1 ? 1 : 0,
    exp,
  };
  if (typeof obj['oid'] === 'string') payload.oid = obj['oid'];
  if (typeof obj['nm'] === 'string') payload.nm = obj['nm'];
  return payload;
}

/** 从请求读取会话状态（无/失效均返回未认证）。 */
export function readSession(request: Request): Session {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  const payload = token ? verifyToken(token) : undefined;
  if (!payload) return { authenticated: false, panelAccess: false };
  const session: Session = { authenticated: payload.a === 1, panelAccess: payload.p === 1 };
  if (payload.oid !== undefined) session.openId = payload.oid;
  if (payload.nm !== undefined) session.name = payload.nm;
  return session;
}

/**
 * 提取 M2M 口令：?key=<pass> 或 Authorization: Bearer <pass>。无则 null。
 * 复刻 extApiSecret。
 */
export function extApiSecret(request: Request): string | null {
  const key = new URL(request.url).searchParams.get('key');
  if (key) return key;
  const auth = request.headers.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

/** 定长比较，避免共享口令的时序泄漏。复刻 safeEqual。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function blockM2M(): boolean {
  return (process.env['GUARD_BLOCK_M2M'] ?? '1') === '1';
}

/** M2M 总闸关闭时的 503 响应。复刻 authCheck 的临时关闭分支。 */
function m2mBlockedResponse(): Response {
  return Response.json(
    {
      ok: false,
      error:
        'External machine data-pull API is temporarily disabled. Only the web dashboard is available right now.',
      hint: 'Contact the dashboard owner if you need programmatic access.',
    },
    { status: 503, headers: { 'Retry-After': '86400' } },
  );
}

/**
 * /api/* 路由鉴权：session 认证放行；否则校验 M2M 口令（默认总闸关闭 → 503）；
 * 都不满足 → 401 JSON。复刻 authCheck（/api/ 分支返回 401，而非重定向登录页）。
 * 返回 Session 表示放行；返回 Response 表示应直接回给客户端。
 */
export function requireApiAuth(request: Request): Session | Response {
  const session = readSession(request);
  if (session.authenticated) return session;
  const secret = extApiSecret(request);
  if (secret !== null && safeEqual(secret, config.adminPass)) {
    if (blockM2M()) return m2mBlockedResponse();
    return { authenticated: true, panelAccess: false };
  }
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}
