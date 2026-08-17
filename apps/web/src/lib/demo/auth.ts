/**
 * sitin.ai 客户门户（/demo）的独立鉴权 —— 与主站飞书 session 完全隔离。
 *
 * 为什么不复用 dashboard_session：门户面向外部客户、只该看到合创(partnership)那一小块，
 * 拿到它的 cookie 绝不能反过来进主站看板；反之主站 token 也不该直接当门户凭证使。所以
 * cookie 名、payload 结构、HMAC 派生盐**三者都独立**——即便把主站 token 原样塞进门户
 * cookie 名下，签名盐不同 + payload 缺 `u` 字段，两道都过不了。
 *
 * 密钥来源与主站一致（SESSION_SECRET 优先，缺省从 admin 口令稳定派生），保证多副本/重启
 * 后会话不失效；在此之上再派生一层门户专用盐。
 *
 * 凭据**存数据库**（demo_portal_user 表，明文口令，屹恒定：门户是对外只读演示，账密直接落库、
 * 服务端逐字比对，不走环境变量、不引哈希）。口令比对走 timingSafeEqual，不做 `===`；口令绝不
 * 出现在 cookie/响应里，cookie 只带用户名与展示公司名。要加账号直接往表里 INSERT 即可。
 */

import crypto from 'node:crypto';

import { ensureDemoUserTable, getPool, queryOne } from '@agentic-ug/db';

import { config } from '../config';

const DEMO_COOKIE = 'sitin_demo_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const DEMO_COOKIE_NAME = DEMO_COOKIE;
export const DEMO_MAX_AGE_SEC = Math.floor(MAX_AGE_MS / 1000);

/** 门户展示用公司名的兜底（老 cookie 无 `c` 字段时用）。 */
const FALLBACK_COMPANY = 'sitin.ai';

// 与主站同源的根密钥，再派生一层门户专用盐：两套 token 的签名互不通用。
const ROOT_SECRET =
  process.env['SESSION_SECRET'] !== undefined && process.env['SESSION_SECRET'].length > 0
    ? process.env['SESSION_SECRET']
    : crypto
        .createHmac('sha256', 'agentic-ug-dashboard/session-v1')
        .update(config.adminPass)
        .digest('hex');

const DEMO_SECRET = crypto
  .createHmac('sha256', 'sitin-demo-portal/session-v1')
  .update(ROOT_SECRET)
  .digest();

export interface DemoSession {
  username: string;
  company: string;
}

interface DemoTokenPayload {
  /** 用户名。主站 token 无此字段，是两套 token 不可互换的第二道闸。 */
  u: string;
  /** 展示公司名，落 cookie 免得每次 session 恢复都查库。 */
  c: string;
  exp: number;
}

interface DemoUserRow {
  username: string;
  password: string;
  company: string;
}

function sign(body: string): string {
  return crypto.createHmac('sha256', DEMO_SECRET).update(body).digest('base64url');
}

/** 定长比较，避免口令比对被计时侧信道区分前缀。长度不同直接判否（长度本身不是秘密）。 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 校验门户账号口令（查 demo_portal_user 表，明文逐字比对），通过返回会话，否则 null。
 * 首次调用会幂等建表 + 种默认账号，保证零配置也能登录。用户名不存在时用一次定长假比对
 * 消耗掉时间，避免「用户名是否存在」从响应耗时上泄漏。
 */
export async function verifyCredentials(
  username: string,
  password: string,
): Promise<DemoSession | null> {
  await ensureDemoUserTable(getPool());
  const row = await queryOne<DemoUserRow>(
    `SELECT username, password, company FROM demo_portal_user WHERE username = $1`,
    [username.trim()],
  );
  if (row === undefined) {
    // 账号不存在也做一次比对，抹平存在/不存在两种情况的耗时差异。
    safeEqual(password, password);
    return null;
  }
  if (!safeEqual(password, row.password)) return null;
  return { username: row.username, company: row.company };
}

/** 序列化 Set-Cookie 值（httpOnly，前端拿不到，也就不存在明文落 localStorage 的问题）。 */
export function demoSessionCookie(session: DemoSession): string {
  const payload: DemoTokenPayload = {
    u: session.username,
    c: session.company,
    exp: Date.now() + MAX_AGE_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${body}.${sign(body)}`;
  return `${DEMO_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEMO_MAX_AGE_SEC.toString()}`;
}

/** 清除门户 cookie（登出）。 */
export function clearDemoSessionCookie(): string {
  return `${DEMO_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === null) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** 从请求读门户会话；无 cookie / 签名不符 / 过期一律 null。 */
export function readDemoSession(request: Request): DemoSession | null {
  const token = parseCookies(request.headers.get('cookie'))[DEMO_COOKIE];
  if (token === undefined) return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const user = obj['u'];
  const exp = obj['exp'];
  if (typeof user !== 'string' || typeof exp !== 'number' || exp < Date.now()) return null;
  const company = typeof obj['c'] === 'string' && obj['c'] !== '' ? obj['c'] : FALLBACK_COMPANY;
  return { username: user, company };
}

/**
 * 门户 API 统一入口守卫：未登录直接返回 401 Response，调用方 `if (x instanceof Response) return x`。
 * 真实经营数据（消耗/收入/创作者名单）全在这道闸之后，前端登录只是 UI 状态、不承担鉴权。
 */
export function requireDemoAuth(request: Request): DemoSession | Response {
  const session = readDemoSession(request);
  if (session === null) {
    return Response.json({ error: '未登录或会话已过期' }, { status: 401 });
  }
  return session;
}
