/**
 * /api/user-lookup 的按用户 ID 归因查询 —— 复刻旧 server.js。
 * 读常驻 user_lookup 表（预建索引）；对每条 payload 解析产品、广告平台（FB/GG/TT）与投放层级。
 */

import { query } from '@agentic-ug/db';

import { LTV_APP_IDS, mapMediaSource } from './mapping';

interface UserLookupPayload {
  app_id?: string;
  bundle_id?: string;
  af_channel?: string;
  media_source?: string;
  campaign?: string;
  af_adset?: string;
  af_ad?: string;
  event_time?: string;
  install_time?: string;
  _platform?: string;
}

export interface UserLookupResult {
  product: string;
  appId: string;
  userId: number;
  mediaSource: string;
  adPlatform: string;
  campaign: string;
  adset: string;
  ad: string;
  eventTime: string;
  installTime: string;
  isOrganic: boolean;
  platform: string;
}

const FB_CHANNELS = new Set(['facebook', 'instagram', 'audiencenetwork', 'threads', 'graphic']);

/** 由 af_channel（优先）+ media_source（兜底）判定广告平台 FB/GG/TT，未知返回空串。 */
function classifyAdPlatform(payload: UserLookupPayload): string {
  const chLower = (payload.af_channel ?? '').toLowerCase();
  if (FB_CHANNELS.has(chLower) || chLower.startsWith('social_facebook')) return 'FB';
  if (chLower.startsWith('aci_')) return 'GG';
  if (chLower === 'tiktok') return 'TT';
  const mapped = mapMediaSource(payload.media_source ?? '');
  if (mapped === 'FB' || mapped === 'FB W2A') return 'FB';
  if (mapped === 'GG') return 'GG';
  if (mapped === 'TT') return 'TT';
  return '';
}

/** 查某用户全部归因事件（按 event_time 降序，(app_id,event_time) 去重）。 */
export async function lookupUser(userId: number): Promise<UserLookupResult[]> {
  const rows = await query<{
    payload: string | null;
    event_time: string | null;
    install_time: string | null;
    app_id: string | null;
  }>(
    `SELECT payload, event_time, install_time, app_id
     FROM user_lookup WHERE user_id = $1 ORDER BY event_time DESC`,
    [userId],
  );

  const results: UserLookupResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.payload == null) continue;
    let payload: UserLookupPayload;
    try {
      payload = JSON.parse(row.payload) as UserLookupPayload;
    } catch {
      continue;
    }
    const appId = payload.app_id ?? row.app_id ?? '';
    const product = LTV_APP_IDS[appId] ?? payload.bundle_id ?? appId;
    const key = `${row.app_id ?? ''}-${row.event_time ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      product,
      appId,
      userId,
      mediaSource: payload.af_channel ?? payload.media_source ?? '',
      adPlatform: classifyAdPlatform(payload),
      campaign: (payload.campaign ?? '').trim(),
      adset: (payload.af_adset ?? '').trim(),
      ad: (payload.af_ad ?? '').trim(),
      eventTime: payload.event_time ?? row.event_time ?? '',
      installTime: payload.install_time ?? row.install_time ?? '',
      isOrganic: !payload.campaign,
      platform: payload._platform ?? 'af',
    });
  }
  return results;
}
