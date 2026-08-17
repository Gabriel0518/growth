/**
 * sitin.ai 客户门户（/demo）的 FB Graph API 薄客户端 —— 只读，只服务于合创门户取数。
 *
 * 为什么不复用 packages/fetcher 的 FbAdapter：那套是建号/投放侧的写接口封装，没有 insights，
 * 而门户只需要「读报表 + 读授权名单」这两类 GET，加进 adapter 反而把只读依赖压进投放链路。
 *
 * 凭据全部来自 ad_fb_token（经 token-service），**本文件不含任何 token/appsecret 字面量**。
 */

const GRAPH = 'https://graph.facebook.com/v25.0';

/** 单次翻页上限：insights 一次几百行是常态，给足；防失控靠 MAX_PAGES。 */
const MAX_PAGES = 40;

interface GraphPage<T> {
  data?: T[];
  paging?: { next?: string };
  error?: { message?: string; code?: number };
}

/**
 * 带自动翻页的 GET。返回全部 data 行。
 *
 * ⚠️ FB 对不同 edge 的 limit 容忍度不同：insights 给 500 也照收，但
 * `branded_content_ad_permissions` 给 100 就会回 code 1「Please reduce the amount of data
 * you're asking for」——那个 edge 必须用 limit≤25（调用方自己传）。这不是速率限制，重试无用。
 */
async function graphGetAll<T>(
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);

  const out: T[] = [];
  let next: string | undefined = url.toString();
  for (let page = 0; page < MAX_PAGES && next !== undefined; page++) {
    const resp = await fetch(next);
    const body = (await resp.json()) as GraphPage<T>;
    if (body.error) {
      throw new Error(`FB API ${path} 失败：${body.error.message ?? '未知错误'}`);
    }
    out.push(...(body.data ?? []));
    next = body.paging?.next;
  }
  return out;
}

// ── Insights ──

/** insights 的 actions/action_values 明细项。 */
export interface FbActionItem {
  action_type: string;
  value: string;
}

export interface FbInsightRow {
  campaign_name?: string;
  campaign_id?: string;
  adset_name?: string;
  adset_id?: string;
  ad_name?: string;
  ad_id?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: FbActionItem[];
  action_values?: FbActionItem[];
  date_start?: string;
  date_stop?: string;
}

const INSIGHT_FIELDS =
  'campaign_name,campaign_id,adset_name,adset_id,ad_name,ad_id,spend,impressions,clicks,actions';

/**
 * 拉广告账户的 insights。
 *
 * 时间口径：本账户时区为 Asia/Shanghai（UTC+8），与库里收入的北京日边界天然对齐，
 * time_range 传的 YYYY-MM-DD 即北京自然日，两边可以直接相加不做时区换算。
 * 换账户前务必复核 timezone_name——时区不一致时消耗和收入会错位数小时。
 */
export function fetchInsights(
  token: string,
  accountId: string,
  level: 'campaign' | 'adset' | 'ad',
  since: string,
  until: string,
  byDay = false,
): Promise<FbInsightRow[]> {
  const params: Record<string, string> = {
    level,
    fields: INSIGHT_FIELDS,
    time_range: JSON.stringify({ since, until }),
    limit: '500',
  };
  if (byDay) params['time_increment'] = '1';
  return graphGetAll<FbInsightRow>(token, `${accountId}/insights`, params);
}

// ── 结构与状态（实时，不读建号侧回写表：那里的 status 可能已与 FB 侧漂移）──

export interface FbCampaignRow {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
}

export function fetchCampaigns(token: string, accountId: string): Promise<FbCampaignRow[]> {
  return graphGetAll<FbCampaignRow>(token, `${accountId}/campaigns`, {
    fields: 'id,name,status,effective_status,daily_budget',
    limit: '200',
  });
}

export interface FbAdsetRow {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  campaign_id?: string;
  daily_budget?: string;
  created_time?: string;
}

export function fetchAdsets(token: string, accountId: string): Promise<FbAdsetRow[]> {
  return graphGetAll<FbAdsetRow>(token, `${accountId}/adsets`, {
    fields: 'id,name,status,effective_status,campaign_id,daily_budget,created_time',
    limit: '400',
  });
}

// ── 品牌合作（branded content）授权名单 ──

export interface FbBrandedPermission {
  creator_username?: string;
  creator_ig_id?: string;
  permission_status?: string;
}

/**
 * 某品牌 IG 账号下的创作者授权名单。limit 必须小（见 graphGetAll 的注释），25 是实测可用值。
 * 只回 Approved：Pending/Revoked 的创作者不能用于投放，展示出来只会让客户误解可用规模。
 */
export async function fetchApprovedCreators(
  token: string,
  brandIgId: string,
): Promise<FbBrandedPermission[]> {
  const rows = await graphGetAll<FbBrandedPermission>(
    token,
    `${brandIgId}/branded_content_ad_permissions`,
    { fields: 'creator_username,creator_ig_id,permission_status', limit: '25' },
  );
  return rows.filter((r) => r.permission_status === 'Approved');
}
