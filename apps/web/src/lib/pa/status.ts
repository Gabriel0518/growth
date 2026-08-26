/**
 * 业务状态 → 展示文字 / 色调。**全站唯一映射来源**，不要在页面里各写各的。
 *
 * ⚠️ 中译英会撑破宽度：`审核中` → `In review` 是 36px → 58px。
 * 容器按最长英文串 +20% 定宽，表格状态列因此是 130px 而不是 100px（CLAUDE.md C2.6）。
 */

import type { AssetStatus, CampaignStatus, DeliveryState } from './types';

import type { PillTone } from '@/components/ui';

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  running: 'Live',
  review: 'Needs review',
  draft: 'Draft',
  stopped: 'Stopped',
  automating: 'Automating',
  ready: 'Ready to publish',
};

const CAMPAIGN_TONE: Record<CampaignStatus, PillTone> = {
  running: 'positive',
  review: 'warning',
  draft: 'neutral',
  stopped: 'neutral',
  automating: 'warning',
  ready: 'progress',
};

export function STATUS_TONE_OF(status: CampaignStatus): PillTone {
  return CAMPAIGN_TONE[status];
}

export const DELIVERY_LABEL: Record<DeliveryState, string> = {
  live: 'Live',
  preparing: 'Preparing',
  paused: 'Video stopped',
  // ⚠️ 这是**平台拒审**（Meta/TikTok），广告随之关闭。
  // 与 Content 页的「内部审核未通过」不是一回事，两者的色和动作都不能共用。
  rejected: 'Ad rejected',
};

const DELIVERY_TONE: Record<DeliveryState, PillTone> = {
  live: 'positive',
  preparing: 'neutral',
  paused: 'neutral',
  rejected: 'negative',
};

export function DELIVERY_TONE_OF(state: DeliveryState): PillTone {
  return DELIVERY_TONE[state];
}

export const ASSET_LABEL: Record<AssetStatus, string> = {
  ready: 'Ready',
  generating: 'Generating',
  review: 'Needs review',
  failed: 'Failed',
};

const ASSET_TONE: Record<AssetStatus, PillTone> = {
  ready: 'positive',
  generating: 'warning',
  review: 'warning',
  failed: 'negative',
};

export function ASSET_TONE_OF(status: AssetStatus): PillTone {
  return ASSET_TONE[status];
}
