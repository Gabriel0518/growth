/**
 * Token 内存服务 —— 单例，进程内维护所有可用的广告账户配置。
 *
 * - 启动时从 ad_fb_token 加载全部 token 及关联广告账户
 * - 提供 AdAccountConfig 列表供前端选择器和 API 查询使用
 * - 增删改时必须同步刷新内存（调用 reload）
 * - 每个 AdAccountConfig = 一个广告账户 + 其所属 token 凭据
 */

import { query } from '@agentic-ug/db';


import { logger } from './logger';
// ── 类型 ──

/** 内存中的广告账户配置：含该账户所属 token 的所有凭据信息 */
export interface AdAccountConfig {
  /** 广告账户 ID，例如 act_646387524897026 */
  accountId: string;
  /** 广告账户名称 */
  accountName: string;
  /** 广告账户状态：1=正常 2=禁用 ... 101=暂不可用 */
  accountStatus: number;
  /** 所属 token 的数据库 ID */
  tokenId: number;
  /** 所属 token 的名称（用户自定义名或 BM 名） */
  tokenName: string;
  /** Bearer token */
  token: string;
  /** App ID */
  appId: string;
  /** App Secret */
  appSecret: string;
  /** Token 有 ADVERTISE 权限的 Page 列表 */
  availablePages: { id: string; name: string; tasks: string[]; igBusinessAccount?: { id: string; username: string } | null }[];
}

// ── 内存存储 ──

let accountsCache: AdAccountConfig[] = [];
let loaded = false;

// ── 对外接口 ──

/** 从数据库重新加载所有 token 并展开为广告账户列表 */
export async function reloadTokenService(): Promise<void> {
  const rows = await query<{
    id: number;
    token: string;
    app_id: string;
    app_secret: string;
    name: string | null;
    bm_name: string | null;
    ad_accounts: unknown;
    available_pages: unknown;
  }>(
    `SELECT id, token, app_id, app_secret, name, bm_name, ad_accounts, available_pages
       FROM ad_fb_token
      WHERE is_active = true
      ORDER BY id`,
  );

  const result: AdAccountConfig[] = [];
  for (const row of rows) {
    const tokenName = row.name ?? row.bm_name ?? `Token #${String(row.id)}`;
    const accounts = parseAdAccounts(row.ad_accounts);
    const pages = parseAvailablePages(row.available_pages);
    for (const acct of accounts) {
      result.push({
        accountId: acct.id,
        accountName: acct.name,
        accountStatus: acct.status,
        tokenId: row.id,
        tokenName,
        token: row.token,
        appId: row.app_id,
        appSecret: row.app_secret,
        availablePages: pages,
      });
    }
  }

  accountsCache = result;
  loaded = true;
  logger.info(
    `[token-service] 已加载 ${String(rows.length)} 个 token，共 ${String(result.length)} 个广告账户`,
  );
}

/** 获取所有已加载的广告账户配置（确保已初始化） */
export async function getAdAccountConfigs(): Promise<AdAccountConfig[]> {
  if (!loaded) await reloadTokenService();
  return accountsCache;
}

/** 按广告账户 ID 查找单个配置 */
export async function getAdAccountConfig(
  accountId: string,
): Promise<AdAccountConfig | undefined> {
  const all = await getAdAccountConfigs();
  return all.find((a) => a.accountId === accountId);
}

/** 按 token ID 查找该 token 下的所有广告账户配置 */
export async function getConfigsByTokenId(tokenId: number): Promise<AdAccountConfig[]> {
  const all = await getAdAccountConfigs();
  return all.filter((a) => a.tokenId === tokenId);
}

/** 强制重置（供测试或 DB 变更后调用） */
export function resetTokenService(): void {
  accountsCache = [];
  loaded = false;
}

// ── 内部 ──

interface RawAccount {
  id: string;
  name: string;
  status: number;
}

function parseAdAccounts(raw: unknown): RawAccount[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is RawAccount =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as Record<string, unknown>)['id'] === 'string',
  );
}

interface RawPage {
  id: string;
  name: string;
  tasks: string[];
  igBusinessAccount?: { id: string; username: string } | null;
}

function parseAvailablePages(raw: unknown): RawPage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is RawPage =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as Record<string, unknown>)['id'] === 'string',
  );
}
