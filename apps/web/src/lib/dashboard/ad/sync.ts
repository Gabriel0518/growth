/**
 * 投放数据同步 —— 从 FB API 拉取现有的 Campaign/AdSet/Ad，upsert 到本地库。
 * 前端打开投放管理面板时调用一次，即可看到已有投放数据。
 *
 * 去重策略：channel_*_id 列有 UNIQUE 约束，用 INSERT ... ON CONFLICT 做 upsert，
 *          不再依赖 SELECT→INSERT/UPDATE 的两步模式，消除竞争条件。
 */

import { query } from '@agentic-ug/db';
import type { ChannelAdapter } from '@agentic-ug/fetcher';

import { matchOperator, resolveOperatorName } from '../operators';

import { logger } from './logger';

// ── 调用频率保护 ──
// FB API 对单广告账户有严格限流（#80004 账户级 / #613 用户级），
// 高频重复同步不仅没有增量数据，还会撞限流影响其他正常功能。

const SYNC_COOLDOWN_MS = 60_000; // 两次全量同步之间的最小间隔（1分钟）
let lastSyncTime = 0;

/** 检查是否在冷却期内；如果在，返回剩余秒数，否则返回 0。 */
export function syncCooldownRemaining(): number {
  if (lastSyncTime === 0) return 0;
  const elapsed = Date.now() - lastSyncTime;
  if (elapsed >= SYNC_COOLDOWN_MS) return 0;
  return Math.ceil((SYNC_COOLDOWN_MS - elapsed) / 1000);
}

/** 更新上次同步时间（同步成功后调用）。 */
export function markSyncTime(): void {
  lastSyncTime = Date.now();
}

// ── 辅助 ──

/** 从 campaign 名提取投手代号。 */
function extractOperator(name: string): string | null {
  const code = matchOperator(name);
  // test_creative 不是投手代码，不适用 creator 场景
  return code === 'test_creative' ? null : code;
}

function extractProduct(name: string): string | null {
  const parts = name.split('_');
  return parts[0] ?? null;
}

/** 从 channel_extra 取 FB 侧 id 字符串（campaign_id / adset_id）。 */
function fbIdFrom(extra: Record<string, unknown>, key: string): string | undefined {
  const v = extra[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

// ── Campaign 同步 ──

export async function syncCampaignsFromFb(
  adapter: ChannelAdapter,
  accountId: string,
): Promise<Map<string, number>> {
  // key: FB campaign_id → value: 本地 ad_campaign.id (SERIAL)
  const idMap = new Map<string, number>();
  const fbCampaigns = await adapter.listCampaigns(accountId);

  for (const c of fbCampaigns) {
    // 跳过已删除的
    if (c.status === 'DELETED') continue;

    // INSERT on conflict → UPDATE，返回本地 id
    const row = await query<{ id: number }>(
      `INSERT INTO ad_campaign (channel, channel_account_id, channel_campaign_id, name, objective, status,
                                 daily_budget, operator_code, app_product, creator, channel_extra)
       VALUES ('fb', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (channel_campaign_id) DO UPDATE
         SET channel_account_id = EXCLUDED.channel_account_id,
             channel_extra     = EXCLUDED.channel_extra,
             status            = EXCLUDED.status,
             daily_budget = EXCLUDED.daily_budget,
             name         = EXCLUDED.name,
             operator_code = EXCLUDED.operator_code,
             app_product   = EXCLUDED.app_product,
             creator    = COALESCE(ad_campaign.creator, EXCLUDED.creator),
             updated_at    = now()
       RETURNING id`,
      [
        accountId,
        c.id,
        c.name,
        c.objective,
        c.status,
        c.daily_budget ?? null,
        extractOperator(c.name),
        extractProduct(c.name),
        resolveOperatorName(extractOperator(c.name)),
        JSON.stringify(c.channel_extra),
      ],
    );
    const first = row[0];
    if (first) idMap.set(c.id, first.id);
  }

  logger.info(`[sync] campaigns: ${String(idMap.size)} 条`);
  return idMap;
}

// ── AdGroup (AdSet) 同步 ──

export async function syncAdSetsForCampaign(
  adapter: ChannelAdapter,
  fbCampaignId: string,
  localCampaignId: number,
): Promise<Map<string, number>> {
  const idMap = new Map<string, number>();
  const fbAdGroups = await adapter.listAdSets(fbCampaignId);
  for (const ag of fbAdGroups) {
    const row = await query<{ id: number }>(
      `INSERT INTO ad_set (campaign_id, channel_adset_id, name, status,
                              optimization_goal, billing_event, targeting, creator, channel_extra)
       SELECT $1, $2, $3, $4, $5, $6, $7, c.operator_code, $8
         FROM ad_campaign c WHERE c.id = $1
       ON CONFLICT (channel_adset_id) DO UPDATE
         SET channel_extra  = EXCLUDED.channel_extra,
             status         = EXCLUDED.status,
             optimization_goal = EXCLUDED.optimization_goal,
             billing_event     = EXCLUDED.billing_event,
             targeting         = EXCLUDED.targeting,
             creator        = COALESCE(ad_set.creator, EXCLUDED.creator),
             updated_at        = now()
       RETURNING id`,
      [
        localCampaignId,
        ag.id,
        ag.name,
        ag.status,
        ag.optimization_goal,
        ag.billing_event,
        JSON.stringify(ag.targeting),
        JSON.stringify(ag.channel_extra),
      ],
    );
    const first = row[0];
    if (first) idMap.set(ag.id, first.id);
  }

  logger.info(`[sync] adsets for campaign ${fbCampaignId}: ${String(idMap.size)} 条`);
  return idMap;
}

// ── Ad 同步 ──

export async function syncAdsForAdGroup(
  adapter: ChannelAdapter,
  fbAdgroupId: string,
  localAdgroupId: number,
): Promise<number> {
  let count = 0;
  const fbAds = await adapter.listAds(fbAdgroupId);

  for (const ad of fbAds) {
    await query(
      `INSERT INTO ad (adset_id, channel_ad_id, name, status, effective_status, creator, channel_extra, ad_campaign_id)
       SELECT $1, $2, $3, $4, $5, c.operator_code, $6, s.campaign_id
         FROM ad_set s JOIN ad_campaign c ON c.id = s.campaign_id
        WHERE s.id = $1
       ON CONFLICT (channel_ad_id) DO UPDATE
         SET channel_extra  = EXCLUDED.channel_extra,
             status         = EXCLUDED.status,
             effective_status = EXCLUDED.effective_status,
             creator     = COALESCE(ad.creator, EXCLUDED.creator),
             updated_at     = now()`,
      [localAdgroupId, ad.id, ad.name, ad.status, ad.effective_status, JSON.stringify(ad.channel_extra)],
    );
    count++;
  }

  logger.info(`[sync] ads for adgroup ${fbAdgroupId}: ${String(count)} 条`);
  return count;
}

// ── 账户级全量同步（Edge 批量拉：act_XXX/adsets、act_XXX/ads，各 1 次/页）──

/** 账户级拉全部 AdSet，按 channel_extra.campaign_id 关联本地 campaign。 */
export async function syncAdSetsForAccount(
  adapter: ChannelAdapter,
  accountId: string,
  campaignIdMap: Map<string, number>,
): Promise<Map<string, number>> {
  const idMap = new Map<string, number>();
  const fbAdGroups = await adapter.listAdSets(accountId); // act_XXX/adsets
  for (const ag of fbAdGroups) {
    const fbCampaignId = fbIdFrom(ag.channel_extra, 'campaign_id');
    const localCampaignId = fbCampaignId === undefined ? undefined : campaignIdMap.get(fbCampaignId);
    if (localCampaignId === undefined) {
      logger.warn(`[sync] adset ${ag.id} 的 campaign ${fbCampaignId ?? '(缺失)'} 未同步，跳过`);
      continue;
    }
    const row = await query<{ id: number }>(
      `INSERT INTO ad_set (campaign_id, channel_adset_id, name, status,
                              optimization_goal, billing_event, targeting, creator, channel_extra)
       SELECT $1, $2, $3, $4, $5, $6, $7, c.operator_code, $8
         FROM ad_campaign c WHERE c.id = $1
       ON CONFLICT (channel_adset_id) DO UPDATE
         SET channel_extra  = EXCLUDED.channel_extra,
             status         = EXCLUDED.status,
             optimization_goal = EXCLUDED.optimization_goal,
             billing_event     = EXCLUDED.billing_event,
             targeting         = EXCLUDED.targeting,
             creator        = COALESCE(ad_set.creator, EXCLUDED.creator),
             updated_at        = now()
       RETURNING id`,
      [
        localCampaignId,
        ag.id,
        ag.name,
        ag.status,
        ag.optimization_goal,
        ag.billing_event,
        JSON.stringify(ag.targeting),
        JSON.stringify(ag.channel_extra),
      ],
    );
    const first = row[0];
    if (first) idMap.set(ag.id, first.id);
  }

  logger.info(`[sync] adsets for account ${accountId}: ${String(idMap.size)} 条`);
  return idMap;
}

/** 账户级拉全部 Ad，按 channel_extra.adset_id 关联本地 adset。 */
export async function syncAdsForAccount(
  adapter: ChannelAdapter,
  accountId: string,
  adsetIdMap: Map<string, number>,
): Promise<number> {
  let count = 0;
  const fbAds = await adapter.listAds(accountId); // act_XXX/ads

  for (const ad of fbAds) {
    const fbAdsetId = fbIdFrom(ad.channel_extra, 'adset_id');
    const localAdsetId = fbAdsetId === undefined ? undefined : adsetIdMap.get(fbAdsetId);
    if (localAdsetId === undefined) {
      logger.warn(`[sync] ad ${ad.id} 的 adset ${fbAdsetId ?? '(缺失)'} 未同步，跳过`);
      continue;
    }
    await query(
      `INSERT INTO ad (adset_id, channel_ad_id, name, status, effective_status, creator, channel_extra, ad_campaign_id)
       SELECT $1, $2, $3, $4, $5, c.operator_code, $6, s.campaign_id
         FROM ad_set s JOIN ad_campaign c ON c.id = s.campaign_id
        WHERE s.id = $1
       ON CONFLICT (channel_ad_id) DO UPDATE
         SET channel_extra  = EXCLUDED.channel_extra,
             status         = EXCLUDED.status,
             effective_status = EXCLUDED.effective_status,
             creator     = COALESCE(ad.creator, EXCLUDED.creator),
             updated_at     = now()`,
      [localAdsetId, ad.id, ad.name, ad.status, ad.effective_status, JSON.stringify(ad.channel_extra)],
    );
    count++;
  }

  logger.info(`[sync] ads for account ${accountId}: ${String(count)} 条`);
  return count;
}

// ── 对外入口 ──

export interface SyncResult {
  campaigns: number;
  adsets: number;
  ads: number;
}

/**
 * 修复历史脏数据：将 ad_campaign.creator 中无效值（代码/日期/test_creative）
 * 用 matchOperator + resolveOperatorName 重新解析为真实姓名，再级联 ad_set/ad。
 */
export async function backfillCreatedBy(): Promise<void> {
  const badCampaigns = await query<{ id: number; name: string; creator: string | null }>(
    `SELECT id, name, creator FROM ad_campaign
      WHERE creator IS NULL OR creator = ''
         OR creator = 'test_creative'
         OR creator ~ '^[0-9]{6}$'
         OR creator IN ('syh','zm1','zme','wcx','zmf','mcy','lh','ymt','wty','wvv','zjc','cy1')`,
  );

  for (const c of badCampaigns) {
    const resolved = resolveOperatorName(matchOperator(c.name));
    if (resolved && resolved !== c.creator) {
      await query(`UPDATE ad_campaign SET creator = $1 WHERE id = $2`, [resolved, c.id]);
      logger.info(`[backfill] campaign #${String(c.id)} "${c.name}" creator: ${c.creator ?? 'NULL'} → ${resolved}`);
    }
  }

  // 级联修复 ad_set
  await query(
    `UPDATE ad_set SET creator = c.creator
       FROM ad_campaign c
      WHERE ad_set.campaign_id = c.id
        AND (ad_set.creator IS NULL OR ad_set.creator = ''
             OR ad_set.creator = 'test_creative'
             OR ad_set.creator ~ '^[0-9]{6}$'
             OR ad_set.creator IN ('syh','zm1','zme','wcx','zmf','mcy','lh','ymt','wty','wvv','zjc','cy1'))`,
  );

  // 级联修复 ad
  await query(
    `UPDATE ad SET creator = c.creator
       FROM ad_set s JOIN ad_campaign c ON c.id = s.campaign_id
      WHERE ad.adset_id = s.id
        AND (ad.creator IS NULL OR ad.creator = ''
             OR ad.creator = 'test_creative'
             OR ad.creator ~ '^[0-9]{6}$'
             OR ad.creator IN ('syh','zm1','zme','wcx','zmf','mcy','lh','ymt','wty','wvv','zjc','cy1'))`,
  );

  logger.info('[backfill] creator 修复完成');
}

/** 从 FB 全量同步 Campaign → AdSet → Ad 到本地库。 */
export async function syncFromFb(adapter: ChannelAdapter, accountId: string): Promise<SyncResult> {
  // 修复历史脏数据（每次 sync 时幂等执行）
  backfillCreatedBy().catch((error_: unknown) => {
    logger.warn(`[sync] backfill 失败: ${error_ instanceof Error ? error_.message : String(error_)}`);
  });

  const campaignIdMap = await syncCampaignsFromFb(adapter, accountId);
  // 账户级 Edge 批量拉取 adsets / ads，避免逐 campaign / 逐 adset 调用触发限流。
  const adsetIdMap = await syncAdSetsForAccount(adapter, accountId, campaignIdMap);
  const adCount = await syncAdsForAccount(adapter, accountId, adsetIdMap);

  return {
    campaigns: campaignIdMap.size,
    adsets: adsetIdMap.size,
    ads: adCount,
  };
}
