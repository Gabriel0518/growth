/**
 * 方案 C 登录原型 —— 飞书封装 + 存储
 * 端口 8099，独立服务，不碰生产 8081。
 */
import Database from 'better-sqlite3';
import * as Lark from '@larksuiteoapi/node-sdk';
import crypto from 'node:crypto';

export const APP_ID = process.env.FS_APP_ID || 'cli_aad2ec939cb9dce9';
export const APP_SECRET = process.env.FS_APP_SECRET || '';

export const larkClient = new Lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

// ---------- SQLite ----------
const db = new Database('/home/admin/login-poc/poc.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS fs_user (
    open_id TEXT PRIMARY KEY,
    name    TEXT,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS login_challenge (
    nonce   TEXT PRIMARY KEY,
    open_id TEXT,
    purpose TEXT,          -- 'login' | 'sensitive'
    status  TEXT,          -- 'pending' | 'confirmed' | 'rejected'
    detail  TEXT,          -- 敏感操作描述
    created_at INTEGER,
    expires_at INTEGER
  );
`);

export function upsertUser(openId, name) {
  db.prepare(`INSERT INTO fs_user(open_id,name,created_at) VALUES(?,?,?)
              ON CONFLICT(open_id) DO UPDATE SET name=excluded.name`)
    .run(openId, name, Date.now());
}
export function listUsers() {
  return db.prepare(`SELECT open_id,name FROM fs_user ORDER BY name`).all();
}
export function getUser(openId) {
  return db.prepare(`SELECT open_id,name FROM fs_user WHERE open_id=?`).get(openId);
}

// ---------- 登录挑战（nonce）----------
const TTL_MS = 3 * 60 * 1000; // 3 分钟一次性
export function createChallenge(openId, purpose = 'login', detail = '') {
  const nonce = 'LC-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const now = Date.now();
  db.prepare(`INSERT INTO login_challenge(nonce,open_id,purpose,status,detail,created_at,expires_at)
              VALUES(?,?,?,?,?,?,?)`)
    .run(nonce, openId, purpose, 'pending', detail, now, now + TTL_MS);
  return nonce;
}
export function getChallenge(nonce) {
  const c = db.prepare(`SELECT * FROM login_challenge WHERE nonce=?`).get(nonce);
  if (!c) return null;
  if (c.status === 'pending' && Date.now() > c.expires_at) { c.status = 'expired'; }
  return c;
}
export function markChallenge(nonce, status) {
  db.prepare(`UPDATE login_challenge SET status=? WHERE nonce=? AND status='pending'`).run(status, nonce);
}

// ---------- OAuth ----------
export function buildAuthUrl(redirectUri, state) {
  const u = new URL('https://open.feishu.cn/open-apis/authen/v1/authorize');
  u.searchParams.set('app_id', APP_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'contact:user.base:readonly');
  u.searchParams.set('state', state);
  return u.toString();
}

/** code -> { openId, name } */
export async function exchangeCode(code) {
  // 换 user_access_token
  const tok = await larkClient.authen.accessToken.create({ data: { grant_type: 'authorization_code', code } });
  const uat = tok.data?.access_token;
  // 拿用户信息
  const info = await larkClient.authen.userInfo.get({}, Lark.withUserAccessToken(uat));
  const d = info.data || {};
  return { openId: d.open_id, name: d.name, avatar: d.avatar_url };
}

// ---------- 发确认卡片 ----------
export async function sendConfirmCard(openId, { nonce, purpose, detail, name }) {
  const isSensitive = purpose === 'sensitive';
  const title = isSensitive ? '⚠️ 敏感操作确认' : '🔐 登录确认';
  const body = isSensitive
    ? `有一个操作需要你确认：\n\n**${detail || '敏感操作'}**\n\n校验码 \`${nonce}\``
    : `有一个网页端正在请求以 **${name || '你'}** 的身份登录 **Sitin 仪表板**。\n\n校验码 \`${nonce}\``;
  const card = {
    config: { wide_screen_mode: true },
    header: { template: isSensitive ? 'orange' : 'blue', title: { tag: 'plain_text', content: title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      { tag: 'hr' },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: isSensitive ? '✅ 确认执行' : '✅ 确认登录' }, type: 'primary', value: { action: 'confirm', nonce } },
        { tag: 'button', text: { tag: 'plain_text', content: '✖️ 拒绝' }, type: 'danger', value: { action: 'reject', nonce } },
      ]},
      { tag: 'note', elements: [{ tag: 'plain_text', content: '3 分钟内有效，请确认是本人操作。' }] },
    ],
  };
  const r = await larkClient.im.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
  });
  return r.data?.message_id;
}
