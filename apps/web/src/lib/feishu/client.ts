/**
 * 飞书封装 —— OAuth 授权 URL、code 换身份、推确认卡片。
 * 交互方式（authorize v1 / accessToken / userInfo / interactive 卡片）均按已实测原型照搬，
 * 不要自行改成扫码或免登跳转（规格明确要求）。
 */

import * as Lark from '@larksuiteoapi/node-sdk';

import { config } from '@/lib/config';

// 懒构造：Lark.Client 构造时即校验 appId/appSecret，缺失会抛。若在模块顶层 new，
// next build「收集页面数据」阶段（无 FEISHU_* 环境变量）import 路由就会崩。
// 因此延迟到首次真正调用时再建，并缓存单例。
let cachedClient: Lark.Client | undefined;

/** 取 bot 应用身份客户端（首次调用时构造，需 FEISHU_APP_ID/SECRET）。 */
export function getLarkClient(): Lark.Client {
  cachedClient ??= new Lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  });
  return cachedClient;
}

/** 拼 OAuth 授权 URL（v1 authorize）。redirect_uri 用对外基址，须在飞书后台白名单里。 */
export function buildAuthUrl(state: string): string {
  const url = new URL('https://open.feishu.cn/open-apis/authen/v1/authorize');
  url.searchParams.set('app_id', config.feishu.appId);
  url.searchParams.set('redirect_uri', `${config.baseUrl}/auth/callback`);
  url.searchParams.set(
    'scope',
    'contact:user.base:readonly contact:user.email:readonly contact:user.employee:readonly contact:user.department:readonly',
  );
  url.searchParams.set('state', state);
  return url.toString();
}

export interface FeishuIdentity {
  openId: string;
  name: string;
  email: string | null;
  departments: string[];
  unionId: string | null;
  avatarUrl: string | null;
}

/**
 * code → 用户身份。两步：authorization_code 换 user_access_token，再拿 userInfo。
 * 邮箱反查 open_id 不可靠，所以靠 OAuth 直接拿 open_id（勿改回邮箱反查）。
 */
export async function exchangeCode(code: string): Promise<FeishuIdentity> {
  const tok = await getLarkClient().authen.accessToken.create({
    data: { grant_type: 'authorization_code', code },
  });
  const uat = tok.data?.access_token;
  if (uat === undefined || uat === '') {
    throw new Error('飞书换取 user_access_token 失败');
  }
  const info = await getLarkClient().authen.userInfo.get({}, Lark.withUserAccessToken(uat));
  const d = info.data;
  const openId = d?.open_id;
  const name = d?.name;
  if (openId === undefined || openId === '' || name === undefined || name === '') {
    throw new Error('飞书 userInfo 缺 open_id / name');
  }
  const email =
    typeof (d as Record<string, unknown>)['enterprise_email'] === 'string'
      ? String((d as Record<string, unknown>)['enterprise_email'])
      : null;
  const departments = await fetchUserDepartments(uat);

  return {
    openId,
    name,
    email,
    departments,
    unionId: d?.union_id ?? null,
    avatarUrl: d?.avatar_url ?? null,
  };
}

// ── 部门 ID → 名称解析 ──

/**
 * 批量把 department_id[] 解析为部门名数组。
 * 直接调飞书 REST API：GET /open-apis/contact/v3/departments/batch?department_ids=...
 * SDK 暂无此端点的封装，走原生 fetch + tenant_access_token。
 */
async function resolveDepartmentNames(
  departmentIds: string[],
  tenantAccessToken: string,
): Promise<string[]> {
  if (departmentIds.length === 0) return [];

  try {
    const params = new URLSearchParams();
    for (const id of departmentIds) params.append('department_ids', id);

    const url = `https://open.feishu.cn/open-apis/contact/v3/departments/batch?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tenantAccessToken}` },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      console.error(
        `[feishu] dept batchGet HTTP ${String(res.status)}: ${errorBody.slice(0, 300)}`,
      );
      return []; // 降级：解析失败不存原始 ID
    }

    const body = (await res.json()) as {
      code: number;
      data?: { items?: { department_id: string; name: string }[] };
    };
    if (body.code !== 0) {
      console.error(`[feishu] dept batchGet API code=${String(body.code)}`);
      return []; // 降级：解析失败不存原始 ID
    }

    const items = body.data?.items ?? [];
    const names = items.map((d) => d.name || d.department_id);
    console.log(
      `[feishu] dept batchGet: ${String(departmentIds.length)} ids → [${names.join(', ')}]`,
    );
    return names;
  } catch (error) {
    console.error(
      '[feishu] dept batchGet 异常：',
      error instanceof Error ? error.message : String(error),
    );
    // 降级：解析失败不存原始 ID，下次请求重查
    return [];
  }
}

// 缓存在飞书后台没配 contact scope 时避免反复换 token（一次进程生命周期）
let cachedTenantToken: string | undefined;

/** 获取 app 级别的 tenant_access_token（缓存，过期自动换）。 */
async function getTenantAccessToken(): Promise<string> {
  if (cachedTenantToken) return cachedTenantToken;

  const res = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.feishu.appId, app_secret: config.feishu.appSecret }),
    },
  );
  if (!res.ok) throw new Error(`飞书 tenant_access_token 获取失败: HTTP ${String(res.status)}`);

  const body = (await res.json()) as {
    code: number;
    tenant_access_token?: string;
    msg?: string;
  };
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`飞书 tenant_access_token 获取失败: ${body.msg ?? '未知错误'}`);
  }
  cachedTenantToken = body.tenant_access_token;
  console.log('[feishu] tenant_access_token 已获取');
  return cachedTenantToken;
}

// ── 用户信息查询（两条路径：app token 兜底 / user token OAuth 登录时）──

/**
 * 解析飞书 contact.user.get 返回的 user 对象，提取 email + 部门名。
 */
async function parseContactUser(
  rawUser: Record<string, unknown>,
): Promise<{ email: string | null; departments: string[] }> {
  // 企业邮箱字段名是 enterprise_email
  const email =
    typeof rawUser['enterprise_email'] === 'string'
      ? rawUser['enterprise_email']
      : typeof rawUser['email'] === 'string'
        ? rawUser['email']
        : null;

  // 部门信息：department_ids → 批量查名称
  const deptIds = (
    Array.isArray(rawUser['department_ids']) ? rawUser['department_ids'] : []
  ) as string[];

  let departments: string[];
  if (deptIds.length > 0) {
    const tenantToken = await getTenantAccessToken();
    departments = await resolveDepartmentNames(deptIds, tenantToken);
  } else {
    const paths = rawUser['department_paths'] as { name: string }[] | undefined;
    departments = paths ? paths.map((p) => p.name) : [];
  }

  return { email, departments };
}

/**
 * 通过飞书通讯录 API（app token）按 open_id 查用户邮箱和部门。
 * 用于 OAuth 登录后 ad_operator_profile 表中尚无记录时的兜底补全。
 */
export async function fetchUserProfileByOpenId(
  openId: string,
): Promise<{ email: string | null; departments: string[] } | null> {
  try {
    const contact = await getLarkClient().contact.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
    });

    const rawData = contact.data as Record<string, unknown> | undefined;
    const rawUser = (rawData?.['user'] ?? rawData) as Record<string, unknown> | undefined;

    if (!rawUser) {
      console.warn(`[feishu] app-token contact.user.get 未返回 user (openId=${openId})`);
      return null;
    }

    const deptIds = (rawUser['department_ids'] as string[] | undefined) ?? [];
    console.log(
      `[feishu] app-token user openId=${openId} enterprise_email=${
        typeof rawUser['enterprise_email'] === 'string' ? rawUser['enterprise_email'] : '(null)'
      } department_ids=[${deptIds.join(',')}]`,
    );

    const result = await parseContactUser(rawUser);
    console.log(
      `[feishu] app-token user result openId=${openId} email=${result.email ?? '(null)'} departments=[${result.departments.join(', ')}]`,
    );
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[feishu] app-token 查用户失败 (openId=${openId}): ${detail}`);
    return null;
  }
}

/**
 * 通过飞书通讯录 API（user token）获取当前用户的部门名数组。
 * OAuth 登录时调用，失败降级为空数组。
 */
export async function fetchUserDepartments(userAccessToken: string): Promise<string[]> {
  try {
    const client = getLarkClient();
    const info = await client.authen.userInfo.get({}, Lark.withUserAccessToken(userAccessToken));
    const openId = info.data?.open_id;
    if (!openId) return [];

    const contact = await client.contact.user.get(
      {
        path: { user_id: openId },
        params: { user_id_type: 'open_id', department_id_type: 'open_department_id' },
      },
      Lark.withUserAccessToken(userAccessToken),
    );

    const rawData = contact.data as Record<string, unknown> | undefined;
    const rawUser = (rawData?.['user'] ?? rawData) as Record<string, unknown> | undefined;

    if (!rawUser) {
      console.warn(`[feishu] user-token contact.user.get 未返回 user (openId=${openId})`);
      return [];
    }

    const deptIds = (rawUser['department_ids'] as string[] | undefined) ?? [];
    console.log(
      `[feishu] user-token user openId=${openId} enterprise_email=${
        typeof rawUser['enterprise_email'] === 'string' ? rawUser['enterprise_email'] : '(null)'
      } department_ids=[${deptIds.join(',')}]`,
    );

    const { departments } = await parseContactUser(rawUser);
    console.log(
      `[feishu] user-token departments result openId=${openId}: [${departments.join(', ')}]`,
    );
    return departments;
  } catch (error) {
    console.error(
      '[feishu] user-token 查部门失败：',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

// ── 确认卡片 ──

export interface ConfirmCardInput {
  nonce: string;
  purpose: 'login' | 'sensitive';
  detail?: string | null;
  name?: string | null;
}

/**
 * 推「确认登录 / 敏感操作」交互卡片（bot 身份，receive_id_type=open_id）。
 * 卡片按钮 value 里塞 { action, nonce }，回调按 nonce 命中挑战并校验 open_id 归属。
 * 样式照搬原型：login=蓝、sensitive=橙。
 */
export async function sendConfirmCard(
  openId: string,
  input: ConfirmCardInput,
): Promise<string | undefined> {
  const isSensitive = input.purpose === 'sensitive';
  const title = isSensitive ? '⚠️ 敏感操作确认' : '🔐 登录确认';
  const body = isSensitive
    ? `有一个操作需要你确认：\n\n**${input.detail ?? '敏感操作'}**\n\n校验码 \`${input.nonce}\``
    : `有一个网页端正在请求以 **${input.name ?? '你'}** 的身份登录 **Sitin 仪表板**。\n\n校验码 \`${input.nonce}\``;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: isSensitive ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: isSensitive ? '✅ 确认执行' : '✅ 确认登录' },
            type: 'primary',
            value: { action: 'confirm', nonce: input.nonce },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✖️ 拒绝' },
            type: 'danger',
            value: { action: 'reject', nonce: input.nonce },
          },
        ],
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '3 分钟内有效，请确认是本人操作。' }],
      },
    ],
  };

  const r = await getLarkClient().im.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: openId, msg_type: 'interactive', content: JSON.stringify(card) },
  });
  return r.data?.message_id;
}
