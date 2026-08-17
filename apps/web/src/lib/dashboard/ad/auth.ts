/**
 * 投放操作权限校验 —— Demo 阶段：飞书部门 + 邮箱前缀白名单双通道。
 *
 * 规则（满足任一即通过）：
 *   1. 飞书部门包含「投放」
 *   2. 邮箱前缀在硬编码白名单 {max, zhoupeijie, dingzhihao} 中
 *
 * ad_operator_profile 表中无记录时，主动调飞书通讯录 API 补全后重试。
 * 不通过返回 403 Response，调用方直接 return。
 */

import { query } from '@agentic-ug/db';

import { logger } from './logger';

import type { Session } from '@/lib/dashboard/auth';
import { fetchUserProfileByOpenId } from '@/lib/feishu/client';


/** Demo 阶段硬编码的邮箱前缀白名单。 */
const EMAIL_PREFIX_WHITELIST = new Set(['max', 'zhoupeijie', 'dingzhihao']);

/** Demo 阶段部门白名单（包含匹配，不要求完全相等）。 */
const ALLOWED_DEPARTMENT_KEYWORD = '投放';

/**
 * 校验当前用户是否有投放操作权限。
 * 不通过返回 Response（403），通过返回 undefined。
 * 用法：在 requireApiAuth 之后、业务逻辑之前调用。
 *
 *   const perm = await requireAdOperator(auth);
 *   if (perm instanceof Response) return perm;
 */
export async function requireAdOperator(session: Session): Promise<Response | undefined> {
  if (!session.authenticated) {
    return Response.json({ error: '未登录' }, { status: 401 });
  }

  const openId = session.openId;
  if (!openId) {
    return Response.json(
      { error: '投放管理仅支持飞书登录，请使用飞书账号登录后再操作' },
      { status: 403 },
    );
  }

  const { email, departments } = await resolveProfile(openId);

  // 规则 1：部门匹配
  if (departments.some((d) => d.includes(ALLOWED_DEPARTMENT_KEYWORD))) {
    return; // 通过
  }

  // 规则 2：邮箱前缀匹配
  if (email) {
    const prefix = email.split('@')[0]?.toLowerCase();
    if (prefix && EMAIL_PREFIX_WHITELIST.has(prefix)) {
      return; // 通过
    }
  }

  return Response.json(
    {
      error: '无投放操作权限。当前仅对投放部门成员及授权人员开放。',
      detail: '如需开通，请联系管理员（屹恒）。',
    },
    { status: 403 },
  );
}

// ── 内部 ──

interface ProfileRow {
  email: string | null;
  departments: string[];
}

/**
 * 获取用户投手信息：优先从 ad_operator_profile 取；
 * 表中无记录时调飞书通讯录 API 补全后回写。
 */
async function resolveProfile(openId: string): Promise<ProfileRow> {
  // Lazy import：避免顶层循环依赖
  const { queryOne } = await import('@agentic-ug/db');

  const row = await queryOne<{ email: string | null; departments: unknown }>(
    `SELECT email, departments FROM ad_operator_profile WHERE open_id = $1`,
    [openId],
  );

  // 如果已有记录且 departments 非空且不是原始 ID（如 od-xxx），直接返回缓存
  if (row) {
    const deps = parseStringArray(row.departments);
    if (deps.length > 0 && !deps.every((d) => d.startsWith('od-'))) {
      return { email: row.email, departments: deps };
    }
    // departments 为空或全是原始 ID → 主动重查飞书通讯录补全
  }

  // 主动调飞书通讯录接口补全
  const profile = await fetchUserProfileByOpenId(openId);
  if (!profile) {
    return { email: null, departments: [] };
  }

  // 回写 ad_operator_profile（后续请求直接命中本地表）
  try {
    await query(
      `INSERT INTO ad_operator_profile (open_id, email, departments, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (open_id) DO UPDATE
         SET email = EXCLUDED.email,
             departments = EXCLUDED.departments,
             updated_at = now()`,
      [openId, profile.email, JSON.stringify(profile.departments)],
    );
  } catch (error) {
    logger.error('[ad/auth] 回写 ad_operator_profile 失败：', error);
  }

  return { email: profile.email, departments: profile.departments };
}

/** 安全解析 JSONB 数组为 string[]。 */
function parseStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}
