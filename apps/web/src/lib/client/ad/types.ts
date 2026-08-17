/** 前端投放管理面板类型定义 —— 与后端 API 返回格式对齐。 */

export interface MaterialItem {
  id: number;
  name: string;
  file_url: string | null;
  source_type: string;
  mime_type: string | null;
  duration_ms: number | null;
  app_product: string | null;
  tags: unknown;
  creator: string | null;
  created_at: string;
}

export interface MaterialUploadItem {
  id: number;
  material_id: number;
  channel: string;
  channel_material_id: string | null;
  channel_thumbnail_url: string | null;
  status: string;
  channel_extra: unknown;
  uploaded_at: string;
}

export interface MaterialWithUploads extends MaterialItem {
  uploads: MaterialUploadItem[];
}

export interface CreativeItem {
  id: number;
  channel: string;
  channel_creative_id: string | null;
  channel_material_id: string;
  page_id: string | null;
  ig_account_id: string | null;
  cta_type: string | null;
  titles: string[];
  bodies: string[];
  channel_extra: unknown;
  created_at: string;
}

export interface FbCampaign {
  id: string; // FB 平台 campaign ID
  local_id: number; // 本地 ad_campaign.id (SERIAL)，级联选择时用
  name: string;
  status: string;
  objective: string;
  daily_budget?: number;
  app_product?: string | null;
  creator?: string | null;
  created_at?: string | null;
  channel_extra: Record<string, unknown>;
}

export interface FbAdSet {
  id: string; // FB 平台 adset ID
  local_id: number; // 本地 ad_set.id (SERIAL)
  name: string;
  status: string;
  optimization_goal: string;
  billing_event: string;
  targeting: Record<string, unknown>;
  channel_extra: Record<string, unknown>;
  campaign_product?: string | null;
  campaign_operator?: string | null;
  campaign_created_at?: string | null;
}

export interface FbAd {
  id: string; // FB 平台 ad ID
  local_id: number; // 本地 ad.id (SERIAL)
  name: string;
  status: string;
  effective_status: string;
  channel_extra: Record<string, unknown>;
  campaign_product?: string | null;
  campaign_operator?: string | null;
  campaign_created_at?: string | null;
}

export interface AvailablePage {
  id: string;
  name: string;
  username?: string | null;
  picture?: string | null;
  source?: 'owned' | 'partner';
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

export interface FbTokenPublic {
  id: number;
  token_preview: string;
  app_id: string;
  app_secret_preview: string;
  bm_id: string | null;
  bm_name: string | null;
  name: string | null;
  ad_accounts: AdAccount[];
  is_active: boolean;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdAccount {
  id: string;
  name: string;
  status: number;
}

export interface AccountMaterialItem {
  id: number;
  channel: string;
  channel_account_id: string;
  channel_material_id: string;
  type: 'image' | 'video';
  name: string | null;
  url: string | null;
  thumbnail_url: string | null;
  status: string | null;
  width: number | null;
  height: number | null;
  length_ms: number | null;
  channel_extra: unknown;
  created_at: string;
  updated_at: string;
}

export interface AdAccountConfig {
  accountId: string;
  accountName: string;
  accountStatus: number;
  tokenId: number;
  tokenName: string;
  token: string;
  appId: string;
  appSecret: string;
  availablePages: AvailablePage[];
}
