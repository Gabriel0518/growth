/**
 * 广告渠道通用接口定义。各平台（Facebook / TikTok / Google）各自实现 ChannelAdapter。
 * 通用业务层只依赖此文件，不直接 import 平台实现。
 */
export type Channel = 'fb' | 'tt' | 'gg';

// ── 广告账户 ──

export interface AdAccount {
  id: string;
  name: string;
  currency: string;
  account_status: number;
}

// ── Campaign（广告系列）──

export interface Campaign {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';
  objective: string;
  daily_budget?: number;
  channel_extra: Record<string, unknown>;
}

export interface CreateCampaignInput {
  name: string;
  objective: string;
  status: 'ACTIVE' | 'PAUSED';
  daily_budget?: number;
  special_ad_categories?: string[];
  buying_type?: string;
  bid_strategy?: string;
}

export interface UpdateCampaignInput {
  name?: string;
  status?: 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';
  daily_budget?: number;
}

// ── AdGroup（广告组，FB 叫 AdSet）──

export interface AdSet {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  optimization_goal: string;
  billing_event: string;
  targeting: Record<string, unknown>;
  channel_extra: Record<string, unknown>;
}

export interface CreateAdSetInput {
  name: string;
  campaign_id: string;
  status: 'ACTIVE' | 'PAUSED';
  optimization_goal: string;
  billing_event?: string;
  daily_budget?: number;
  bid_strategy?: string;
  targeting?: Record<string, unknown>;
  promoted_object?: Record<string, unknown>;
  attribution_spec?: Record<string, unknown>[];
  destination_type?: string;
  is_skadnetwork_attribution?: boolean;
  is_dynamic_creative?: boolean;
}

// ── Ad（广告）──

export interface Ad {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  effective_status: string;
  channel_extra: Record<string, unknown>;
}

export interface CreateAdInput {
  name: string;
  adgroup_id: string;
  creative_id: string;
  status: 'ACTIVE' | 'PAUSED';
}

// ── Creative（广告创意）──

export interface Creative {
  id: string;
  channel_extra: Record<string, unknown>;
}

export interface CreateCreativeInput {
  name: string;
  page_id: string;
  ig_account_id?: string;
  video_id?: string;
  image_hash?: string;
  titles: string[];
  bodies: string[];
  cta_type: string;
  link_url?: string;
  app_store_url?: string;
}

// ── Page（FB 公共主页 / TT 主页）──

export interface AvailablePage {
  id: string;
  name: string;
  username: string | null;
  picture: string | null;
  source: 'owned' | 'partner';
  tasks: string[];
  igBusinessAccount: {
    id: string;
    username: string;
  } | null;
}

export interface BrandedContentPermission {
  id: string;
  brandIgId: string;
  brandUsername: string;
  creatorIgId: string;
  creatorUsername: string;
  permissionStatus: string;
}

// ── Material 上传 ──

export interface ChannelMaterial {
  channel_material_id: string;
  channel_thumbnail_url: string | null;
}

export interface MaterialStatus {
  status: 'uploading' | 'ready' | 'failed';
  channel_extra: Record<string, unknown>;
}

// ── Channel Adapter 接口 ──

export interface ChannelAdapter {
  readonly channel: Channel;

  // Account
  getAccount(accountId: string): Promise<AdAccount>;

  // Campaign
  listCampaigns(accountId: string): Promise<Campaign[]>;
  getCampaign(campaignId: string): Promise<Campaign>;
  createCampaign(accountId: string, input: CreateCampaignInput): Promise<Campaign>;
  updateCampaign(campaignId: string, input: UpdateCampaignInput): Promise<Campaign>;

  // AdSet
  listAdSets(campaignId: string): Promise<AdSet[]>;
  createAdSet(input: CreateAdSetInput): Promise<AdSet>;

  // Ad
  listAds(adgroup_id: string): Promise<Ad[]>;
  createAd(input: CreateAdInput): Promise<Ad>;

  // Creative
  createCreative(input: CreateCreativeInput): Promise<Creative>;

  // Page
  listAvailablePages(): Promise<AvailablePage[]>;
  listBrandedContentPermissions(brandIgId: string): Promise<BrandedContentPermission[]>;

  // Material
  uploadVideoByUrl(accountId: string, fileUrl: string, name: string): Promise<ChannelMaterial>;
  uploadImageByUrl(accountId: string, imageUrl: string): Promise<ChannelMaterial>;
  getVideoStatus(videoId: string): Promise<MaterialStatus>;
}
