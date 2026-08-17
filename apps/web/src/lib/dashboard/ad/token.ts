/**
 * FB Token（凭据）管理 —— 增删改查 + 自动验证并拉取 BM 信息。
 *
 * 每套 token 对应一个 System User，每个 System User 挂在某个 BM 下。
 * 新增时自动调 FB API 查所属 BM 并回填 bm_id / bm_name。
 */

import { query, queryOne } from '@agentic-ug/db';
import { queryAdAccounts, queryBusinessManager, validateToken } from '@agentic-ug/fetcher';

import { logger } from './logger';
import { reloadTokenService } from './token-service';

// ── 类型 ──

export interface AvailablePage {
  id: string;
  name: string;
  tasks: string[];
}

export interface FbTokenRow {
  id: number;
  token: string;
  app_id: string;
  app_secret: string;
  bm_id: string | null;
  bm_name: string | null;
  name: string | null;
  ad_accounts: unknown;
  available_pages: unknown;
  is_active: boolean;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 对外返回时脱敏：token/app_secret 仅展示前后各 8 个字符，中间用 * 代替。 */
export interface FbTokenPublic extends Omit<FbTokenRow, 'token' | 'app_secret'> {
  token_preview: string;
  app_secret_preview: string;
}

const ROW_SQL = `SELECT id, token, app_id, app_secret, bm_id, bm_name, name,
                        ad_accounts,
                        available_pages,
                        is_active,
                        to_char(last_checked_at, 'YYYY-MM-DD HH24:MI:SS') AS last_checked_at,
                        to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
                        to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
                   FROM ad_fb_token`;

function toPublic(row: FbTokenRow): FbTokenPublic {
  return {
    ...row,
    token_preview: mask(row.token),
    app_secret_preview: mask(row.app_secret),
  };
}

function mask(secret: string): string {
  if (secret.length <= 16) return '***';
  return `${secret.slice(0, 8)}...${secret.slice(-8)}`;
}

// ── 查询 token 可用 Pages ──

/** 调 FB /me/accounts 查询 token 有 ADVERTISE 权限的 Page 列表 */
export async function queryAvailablePages(token: string): Promise<AvailablePage[]> {
  logger.info('[ad/token] 开始查询 token 可用 Pages …');

  try {
    const url = new URL('https://graph.facebook.com/v25.0/me/accounts');
    url.searchParams.set('fields', 'id,name,tasks,instagram_business_account{id,username}');
    url.searchParams.set('access_token', token);

    const res = await fetch(url.toString());
    const data = (await res.json()) as {
      data?: {
        id: string;
        name: string;
        tasks: string[];
        instagram_business_account?: { id: string; username: string };
      }[];
      error?: { message: string };
    };

    if (!res.ok || data.error) {
      logger.warn(`[ad/token] 查询 Pages 失败: ${data.error?.message ?? `HTTP ${String(res.status)}`}`);
      return [];
    }

    const pages = (data.data ?? [])
      .filter((p) => Array.isArray(p.tasks) && p.tasks.includes('ADVERTISE'))
      .map((p) => ({
        id: p.id,
        name: p.name,
        tasks: p.tasks,
        igBusinessAccount: p.instagram_business_account?.id
          ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username }
          : null,
      }));

    logger.info(`[ad/token] 找到 ${String(pages.length)} 个有 ADVERTISE 权限的 Page`);
    return pages;
  } catch (error_: unknown) {
    logger.warn(`[ad/token] 查询 Pages 异常: ${error_ instanceof Error ? error_.message : String(error_)}`);
    return [];
  }
}

// ── 查询 ──

export async function listFbTokens(): Promise<FbTokenPublic[]> {
  const rows = await query<FbTokenRow>(`${ROW_SQL} ORDER BY created_at DESC`);
  return rows.map((r) => toPublic(r));
}

export async function getFbToken(id: number): Promise<FbTokenPublic | undefined> {
  const row = await queryOne<FbTokenRow>(`${ROW_SQL} WHERE id = $1`, [id]);
  return row ? toPublic(row) : undefined;
}

// ── 新增 ──

export interface CreateFbTokenInput {
  token: string;
  app_id: string;
  app_secret: string;
  name?: string;
}

export async function createFbToken(input: CreateFbTokenInput): Promise<FbTokenPublic> {
  // 1. 验证 token 有效性
  logger.info('[ad/token] 开始验证 token …');
  const valid = await validateToken(input.token);
  logger.info(`[ad/token] token 有效: userId=${valid.userId} userName=${valid.userName}`);

  // 2. 查所属 BM + 广告账户 + 可用 Pages
  logger.info('[ad/token] 开始查询 BM、广告账户和 Pages …');
  const [bm, accounts, pages] = await Promise.all([
    queryBusinessManager(input.token).catch(() => null),
    queryAdAccounts(input.token).catch(() => []),
    queryAvailablePages(input.token),
  ]);

  const bmId = bm?.bmId ?? null;
  const bmName = bm?.bmName ?? null;
  const displayName = input.name ?? bmName ?? null;
  const adAccounts = accounts.map((a) => ({ id: a.id, name: a.name, status: a.account_status }));

  // 3. 入库
  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO ad_fb_token (token, app_id, app_secret, bm_id, bm_name, name, ad_accounts, available_pages, is_active, last_checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, now())
     RETURNING id`,
    [input.token, input.app_id, input.app_secret, bmId, bmName, displayName, JSON.stringify(adAccounts), JSON.stringify(pages)],
  );
  if (!inserted) throw new Error('token 创建失败');

  // 回读完整行数据
  const result = await queryOne<FbTokenRow>(`${ROW_SQL} WHERE id = $1`, [inserted.id]);
  if (!result) throw new Error('token 创建后回读失败');

  // 同步内存
  await reloadTokenService().catch((_error: unknown) => {
    logger.error('[ad/token] 刷新内存 Token Service 失败：', _error instanceof Error ? _error.message : String(_error));
  });

  return toPublic(result);
}

// ── 更新 ──

export interface UpdateFbTokenInput {
  token?: string;
  app_id?: string;
  app_secret?: string;
  name?: string;
}

export async function updateFbToken(id: number, input: UpdateFbTokenInput): Promise<FbTokenPublic> {
  const existing = await queryOne<FbTokenRow>(`SELECT * FROM ad_fb_token WHERE id = $1`, [id]);
  if (!existing) throw new Error('token 不存在');

  // 如果改了 token 或 app 凭据，需要验证新值有效性
  const tokenToCheck = input.token ?? existing.token;
  if (input.token !== undefined || input.app_id !== undefined) {
    await validateToken(tokenToCheck);
  }

  // 如果 token 变了，重新查 BM + 广告账户 + Pages
  let bmId = existing.bm_id;
  let bmName = existing.bm_name;
  let adAccountsJson: string | undefined;
  let pagesJson: string | undefined;
  if (input.token !== undefined) {
    const [bm, accounts, pages] = await Promise.all([
      queryBusinessManager(tokenToCheck).catch(() => null),
      queryAdAccounts(tokenToCheck).catch(() => []),
      queryAvailablePages(tokenToCheck),
    ]);
    bmId = bm?.bmId ?? null;
    bmName = bm?.bmName ?? null;
    adAccountsJson = JSON.stringify(
      accounts.map((a) => ({ id: a.id, name: a.name, status: a.account_status })),
    );
    pagesJson = JSON.stringify(pages);
  }

  const fields: string[] = [];
  const values: (string | null)[] = [];
  let idx = 1;

  if (input.token !== undefined) {
    fields.push(`token = $${String(idx++)}`);
    values.push(input.token);
  }
  if (input.app_id !== undefined) {
    fields.push(`app_id = $${String(idx++)}`);
    values.push(input.app_id);
  }
  if (input.app_secret !== undefined) {
    fields.push(`app_secret = $${String(idx++)}`);
    values.push(input.app_secret);
  }
  if (input.name !== undefined) {
    fields.push(`name = $${String(idx++)}`);
    values.push(input.name);
  }
  if (input.token !== undefined && bmId !== existing.bm_id) {
    fields.push(`bm_id = $${String(idx++)}`);
    values.push(bmId);
    fields.push(`bm_name = $${String(idx++)}`);
    values.push(bmName);
  }
  if (adAccountsJson !== undefined) {
    fields.push(`ad_accounts = $${String(idx++)}`);
    values.push(adAccountsJson);
  }
  if (pagesJson !== undefined) {
    fields.push(`available_pages = $${String(idx++)}`);
    values.push(pagesJson);
  }

  if (fields.length === 0) {
    // 什么都没改，直接返回
    const row = await getFbToken(id);
    if (!row) throw new Error('token 不存在');
    return row;
  }

  fields.push(`last_checked_at = now()`, `updated_at = now()`);
  values.push(String(id));

  await query(
    `UPDATE ad_fb_token SET ${fields.join(', ')} WHERE id = $${String(idx)}`,
    values,
  );

  const row = await getFbToken(id);
  if (!row) throw new Error('更新后回读失败');

  await reloadTokenService().catch((_error: unknown) => {
    logger.error('[ad/token] 刷新内存 Token Service 失败：', _error instanceof Error ? _error.message : String(_error));
  });

  return row;
}

// ── 刷新 ──

/** 刷新 token：重新验证 + 拉取 BM/广告账户/Pages 并写回数据库 */
export async function refreshFbToken(id: number): Promise<FbTokenPublic> {
  const existing = await queryOne<FbTokenRow>(`SELECT * FROM ad_fb_token WHERE id = $1`, [id]);
  if (!existing) throw new Error('token 不存在');

  logger.info(`[ad/token] 开始刷新 token #${String(id)} …`);

  // 验证 token 有效性
  const valid = await validateToken(existing.token);
  logger.info(`[ad/token] token 有效: userId=${valid.userId} userName=${valid.userName}`);

  // 重新查询 BM、广告账户、Pages
  const [bm, accounts, pages] = await Promise.all([
    queryBusinessManager(existing.token).catch(() => null),
    queryAdAccounts(existing.token).catch(() => []),
    queryAvailablePages(existing.token),
  ]);

  const bmId = bm?.bmId ?? null;
  const bmName = bm?.bmName ?? null;
  const adAccountsJson = JSON.stringify(
    accounts.map((a) => ({ id: a.id, name: a.name, status: a.account_status })),
  );
  const pagesJson = JSON.stringify(pages);

  await query(
    `UPDATE ad_fb_token
        SET bm_id = $1,
            bm_name = $2,
            ad_accounts = $3,
            available_pages = $4,
            last_checked_at = now(),
            updated_at = now()
      WHERE id = $5`,
    [bmId, bmName, adAccountsJson, pagesJson, String(id)],
  );

  logger.info(`[ad/token] token #${String(id)} 刷新完成: BM=${bmName ?? '-'}, 账户=${String(accounts.length)}, Pages=${String(pages.length)}`);

  const row = await getFbToken(id);
  if (!row) throw new Error('刷新后回读失败');

  await reloadTokenService().catch((_error: unknown) => {
    logger.error('[ad/token] 刷新内存 Token Service 失败：', _error instanceof Error ? _error.message : String(_error));
  });

  return row;
}

// ── 删除 ──

export async function deleteFbToken(id: number): Promise<void> {
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM ad_fb_token WHERE id = $1`,
    [id],
  );
  if (!existing) throw new Error('token 不存在');
  await query(`DELETE FROM ad_fb_token WHERE id = $1`, [id]);

  await reloadTokenService().catch((_error: unknown) => {
    logger.error('[ad/token] 刷新内存 Token Service 失败：', _error instanceof Error ? _error.message : String(_error));
  });
}
