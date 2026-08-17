/**
 * 广告组（AdGroup / AdSet）业务逻辑。
 * 创建后在本地 ad_group 表回写，后续查询走本地库。
 */

import { query, queryOne } from '@agentic-ug/db';
import { FacebookClient } from '@agentic-ug/fetcher';
import type { AdSet, CreateAdSetInput } from '@agentic-ug/fetcher';

import { getAdAccountConfig } from './token-service';

// ── 本地库行类型 ──

interface AdSetRow {
  id: number;
  campaign_id: number;
  channel_adset_id: string | null;
  name: string;
  status: string;
  optimization_goal: string | null;
  billing_event: string | null;
  targeting: unknown;
  channel_extra: unknown;
  created_at: string;
}

function rowToAdSet(row: AdSetRow): AdSet & { local_id: number } {
  return {
    id: row.channel_adset_id ?? String(row.id),
    local_id: row.id,
    name: row.name,
    status: row.status as 'ACTIVE' | 'PAUSED',
    optimization_goal: row.optimization_goal ?? '',
    billing_event: row.billing_event ?? '',
    targeting: row.targeting as Record<string, unknown>,
    channel_extra: row.channel_extra as Record<string, unknown>,
  };
}

// ── 查询 ──

export async function listAdSets(
  campaignId: string,
): Promise<(AdSet & { local_id: number })[]> {
  const rows = await query<AdSetRow & { campaign_product: string | null; campaign_operator: string | null; campaign_created_at: string | null }>(
    `SELECT s.id, s.campaign_id, s.channel_adset_id, s.name, s.status,
            s.optimization_goal, s.billing_event, s.targeting, s.channel_extra,
            to_char(s.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
            c.app_product AS campaign_product,
            s.creator AS campaign_operator,
            to_char(c.created_at, 'YYYY-MM-DD') AS campaign_created_at
       FROM ad_set s
       LEFT JOIN ad_campaign c ON c.id = s.campaign_id
      WHERE s.campaign_id = $1
      ORDER BY s.created_at DESC`,
    [campaignId],
  );

  return rows.map((r) => {
    const adset = rowToAdSet(r);
    return Object.assign(adset, {
      campaign_product: r.campaign_product,
      campaign_operator: r.campaign_operator,
      campaign_created_at: r.campaign_created_at,
    });
  });
}

// ── 创建 ──

export async function createAdSet(
  input: Omit<CreateAdSetInput, 'campaign_id'> & { local_campaign_id: string; accountId?: string; creator?: string },
): Promise<AdSet> {
  if (!input.accountId) throw new Error('创建 AdSet 需要 accountId');
  const config = await getAdAccountConfig(input.accountId);
  if (!config) throw new Error(`未找到广告账户配置: ${input.accountId}`);

  const client = new FacebookClient(config.token);
  const actNum = input.accountId.replace(/^act_/, '');

  // 从本地 campaign 表查 FB campaign_id
  const campaign = await queryOne<{ channel_campaign_id: string | null }>(
    `SELECT channel_campaign_id FROM ad_campaign WHERE id = $1`,
    [input.local_campaign_id],
  );
  if (!campaign?.channel_campaign_id) {
    throw new Error('无效的 Campaign ID');
  }

  const body: Record<string, unknown> = {
    name: input.name,
    campaign_id: campaign.channel_campaign_id,
    status: input.status,
    optimization_goal: input.optimization_goal,
  };
  if (input.billing_event) body['billing_event'] = input.billing_event;
  if (input.daily_budget !== undefined) body['daily_budget'] = input.daily_budget;
  if (input.bid_strategy) body['bid_strategy'] = input.bid_strategy;
  if (input.targeting && Object.keys(input.targeting).length > 0) body['targeting'] = input.targeting;
  if (input.promoted_object) body['promoted_object'] = input.promoted_object;
  if (input.attribution_spec && input.attribution_spec.length > 0) body['attribution_spec'] = input.attribution_spec;
  if (input.destination_type) body['destination_type'] = input.destination_type;
  if (input.is_skadnetwork_attribution) body['is_skadnetwork_attribution'] = true;
  if (input.is_dynamic_creative) body['is_dynamic_creative'] = true;

  const data = await client.post<{ id: string }>(`act_${actNum}/adsets`, body);
  const fbAdGroup: AdSet = {
    id: data.id,
    name: input.name,
    status: input.status,
    optimization_goal: input.optimization_goal,
    billing_event: input.billing_event ?? '',
    targeting: input.targeting ?? {},
    channel_extra: data,
  };

  // 回写本地库
  await query(
    `INSERT INTO ad_set (campaign_id, channel_adset_id, name, status,
                            optimization_goal, billing_event, targeting, creator, channel_extra)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.local_campaign_id,
      fbAdGroup.id,
      input.name,
      input.status,
      input.optimization_goal,
      input.billing_event ?? '',
      JSON.stringify(input.targeting ?? {}),
      input.creator ?? null,
      JSON.stringify({ ...data, ...body }),
    ],
  );

  return fbAdGroup;
}

// ── 更新 ──

export async function updateAdSet(
  accountId: string,
  adsetId: string,
  input: { daily_budget?: number; status?: 'ACTIVE' | 'PAUSED'; name?: string },
): Promise<{ ok: boolean }> {
  if (!accountId) throw new Error('更新 AdSet 需要 accountId');
  const config = await getAdAccountConfig(accountId);
  if (!config) throw new Error(`未找到广告账户配置: ${accountId}`);

  const client = new FacebookClient(config.token);
  const body: Record<string, unknown> = {};
  if (input.daily_budget !== undefined) body['daily_budget'] = input.daily_budget;
  if (input.status !== undefined) body['status'] = input.status;
  if (input.name !== undefined) body['name'] = input.name;
  await client.post<{ success?: boolean }>(adsetId, body);

  return { ok: true };
}
