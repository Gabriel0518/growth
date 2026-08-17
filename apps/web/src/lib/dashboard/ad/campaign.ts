/**
 * 广告系列（Campaign）业务逻辑。
 * 创建后在本地 ad_campaign 表回写，后续查询优先走本地库。
 * 通过 accountId → token-service 获取 token 凭据，不再依赖环境变量。
 */

import { query } from '@agentic-ug/db';
import { createFbAdapter } from '@agentic-ug/fetcher';
import type { Campaign, CreateCampaignInput, UpdateCampaignInput } from '@agentic-ug/fetcher';

import { getAdAccountConfig } from './token-service';

/** 根据 accountId 解析 FB Adapter，失败时抛明确错误。 */
async function resolveAdapter(accountId: string) {
  const config = await getAdAccountConfig(accountId);
  if (!config) throw new Error(`未找到广告账户配置: ${accountId}，请先在 Token 管理页面添加`);
  return createFbAdapter(config.token);
}


// ── 本地库行类型 ──

interface CampaignRow {
  id: number;
  channel: string;
  channel_campaign_id: string | null;
  name: string;
  objective: string | null;
  status: string;
  daily_budget: number | null;
  operator_code: string | null;
  app_product: string | null;
  creator: string | null;
  created_at: string;
  updated_at: string;
  channel_extra: unknown;
}

function rowToCampaign(row: CampaignRow): Campaign & { local_id: number; app_product?: string | null; creator?: string | null; created_at?: string | null } {
  const result: Campaign & { local_id: number; app_product?: string | null; creator?: string | null; created_at?: string | null } = {
    id: row.channel_campaign_id ?? String(row.id),
    local_id: row.id,
    name: row.name,
    status: row.status as Campaign['status'],
    objective: row.objective ?? '',
    app_product: row.app_product,
    creator: row.creator,
    created_at: row.created_at,
    channel_extra: (row.channel_extra as Record<string, unknown>),
  };
  if (row.daily_budget !== null) {
    result.daily_budget = row.daily_budget;
  }
  return result;
}

// ── 查询 ──

export async function listCampaigns(
  accountId: string,
): Promise<(Campaign & { local_id: number })[]> {
  const rows = await query<CampaignRow>(
    `SELECT id, channel, channel_campaign_id, name, objective, status, daily_budget,
            operator_code, app_product, creator,
            to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
            to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at,
            channel_extra
       FROM ad_campaign
      WHERE channel_account_id = $1 OR channel_account_id IS NULL
      ORDER BY created_at DESC`,
      [accountId],
  );

  return rows.map((r) => rowToCampaign(r));
}

export async function getCampaign(
  accountId: string,
  campaignId: string,
): Promise<Campaign> {
  const adapter = await resolveAdapter(accountId);
  return adapter.getCampaign(campaignId);
}

// ── 创建 ──

export async function createCampaign(
  accountId: string,
  input: CreateCampaignInput & { creator?: string; product?: string },
): Promise<Campaign> {
  const adapter = await resolveAdapter(accountId);
  const fbCampaign = await adapter.createCampaign(accountId, input);

  // 回写本地库
  await query(
    `INSERT INTO ad_campaign (channel, channel_account_id, channel_campaign_id, name, objective, status,
                               daily_budget, operator_code, app_product, creator, channel_extra)
     VALUES ('fb', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      accountId,
      fbCampaign.id,
      input.name,
      input.objective,
      input.status,
      input.daily_budget !== undefined && input.daily_budget > 0 ? input.daily_budget : null,
      null, // operator_code — 暂不从名称提取
      input.product ?? null,
      input.creator ?? null,
      JSON.stringify(fbCampaign.channel_extra),
    ],
  );

  return fbCampaign;
}

// ── 更新 ──

export async function updateCampaign(
  accountId: string,
  campaignId: string,
  input: UpdateCampaignInput,
): Promise<Campaign> {
  const adapter = await resolveAdapter(accountId);
  const updated = await adapter.updateCampaign(campaignId, input);

  // 同步本地库
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  if (input.status !== undefined) {
    fields.push(`status = $${String(idx++)}`);
    values.push(input.status);
  }
  if (input.daily_budget !== undefined) {
    fields.push(`daily_budget = $${String(idx++)}`);
    values.push(input.daily_budget);
  }
  if (input.name !== undefined) {
    fields.push(`name = $${String(idx++)}`);
    values.push(input.name);
  }
  if (fields.length > 0) {
    fields.push(`updated_at = now()`);
    values.push(campaignId);
    await query(
      `UPDATE ad_campaign SET ${fields.join(', ')} WHERE channel_campaign_id = $${String(idx)}`,
      values,
    );
  }

  return updated;
}
