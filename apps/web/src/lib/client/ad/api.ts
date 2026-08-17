/**
 * 投放管理前端 API 封装 —— fetch 调 /api/ad/* 各端点。
 *
 * Demo 阶段用裸 fetch，后续可迁移到 getJson / postJson 通用封装。
 */

const BASE = '/api/ad';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (!res.ok) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = await res.json().catch(() => ({ error: res.statusText }));

    throw new Error((body as { error?: string }).error ?? `HTTP ${String(res.status)}`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!res.ok) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const err = await res.json().catch(() => ({ error: res.statusText }));

    throw new Error((err as { error?: string }).error ?? `HTTP ${String(res.status)}`);
  }
  return res.json() as Promise<T>;
}

async function patchJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (!res.ok) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const err = await res.json().catch(() => ({ error: res.statusText }));

    throw new Error((err as { error?: string }).error ?? `HTTP ${String(res.status)}`);
  }
  return res.json() as Promise<T>;
}

// ── 素材 ──

async function deleteJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${String(res.status)}`);
  }
  return res.json() as Promise<T>;
}

import type {
  AccountMaterialItem,
  AdAccountConfig,
  AvailablePage,
  BrandedContentPermission,
  CreativeItem,
  FbAd,
  FbAdSet,
  FbCampaign,
  FbTokenPublic,
  MaterialUploadItem,
  MaterialWithUploads,
} from './types';

// ── Token 管理 ──

export function fetchFbTokens(): Promise<FbTokenPublic[]> {
  return getJson<FbTokenPublic[]>('/tokens');
}

export function createFbToken(body: {
  token: string;
  app_id: string;
  app_secret: string;
  name?: string;
}): Promise<FbTokenPublic> {
  return postJson<FbTokenPublic>('/tokens', body);
}

export function fetchAdAccountConfigs(): Promise<AdAccountConfig[]> {
  return getJson<AdAccountConfig[]>('/accounts');
}

export function updateFbToken(
  id: number,
  body: {
    token?: string;
    app_id?: string;
    app_secret?: string;
    name?: string;
  },
): Promise<FbTokenPublic> {
  return patchJson<FbTokenPublic>(`/tokens?id=${encodeURIComponent(String(id))}`, body);
}

export function deleteFbToken(id: number): Promise<{ ok: boolean }> {
  return deleteJson<{ ok: boolean }>(`/tokens?id=${encodeURIComponent(String(id))}`);
}

export function refreshFbToken(id: number): Promise<FbTokenPublic> {
  return postJson<FbTokenPublic>(`/tokens/refresh?id=${encodeURIComponent(String(id))}`);
}

// ── 账户素材库 ──

export function fetchAccountMaterials(
  accountId: string,
  page = 1,
  pageSize = 24,
): Promise<{ data: AccountMaterialItem[]; total: number; page: number; pageSize: number }> {
  return getJson<{ data: AccountMaterialItem[]; total: number; page: number; pageSize: number }>(
    `/account-materials?accountId=${encodeURIComponent(accountId)}&page=${String(page)}&pageSize=${String(pageSize)}`,
  );
}

export function syncAccountMaterials(accountId: string): Promise<{ images: number; videos: number }> {
  return postJson<{ images: number; videos: number }>(
    `/account-materials/sync?accountId=${encodeURIComponent(accountId)}`,
  );
}

export function fetchMaterials(channel?: string): Promise<MaterialWithUploads[]> {
  const qs = channel ? `?channel=${channel}` : '';
  return getJson<MaterialWithUploads[]>(`/materials${qs}`);
}

export function createMaterial(body: {
  file_url: string;
  name: string;
  app_product?: string;
}): Promise<MaterialWithUploads> {
  return postJson<MaterialWithUploads>('/materials', body);
}

export function syncMaterial(id: number, channel = 'fb', accountId?: string): Promise<MaterialUploadItem> {
  const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
  return postJson<MaterialUploadItem>(`/materials/${encodeURIComponent(String(id))}/sync${qs}`, { channel });
}

// ── Pages ──

export function fetchPages(accountId?: string): Promise<AvailablePage[]> {
  const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
  return getJson<AvailablePage[]>(`/pages${qs}`);
}

// ── 共创权限 ──

export function fetchBrandedContentPermissions(
  accountId: string,
  brandIgId: string,
): Promise<BrandedContentPermission[]> {
  return getJson<BrandedContentPermission[]>(
    `/branded-content-permissions?accountId=${encodeURIComponent(accountId)}&brandIgId=${encodeURIComponent(brandIgId)}`,
  );
}

// ── 创意 ──

export function fetchCreatives(channel?: string): Promise<CreativeItem[]> {
  const qs = channel ? `?channel=${channel}` : '';
  return getJson<CreativeItem[]>(`/creatives${qs}`);
}

export function createCreative(body: {
  material_upload_id: string;
  page_id: string;
  ig_account_id?: string;
}): Promise<CreativeItem> {
  return postJson<CreativeItem>('/creatives', body);
}

// ── 同步 ──

export interface SyncResult {
  campaigns: number;
  adsets: number;
  ads: number;
  // 全量同步（不传 accountId）时返回的额外字段
  accounts?: number;
  skippedAccounts?: number;
  failures?: string[];
}

export function syncFromFb(accountId?: string): Promise<SyncResult> {
  return postJson<SyncResult>('/sync', { accountId });
}

/** 只同步 Campaign（不下钻）。 */
export function syncCampaignsOnly(accountId: string): Promise<{ count: number }> {
  return postJson<{ count: number }>(`/sync/campaigns?accountId=${encodeURIComponent(accountId)}`);
}

/** 只同步指定 Campaign 下的 AdSet。campaign_id 为 FB 侧 ID。 */
export function syncAdSetsOnly(
  accountId: string,
  campaignId: string,
): Promise<{ count: number }> {
  return postJson<{ count: number }>(
    `/sync/adsets?accountId=${encodeURIComponent(accountId)}&campaign_id=${encodeURIComponent(campaignId)}`,
  );
}

/** 只同步指定 AdSet 下的 Ad。adset_id 为 FB 侧 ID。 */
export function syncAdsOnly(accountId: string, adsetId: string): Promise<{ count: number }> {
  return postJson<{ count: number }>(
    `/sync/ads?accountId=${encodeURIComponent(accountId)}&adset_id=${encodeURIComponent(adsetId)}`,
  );
}

// ── Campaign ──

export function fetchCampaigns(accountId?: string): Promise<FbCampaign[]> {
  const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
  return getJson<FbCampaign[]>(`/campaigns${qs}`);
}

export function createCampaign(
  body: {
    name: string;
    objective: string;
    status?: string;
    daily_budget?: number;
    special_ad_categories?: string[];
    buying_type?: string;
    bid_strategy?: string;
    product?: string;
  },
  accountId?: string,
): Promise<FbCampaign> {
  if (!accountId) throw new Error('请先在右上角选择广告账户');
  return postJson<FbCampaign>(`/campaigns?accountId=${encodeURIComponent(accountId)}`, body);
}

export function updateCampaign(
  id: string,
  body: { name?: string; status?: string; daily_budget?: number },
  accountId?: string,
): Promise<FbCampaign> {
  if (!accountId) throw new Error('请先在右上角选择广告账户');
  return patchJson<FbCampaign>(
    `/campaigns?id=${encodeURIComponent(id)}&accountId=${encodeURIComponent(accountId)}`,
    body,
  );
}

// ── AdGroup ──

export function fetchAdSets(campaignId: string, accountId?: string): Promise<FbAdSet[]> {
  const qs = `campaign_id=${encodeURIComponent(campaignId)}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}`;
  return getJson<FbAdSet[]>(`/adsets?${qs}`);
}

export function createAdSet(
  body: {
    name: string;
    campaign_id: string;
    status?: string;
    optimization_goal: string;
    billing_event: string;
    daily_budget?: number;
    bid_strategy?: string;
    targeting: Record<string, unknown>;
    destination_type?: string;
    is_skadnetwork_attribution?: boolean;
    is_dynamic_creative?: boolean;
    promoted_object?: Record<string, unknown>;
    attribution_spec?: Record<string, unknown>[];
  },
  accountId?: string,
): Promise<FbAdSet> {
  if (!accountId) throw new Error('请先在右上角选择广告账户');
  return postJson<FbAdSet>(`/adsets?accountId=${encodeURIComponent(accountId)}`, body);
}

export function updateAdSet(
  id: string,
  body: { daily_budget?: number; status?: string; name?: string },
  accountId?: string,
): Promise<{ ok: boolean }> {
  if (!accountId) throw new Error('请先在右上角选择广告账户');
  return patchJson<{ ok: boolean }>(
    `/adsets?id=${encodeURIComponent(id)}&accountId=${encodeURIComponent(accountId)}`,
    body,
  );
}

/** 个人面板对象信息：账户 + 当前状态 + 日预算（分）。 */
export interface AdTargetInfo {
  accountId: string;
  status: string;
  daily_budget: number | null;
}

/** 解析 FB campaign/adset id 的账户、当前状态与日预算（个人面板 toggle/预算用）。 */
export function fetchTargetInfo(id: string, kind: 'campaign' | 'adset'): Promise<AdTargetInfo> {
  const key = kind === 'campaign' ? 'campaign_id' : 'adset_id';
  return getJson<AdTargetInfo>(`/personal/account?${key}=${encodeURIComponent(id)}`);
}

// ── Ad ──

export function fetchAds(adsetId: string, accountId?: string): Promise<FbAd[]> {
  const qs = `adset_id=${encodeURIComponent(adsetId)}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}`;
  return getJson<FbAd[]>(`/ads?${qs}`);
}

export function createAd(
  body: {
    name: string;
    adset_id: string;
    local_creative_id?: string;
    status?: string;
    page_id?: string;
    // 内联创意
    material_id?: number;
    creative_name?: string;
    titles?: string[];
    bodies?: string[];
    optimization_type?: string;
    link_url?: string;
    call_to_action_type?: string;
    link_description?: string;
    url_tags?: string;
    // 共创
    ig_user_id?: string;
    instagram_branded_content?: Record<string, unknown>;
  },
  accountId?: string,
): Promise<FbAd> {
  if (!accountId) throw new Error('请先在右上角选择广告账户');
  return postJson<FbAd>(`/ads?accountId=${encodeURIComponent(accountId)}`, body);
}

/** 调用 FB copies 端点复制广告 */
export function copyAd(
  adId: string,
  accountId: string,
  body: Record<string, unknown> & { page_id?: string },
): Promise<{ copied_ad_id: string }> {
  return postJson<{ copied_ad_id: string }>(
    `/ads/${encodeURIComponent(adId)}/copy?accountId=${encodeURIComponent(accountId)}`,
    body,
  );
}
