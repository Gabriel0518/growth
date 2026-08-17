/**
 * 飞书登录的存储层 —— 走 @agentic-ug/db 的 query/queryOne（$1 占位，绝不拼 SQL）。
 * 表结构见 packages/db 的 ensureAuthTables：fs_user（名录）+ login_challenge（一次性挑战）。
 */

import crypto from 'node:crypto';

import { query, queryOne } from '@agentic-ug/db';

/** 挑战有效期 3 分钟：与规格一致，过期以 PG 的 expires_at 为准，不靠进程时钟。 */
const TTL_MINUTES = 3;

export interface FsUser {
  openId: string;
  name: string;
}

export type ChallengePurpose = 'login' | 'sensitive';
export type ChallengeStatus = 'pending' | 'confirmed' | 'rejected' | 'expired';

export interface Challenge {
  nonce: string;
  openId: string;
  purpose: string;
  status: ChallengeStatus;
  detail: string | null;
}

/** upsert 名录：open_id 为主键，重复登录刷新姓名/头像/union_id 与 updated_at。 */
export async function upsertUser(user: {
  openId: string;
  name: string;
  unionId?: string | null;
  avatarUrl?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO fs_user (open_id, name, union_id, avatar_url, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (open_id) DO UPDATE
       SET name = EXCLUDED.name,
           union_id = EXCLUDED.union_id,
           avatar_url = EXCLUDED.avatar_url,
           updated_at = now()`,
    [user.openId, user.name, user.unionId ?? null, user.avatarUrl ?? null],
  );
}

/** 二次登录下拉用：按姓名排序列出已授权用户。 */
export async function listUsers(): Promise<FsUser[]> {
  const rows = await query<{ open_id: string; name: string }>(
    `SELECT open_id, name FROM fs_user ORDER BY name`,
  );
  return rows.map((r) => ({ openId: r.open_id, name: r.name }));
}

/**
 * 保存飞书身份信息到投手信息表（upsert，独立新表，不动 fs_user）。
 * 权限校验（ad/auth.ts）从本表读取 email、departments 做白名单判断。
 */
export async function upsertOperatorProfile(identity: {
  openId: string;
  email: string | null;
  departments: string[];
}): Promise<void> {
  await query(
    `INSERT INTO ad_operator_profile (open_id, email, departments, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (open_id) DO UPDATE
       SET email = EXCLUDED.email,
           departments = EXCLUDED.departments,
           updated_at = now()`,
    [identity.openId, identity.email, JSON.stringify(identity.departments)],
  );
}

/** 校验某 open_id 是否已授权（二次登录 pick 时用）。 */
export async function getUser(openId: string): Promise<FsUser | undefined> {
  const row = await queryOne<{ open_id: string; name: string }>(
    `SELECT open_id, name FROM fs_user WHERE open_id = $1`,
    [openId],
  );
  return row ? { openId: row.open_id, name: row.name } : undefined;
}

/** 新建一次性挑战，返回 nonce（卡片按钮里带它回来）。 */
export async function createChallenge(
  openId: string,
  purpose: ChallengePurpose = 'login',
  detail: string | null = null,
): Promise<string> {
  // 前缀 + 5 字节随机，短到能塞进卡片校验码展示，又足够防猜。
  const nonce = `LC-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  await query(
    `INSERT INTO login_challenge (nonce, open_id, purpose, status, detail, expires_at)
     VALUES ($1, $2, $3, 'pending', $4, now() + make_interval(mins => $5))`,
    [nonce, openId, purpose, detail, TTL_MINUTES],
  );
  return nonce;
}

/** 读挑战：pending 且已过 expires_at 的直接以 'expired' 返回（判定落在 SQL，用 DB 时钟）。 */
export async function getChallenge(nonce: string): Promise<Challenge | undefined> {
  const row = await queryOne<{
    nonce: string;
    open_id: string;
    purpose: string;
    status: string;
    detail: string | null;
  }>(
    `SELECT nonce, open_id, purpose,
            CASE WHEN status = 'pending' AND now() > expires_at THEN 'expired' ELSE status END AS status,
            detail
       FROM login_challenge
      WHERE nonce = $1`,
    [nonce],
  );
  if (!row) return undefined;
  return {
    nonce: row.nonce,
    openId: row.open_id,
    purpose: row.purpose,
    status: normalizeStatus(row.status),
    detail: row.detail,
  };
}

/** 标记挑战状态：仅 pending 可流转（一次性），confirmed/rejected 后不可再改。 */
export async function markChallenge(nonce: string, status: 'confirmed' | 'rejected'): Promise<void> {
  await query(`UPDATE login_challenge SET status = $2 WHERE nonce = $1 AND status = 'pending'`, [
    nonce,
    status,
  ]);
}

function normalizeStatus(raw: string): ChallengeStatus {
  switch (raw) {
    case 'confirmed':
    case 'rejected':
    case 'expired':
    case 'pending': {
      return raw;
    }
    default: {
      // 理论不会到这，DB 里 status 受控于本模块写入；兜底当 expired 处理更安全。
      return 'expired';
    }
  }
}
