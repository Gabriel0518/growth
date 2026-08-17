/**
 * Facebook ChannelAdapter 实现。
 * 把 FB Graph API 的各端点封装为 ChannelAdapter 接口方法。
 */

import type {
  Ad,
  AdSet,
  AvailablePage,
  BrandedContentPermission,
  Campaign,
  Channel,
  ChannelAdapter,
  ChannelMaterial,
  CreateAdSetInput,
  CreateAdInput,
  CreateCampaignInput,
  CreateCreativeInput,
  Creative,
  MaterialStatus,
  UpdateCampaignInput,
} from '../types.js';
import type { AdAccount } from '../types.js';

import { FacebookClient } from './client.js';

/** 默认广告账户 ID，从环境变量读取。 */
function defaultAccountId(): string {
  const id = process.env['FB_AD_ACCOUNT_ID'] ?? process.env['FB_ACT_ID'];
  if (!id) throw new Error('FB_AD_ACCOUNT_ID 未设置');
  // FB API 接受 act_ 前缀或纯数字
  return id.startsWith('act_') ? id : `act_${id}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FacebookAdapter implements ChannelAdapter {
  readonly channel: Channel = 'fb';
  private client: FacebookClient;

  constructor(token: string) {
    this.client = new FacebookClient(token);
  }

  // ── Account ──

  async getAccount(accountId: string): Promise<AdAccount> {
    const data = await this.client.get<{
      id: string;
      name: string;
      currency: string;
      account_status: number;
    }>(accountId, { fields: 'id,name,currency,account_status' });
    return {
      id: data.id,
      name: data.name,
      currency: data.currency,
      account_status: data.account_status,
    };
  }

  // ── Campaign ──

  /** 遍历 FB Edge 分页，拉取全部子对象原始行（limit=10 小批量 + after cursor，避免单次响应过大）。 */
  private async fetchAllPages<T>(path: string, fields: string): Promise<T[]> {
    const all: T[] = [];
    let after: string | undefined;
    for (;;) {
      const resp = await this.client.get<{ data?: T[]; paging?: { cursors?: { after?: string } } }>(
        path,
        { fields, limit: '10', ...(after === undefined ? {} : { after }) },
      );
      const list = resp.data ?? [];
      all.push(...list);
      const next = resp.paging?.cursors?.after;
      if (!next || list.length === 0) break;
      after = next;
      // 限流保护：翻页间隔，避免连续打满账户读计分额度（读=1分/次，账户级滚动窗口）。
      await sleep(300);
    }
    return all;
  }

  async listCampaigns(accountId: string): Promise<Campaign[]> {
    const rows = await this.fetchAllPages<{
      id: string;
      name: string;
      status: string;
      objective: string;
      daily_budget?: string;
      special_ad_categories?: string[];
    }>(
      `${accountId}/campaigns`,
      'id,account_id,name,objective,status,configured_status,effective_status,daily_budget,lifetime_budget,spend_cap,buying_type,bid_strategy,pacing_type,special_ad_categories,created_time,updated_time,start_time,stop_time,budget_remaining,promoted_object,smart_promotion_type,source_campaign_id,issues_info,is_skadnetwork_attribution,topline_id',
    );
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return rows.map((c) => {
      const item: Campaign = {
        id: c.id,
        name: c.name,
        status: normalizeStatus(c.status),
        objective: c.objective,
        channel_extra: c,
      };
      if (c.daily_budget) item.daily_budget = Number.parseInt(c.daily_budget, 10);
      return item;
    });
  }

  async getCampaign(campaignId: string): Promise<Campaign> {
    const c = await this.client.get<{
      id: string;
      name: string;
      status: string;
      objective: string;
      daily_budget?: string;
    }>(campaignId, { fields: 'id,account_id,name,objective,status,configured_status,effective_status,' +
    'daily_budget,lifetime_budget,spend_cap,buying_type,bid_strategy,pacing_type,' +
    'special_ad_categories,created_time,updated_time,start_time,stop_time,budget_remaining,' +
    'promoted_object,smart_promotion_type,source_campaign_id,issues_info,' +
    'is_skadnetwork_attribution,topline_id' });
    const result: Campaign = {
      id: c.id,
      name: c.name,
      status: normalizeStatus(c.status),
      objective: c.objective,
      channel_extra: c,
    };
    if (c.daily_budget) result.daily_budget = Number.parseInt(c.daily_budget, 10);
    return result;
  }

  async createCampaign(accountId: string, input: CreateCampaignInput): Promise<Campaign> {
    const body: Record<string, unknown> = {
      name: input.name,
      objective: input.objective,
      status: input.status,
      special_ad_categories: input.special_ad_categories ?? [],
    };
    const isCbo = input.daily_budget !== undefined && input.daily_budget > 0;
    if (isCbo) {
      // CBO：预算在广告系列上
      body['daily_budget'] = input.daily_budget;
    } else {
      // ABO：预算在广告组上（v25.0 非 CBO 场景需显式声明）
      body['is_adset_budget_sharing_enabled'] = false;
    }
    if (input.buying_type) body['buying_type'] = input.buying_type;
    // bid_strategy 依赖系列预算：仅 CBO 可传；ABO 时在广告组侧设置
    if (isCbo && input.bid_strategy) body['bid_strategy'] = input.bid_strategy;
    const data = await this.client.post<{ id: string }>(`${accountId}/campaigns`, body);
    return this.getCampaign(data.id);
  }

  async updateCampaign(campaignId: string, input: UpdateCampaignInput): Promise<Campaign> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body['name'] = input.name;
    if (input.status !== undefined) body['status'] = input.status;
    if (input.daily_budget !== undefined) body['daily_budget'] = input.daily_budget;
    await this.client.post(campaignId, body);
    return this.getCampaign(campaignId);
  }

  // ── AdSet ──

  async listAdSets(campaignId: string): Promise<AdSet[]> {
    const rows = await this.fetchAllPages<{
      id: string;
      name: string;
      status: string;
      optimization_goal: string;
      billing_event: string;
      targeting: Record<string, unknown>;
    }>(
      `${campaignId}/adsets`,
      'id,account_id,name,status,optimization_goal,billing_event,targeting,bid_strategy,bid_amount,bid_constraints,daily_budget,lifetime_budget,start_time,end_time,pacing_type,attribution_spec,promoted_object,campaign_id,configured_status,effective_status,budget_remaining,campaign_attribution,destination_type,is_dynamic_creative,learning_stage_info,source_adset_id,targeting_optimization_types,dsa_beneficiary,dsa_payor,frequency_control_specs,created_time,updated_time',
    );

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      status: normalizeStatus(a.status) as 'ACTIVE' | 'PAUSED',
      optimization_goal: a.optimization_goal,
      billing_event: a.billing_event,
      targeting: a.targeting,
      channel_extra: a,
    }));
  }

  async createAdSet(input: CreateAdSetInput): Promise<AdSet> {
    const accountId = defaultAccountId();
    const body: Record<string, unknown> = {
      name: input.name,
      campaign_id: input.campaign_id,
      status: input.status,
      optimization_goal: input.optimization_goal,
    };
    if (input.billing_event) body['billing_event'] = input.billing_event;
    if (input.daily_budget !== undefined) body['daily_budget'] = input.daily_budget;
    if (input.bid_strategy) body['bid_strategy'] = input.bid_strategy;
    if (input.targeting) body['targeting'] = input.targeting;
    if (input.promoted_object) body['promoted_object'] = input.promoted_object;
    if (input.attribution_spec) body['attribution_spec'] = input.attribution_spec;
    if (input.destination_type) body['destination_type'] = input.destination_type;
    if (input.is_skadnetwork_attribution) body['is_skadnetwork_attribution'] = true;
    if (input.is_dynamic_creative) body['is_dynamic_creative'] = true;
    const data = await this.client.post<{ id: string }>(`${accountId}/adsets`, body);
    return {
      id: data.id,
      name: input.name,
      status: input.status,
      optimization_goal: input.optimization_goal,
      billing_event: input.billing_event ?? '',
      targeting: input.targeting ?? {},
      channel_extra: data,
    };
  }

  // ── Ad ──

  async listAds(adgroup_id: string): Promise<Ad[]> {
    const rows = await this.fetchAllPages<{
      id: string;
      name: string;
      status: string;
      effective_status: string;
    }>(
      `${adgroup_id}/ads`,
      'id,account_id,name,status,configured_status,effective_status,adset_id,campaign_id,creative{id,name,thumbnail_url,object_story_spec,asset_feed_spec,body,title,image_hash,call_to_action_type,link_url,instagram_actor_id},ad_review_feedback,ad_schedule_start_time,ad_schedule_end_time,bid_amount,bid_info,bid_type,conversion_domain,conversion_specs,creative_asset_groups_spec,display_sequence,engagement_audience,failed_delivery_checks,issues_info,preview_shareable_link,recommendations,source_ad_id,targeting,tracking_specs,created_time,updated_time',
    );

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      status: normalizeStatus(a.status) as 'ACTIVE' | 'PAUSED',
      effective_status: a.effective_status,
      channel_extra: a,
    }));
  }

  async createAd(input: CreateAdInput): Promise<Ad> {
    const accountId = defaultAccountId();
    const body: Record<string, unknown> = {
      name: input.name,
      adset_id: input.adgroup_id,
      creative: { creative_id: input.creative_id },
      status: input.status,
    };
    const data = await this.client.post<{ id: string }>(`${accountId}/ads`, body);
    // 创建后立即读回以获取 effective_status
    const ad = await this.client.get<{
      id: string;
      name: string;
      status: string;
      effective_status: string;
    }>(data.id, { fields: 'id,name,status,effective_status' });
    return {
      id: ad.id,
      name: ad.name,
      status: normalizeStatus(ad.status) as 'ACTIVE' | 'PAUSED',
      effective_status: ad.effective_status,
      channel_extra: ad,
    };
  }

  // ── Creative ──

  async createCreative(input: CreateCreativeInput): Promise<Creative> {
    const accountId = defaultAccountId();
    const objectStorySpec: Record<string, unknown> = {
      page_id: input.page_id,
    };

    if (input.video_id) {
      objectStorySpec['video_data'] = {
        video_id: input.video_id,
        call_to_action: { type: input.cta_type },
      };
      if (input.titles.length > 0) {
        (objectStorySpec['video_data'] as Record<string, unknown>)['title'] = input.titles[0];
      }
    } else if (input.image_hash) {
      objectStorySpec['link_data'] = {
        image_hash: input.image_hash,
        call_to_action: { type: input.cta_type },
      };
      if (input.link_url) {
        (objectStorySpec['link_data'] as Record<string, unknown>)['link'] = input.link_url;
      }
      if (input.titles.length > 0) {
        (objectStorySpec['link_data'] as Record<string, unknown>)['name'] = input.titles[0];
      }
    }

    if (input.ig_account_id) {
      objectStorySpec['instagram_actor_id'] = input.ig_account_id;
    }

    const body: Record<string, unknown> = {
      name: input.name,
      object_story_spec: objectStorySpec,
    };

    // 多文案走 asset_feed_spec（DoF 模式）
    if (input.titles.length > 1 || input.bodies.length > 1) {
      const assetFeedSpec: Record<string, unknown> = {};
      if (input.titles.length > 1) assetFeedSpec['titles'] = input.titles.map((t) => ({ text: t }));
      if (input.bodies.length > 1) assetFeedSpec['bodies'] = input.bodies.map((b) => ({ text: b }));
      body['asset_feed_spec'] = assetFeedSpec;
      // 有 asset_feed_spec 时不传 object_story_spec 的 title/body
      delete (objectStorySpec['video_data'] as Record<string, unknown> | undefined)?.['title'];
    }

    const data = await this.client.post<{ id: string }>(`${accountId}/adcreatives`, body);
    return { id: data.id, channel_extra: data };
  }

  // ── Pages ──

  async listAvailablePages(): Promise<AvailablePage[]> {
    const data = await this.client.get<{
      data: {
        id: string;
        name: string;
        username?: string;
        picture?: { data: { url: string } };
        category?: string;
        tasks: string[];
        instagram_business_account?: { id: string; username: string };
      }[];
    }>('me/accounts', {
      fields: 'id,name,username,picture,category,tasks,instagram_business_account{id,username}',
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return (data.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      username: p.username ?? null,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      picture: p.picture?.data?.url ?? null,
      category: p.category ?? null,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      source: p.tasks?.length >= 3 ? 'owned' : 'partner' as const,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      tasks: p.tasks ?? [],
      igBusinessAccount: p.instagram_business_account?.id
        ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username }
        : null,
    }));
  }

  async listBrandedContentPermissions(brandIgId: string): Promise<BrandedContentPermission[]> {
    const data = await this.client.get<{
      data: {
        id: string;
        brand_ig_id: string;
        brand_username: string;
        creator_ig_id: string;
        creator_username: string;
        permission_status: string;
      }[];
    }>(`${brandIgId}/branded_content_ad_permissions`, { limit: '200' });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return (data.data ?? [])
      .filter((p) => p.permission_status === 'Approved')
      .map((p) => ({
        id: p.id,
        brandIgId: p.brand_ig_id,
        brandUsername: p.brand_username,
        creatorIgId: p.creator_ig_id,
        creatorUsername: p.creator_username,
        permissionStatus: p.permission_status,
      }));
  }

  // ── Material 上传 ──

  async uploadVideoByUrl(
    accountId: string,
    fileUrl: string,
    name: string,
  ): Promise<ChannelMaterial> {
    const data = await this.client.postForm<{ id: string }>(`${accountId}/advideos`, {
      file_url: fileUrl,
      title: name,
    });
    return { channel_material_id: data.id, channel_thumbnail_url: null };
  }

  async uploadImageByUrl(accountId: string, imageUrl: string): Promise<ChannelMaterial> {
    const data = await this.client.postForm<{
      images: Record<string, { hash: string; url: string }>;
    }>(`${accountId}/adimages`, { url: imageUrl });
    const first = Object.values(data.images)[0];
    if (!first) throw new Error('FB 图片上传未返回 hash');
    return { channel_material_id: first.hash, channel_thumbnail_url: first.url };
  }

  async getVideoStatus(videoId: string): Promise<MaterialStatus> {
    const data = await this.client.get<{ status?: { video_status?: string } }>(videoId, {
      fields: 'status',
    });
    const vs = data.status?.video_status;
    if (vs === 'ready') return { status: 'ready', channel_extra: data };
    if (vs === 'error' || vs === undefined) return { status: 'failed', channel_extra: data };
    return { status: 'uploading', channel_extra: data };
  }
}

/** 把 FB 状态统一为 4 态。 */
function normalizeStatus(s: string): 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED' {
  const upper = s.toUpperCase();
  if (upper === 'ACTIVE') return 'ACTIVE';
  if (upper === 'PAUSED') return 'PAUSED';
  if (upper === 'DELETED') return 'DELETED';
  if (upper === 'ARCHIVED') return 'ARCHIVED';
  // FB 返回 CAMPAIGN_PAUSED / ADSET_PAUSED / PENDING_REVIEW 等，统一归 PAUSED
  return 'PAUSED';
}
