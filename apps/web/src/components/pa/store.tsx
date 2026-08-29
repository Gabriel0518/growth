'use client';

import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';

import {
  AD_ACCOUNTS,
  ASSETS,
  AUDIENCE,
  AUTOMATION_LOG,
  CAMPAIGNS,
  CREATORS,
  DELIVERY,
  HISTORY,
  MONTHLY_SPEND_PCT,
  NOW,
  PRODUCTS,
  USER,
} from '@/lib/pa/mock-data';
import type {
  Asset,
  Campaign,
  CampaignStatus,
  Creator,
  Delivery,
  Draft,
  PaState,
} from '@/lib/pa/types';

/**
 * 单一数据源。**一处改动，所有页面同步反映** —— 这是原型最有价值的部分，
 * 不能退化成每屏各造一份假数据：
 *   - 发布 campaign  → 列表 / Overview / Reports 合计 / 侧栏计数同时出现
 *   - 暂停 campaign  → 胶囊在三处同时翻转，清剩余天数、delivering 归零、写日志
 *   - 添加创作者     → campaign 的 KOL 数上升，详情页多出投放行
 *
 * 用 Context + useReducer 而非状态库：仓库现状就是只用原生 hooks
 * （doc 03 §5.2 / AGENTS.md 都写明无 Redux / Zustand / TanStack Query）。
 *
 * ⚠️ 接后端时这一层保留，只把初始 state 换成 DemoOverview 的映射结果。
 */

/** tick 放进 state 而不是闭包，reducer 才能保持纯函数。 */
interface StoreState extends PaState {
  tick: number;
  /**
   * 是否已经尝试过从 sessionStorage 恢复会话。
   * ⚠️ 没有这个闸门，AppShell 会在恢复动作落地之前就把人弹去登录页 ——
   * 表现为「刷新任何页面都被登出」。
   */
  hydrated: boolean;
}

/** 会话标记存 sessionStorage：刷新能撑住，关掉标签页就没了，不冒充真实鉴权。 */
const SESSION_KEY = 'pa-signed-in';

const INITIAL: StoreState = {
  signedIn: false,
  user: USER,
  monthlySpendPct: MONTHLY_SPEND_PCT,
  lastSync: NOW,
  audience: AUDIENCE,
  products: PRODUCTS,
  campaigns: CAMPAIGNS,
  creators: CREATORS,
  delivery: DELIVERY,
  history: HISTORY,
  assets: ASSETS,
  automationLog: AUTOMATION_LOG,
  adAccounts: AD_ACCOUNTS,
  draft: null,
  tick: 0,
  hydrated: false,
};

export type PaAction =
  | { type: 'hydrate'; signedIn: boolean; email: string | null }
  | { type: 'signIn'; email: string }
  | { type: 'signOut' }
  | { type: 'setStatus'; id: string; status: CampaignStatus }
  | { type: 'setCap'; id: string; cap: number }
  | { type: 'createCampaign'; draft: Draft }
  | { type: 'addCreators'; campaignId: string; creatorIds: string[] }
  | { type: 'advanceAutomation'; campaignId: string }
  | { type: 'retryRejectedAds'; campaignId: string }
  | { type: 'stopDelivery'; campaignId: string; creatorId: string }
  | { type: 'approveAsset'; id: string }
  | { type: 'setDraft'; draft: Draft | null }
  | {
      type: 'updateCreator';
      id: string;
      patch: Partial<Pick<Creator, 'avatar' | 'faceAvatar' | 'faceConfidence'>>;
    }
  | { type: 'addAsset'; asset: Asset }
  | { type: 'updateAsset'; id: string; patch: Partial<Asset> }
  | { type: 'removeAsset'; id: string };

/** 确定性时钟：从 14:05 起每次前进 7 分钟。不用 Date.now()，截图才可复现。 */
function stamp(tick: number): string {
  const base = 14 * 60 + 5 + (tick + 1) * 7;
  const h = Math.floor(base / 60) % 24;
  const m = base % 60;
  return `${h < 10 ? '0' : ''}${String(h)}:${m < 10 ? '0' : ''}${String(m)}`;
}

/** 往自动化日志前插一条，同时推进时钟。 */
function withLog(
  state: StoreState,
  campaignId: string | undefined,
  title: string,
  sub: string,
): StoreState {
  const entry =
    campaignId === undefined
      ? { t: stamp(state.tick), title, sub }
      : { t: stamp(state.tick), title, sub, campaignId };
  return { ...state, tick: state.tick + 1, automationLog: [entry, ...state.automationLog] };
}

function preparingDelivery(creator: Creator, campaignId: string, matchedAt = 0): Delivery {
  return {
    creatorId: creator.id,
    campaignId,
    impressions: 0,
    clicks: 0,
    revenue: 0,
    pacing: 0,
    roas: 0,
    fit: Math.min(99, Math.round(60 + creator.eng * 5)),
    state: 'preparing',
    views: 0,
    cpi: 0,
    matchedAt,
  };
}

interface ReviewAssetOptions {
  fileName?: string;
  previewUrl?: string;
}

function reviewAsset(
  creator: Creator,
  campaignId: string,
  id: string,
  productId?: string,
  sourceAssetId?: string,
  options?: ReviewAssetOptions,
): Asset {
  const slug = creator.handle
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase();
  // AIGC must use the explicit face reference. The social account avatar is
  // display metadata only and is never silently substituted for a face input.
  const faceReference = creator.faceAvatar;
  return {
    id,
    file: options?.fileName ?? `ai_${slug}_cut.mp4`,
    kind: 'MP4',
    ratio: '9:16',
    len: '0:15',
    status: 'generating',
    origin: 'ai',
    creatorId: creator.id,
    hue: creator.hue,
    campaignId,
    ...(productId ? { productId } : {}),
    ...(sourceAssetId ? { sourceAssetId } : {}),
    ...(faceReference ? { cover: faceReference } : {}),
    ...(options?.previewUrl ? { previewUrl: options.previewUrl } : {}),
  };
}

function sourceIdsForCampaign(state: StoreState, campaign: Campaign): string[] {
  if (campaign.sourceAssetIds && campaign.sourceAssetIds.length > 0) {
    return campaign.sourceAssetIds;
  }
  return state.assets
    .filter((asset) => asset.campaignId === campaign.id && asset.origin === 'original')
    .map((asset) => asset.id);
}

const AUTO_CREATOR_NAMES = [
  'Avery Collins',
  'Jordan Lee',
  'Maya Carter',
  'Theo Brooks',
  'Sage Rivera',
  'Camila Stone',
  'Noah Brooks',
  'Riley Chen',
  'Jules Hart',
  'Devon Kim',
  'Harper Lane',
  'Kai Monroe',
  'Parker Vale',
  'Milo Reed',
  'Casey Blake',
  'Taylor Fox',
  'Morgan Ellis',
  'Skylar Rose',
  'Quinn Avery',
  'Reese Morgan',
  'Rowan Cole',
  'Jamie Park',
  'Dakota Ray',
  'Blair Hayes',
  'Finley Ward',
  'Alexis Moore',
  'Cameron West',
  'Emery James',
] as const;

function generatedCreator(state: StoreState, campaign: Campaign): Creator | undefined {
  if (state.creators.length === 0 || campaign.kols >= (campaign.targetKols ?? campaign.kols)) {
    return undefined;
  }
  const base = state.creators.find((creator) => !creator.id.startsWith('auto-'));
  if (!base) return undefined;
  const generatedCount = state.creators.filter((creator) => creator.id.startsWith('auto-')).length;
  const name = AUTO_CREATOR_NAMES[generatedCount % AUTO_CREATOR_NAMES.length] ?? 'New creator';
  const handle = `@${name.replace(/[^a-z0-9]+/gi, '').toLowerCase()}_${String(campaign.kols)}`;
  return {
    ...base,
    id: `auto-${campaign.id}-${String(campaign.kols)}`,
    name,
    handle,
    joined: 'Aug 2026',
    followers: Math.round(base.followers * (0.24 + ((campaign.kols * 7) % 60) / 100)),
    avgViews: Math.round(base.avgViews * (0.2 + ((campaign.kols * 3) % 50) / 100)),
    hue: (base.hue + campaign.kols * 11) % 360,
    profileUrl: `https://www.instagram.com/${handle.slice(1)}/`,
  };
}

function publishDelivery(delivery: Delivery): Delivery {
  return {
    ...delivery,
    // A newly published video starts at zero. The regular automation tick
    // grows it from the creator's audience size instead of jumping to a
    // fabricated first-day total.
    impressions: 0,
    clicks: 0,
    revenue: 0,
    pacing: 0,
    roas: 0,
    state: 'live',
    views: 0,
    cpi: 0,
  };
}

/** A few platform-side safety checks fail in the simulator so the workspace
 * visibly demonstrates the rejected-ad path as well as the happy path. */
function shouldSimulatePlatformRejection(creator: Creator): boolean {
  return creator.id === 'marcus' || creator.id === 'chloe' || creator.id === 'network-007';
}

function reducer(state: StoreState, action: PaAction): StoreState {
  switch (action.type) {
    case 'hydrate': {
      return {
        ...state,
        hydrated: true,
        signedIn: action.signedIn,
        user: action.email === null ? state.user : { ...state.user, email: action.email },
      };
    }

    case 'signIn': {
      return { ...state, signedIn: true, user: { ...state.user, email: action.email } };
    }

    case 'signOut': {
      return { ...state, signedIn: false };
    }

    case 'setStatus': {
      const target = state.campaigns.find((c) => c.id === action.id);
      if (!target) return state;
      const campaigns = state.campaigns.map((c) =>
        c.id === action.id
          ? // 停投时清掉剩余天数并把 delivering 归零 —— 留着旧值会让停投的
            // campaign 看起来还在跑，这正是监视器最不该出的错。
            action.status === 'stopped'
            ? { ...c, status: action.status, days: null, delivering: 0 }
            : { ...c, status: action.status }
          : c,
      );
      const stopped = action.status === 'stopped';
      return withLog(
        { ...state, campaigns },
        action.id,
        stopped ? 'Campaign stopped' : 'Campaign resumed',
        stopped ? 'delivery halted, posts left up' : 'ads returned to delivery',
      );
    }

    case 'setCap': {
      const target = state.campaigns.find((c) => c.id === action.id);
      if (!target) return state;
      const campaigns = state.campaigns.map((c) =>
        c.id === action.id ? { ...c, cap: action.cap } : c,
      );
      return withLog(
        { ...state, campaigns },
        action.id,
        'Budget cap changed',
        `$${target.cap.toLocaleString('en-US')} → $${action.cap.toLocaleString('en-US')}`,
      );
    }

    case 'createCampaign': {
      const { draft } = action;
      const campaignId = `CMP-2409-${String(100 + state.campaigns.length)}`;
      const seedCreators = state.creators.slice(0, Math.min(3, state.creators.length));
      const selectedSources = (draft.sourceAssetIds ?? [])
        .map((id) => state.assets.find((asset) => asset.id === id))
        .filter((asset): asset is NonNullable<typeof asset> => asset?.origin === 'original');
      const selectedSourceIs123 = selectedSources.some(
        (source) => source.id === 'source-123' || source.file.toLowerCase() === '123.mp4',
      );
      const sourceCopies = selectedSources.map((source) => ({
        ...source,
        id: `source-${campaignId}-${source.id}`,
        campaignId,
        productId: draft.productId,
      }));
      const sourceIds = sourceCopies.map((source) => source.id);
      const created: Campaign = {
        id: campaignId,
        name: draft.name,
        market: draft.market,
        productId: draft.productId,
        // 发布后即进入 Live；匹配、素材和创作者发布在详情页持续自动推进。
        status: 'running',
        owner: state.user.name,
        kols: seedCreators.length,
        targetKols: Math.max(seedCreators.length, draft.kolTarget || 40),
        spend: 0,
        cap: draft.cap,
        reach: 0,
        impressions: 0,
        installs: 0,
        cpi: 0,
        roas: 0,
        // 投放由用户手动启停，不再写入一个看似自动结束的默认天数。
        days: null,
        channels: draft.channels.length > 0 ? draft.channels : ['ig', 'tt'],
        schedule: draft.schedule,
        delivering: 0,
        closed: 0,
        isNew: true,
        sourceAssetIds: sourceIds,
      };
      const sourceAssetId = sourceIds[0];
      const seedDeliveries = seedCreators.map((creator) =>
        preparingDelivery(creator, campaignId, 0),
      );
      const seedAssets = seedCreators.map((creator, index) =>
        reviewAsset(
          creator,
          campaignId,
          `auto-${campaignId}-${String(index + 1)}`,
          draft.productId,
          sourceAssetId,
          selectedSourceIs123 && creator.id === 'lucia'
            ? { fileName: '1.mp4', previewUrl: '/pa/videos/ai-1.mp4' }
            : undefined,
        ),
      );
      return withLog(
        {
          ...state,
          campaigns: [created, ...state.campaigns],
          delivery: [...seedDeliveries, ...state.delivery],
          assets: [...seedAssets, ...sourceCopies, ...state.assets],
          draft: null,
        },
        created.id,
        'Campaign live',
        `${draft.market} · matching ${String(seedCreators.length)} creators and generating creative`,
      );
    }

    case 'addCreators': {
      const campaign = state.campaigns.find((c) => c.id === action.campaignId);
      if (!campaign) return state;
      const existing = new Set(
        state.delivery.filter((d) => d.campaignId === action.campaignId).map((d) => d.creatorId),
      );
      const fresh = action.creatorIds
        .filter((id) => !existing.has(id))
        .map((id) => state.creators.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
      if (fresh.length === 0) return state;

      const rows = fresh.map((creator) => ({
        creatorId: creator.id,
        campaignId: action.campaignId,
        impressions: 0,
        clicks: 0,
        revenue: 0,
        pacing: 0,
        roas: 0,
        // fit 由互动率推出。这里有品类+目标+预算三个约束，算得出来；
        // KOL Network 那边是无约束浏览，所以不显示 fit（CAMPAIGN-LIVE.md）。
        fit: Math.min(99, Math.round(60 + creator.eng * 5)),
        state: 'preparing' as const,
        views: 0,
        cpi: 0,
        matchedAt: state.tick,
      }));
      const assets = fresh.map((creator, index) =>
        reviewAsset(
          creator,
          action.campaignId,
          `manual-${action.campaignId}-${String(state.tick)}-${String(index)}`,
          campaign.productId,
          sourceIdsForCampaign(state, campaign)[0],
        ),
      );

      const campaigns = state.campaigns.map((c) =>
        c.id === action.campaignId
          ? {
              ...c,
              kols: c.kols + fresh.length,
              delivering: c.isNew ? c.delivering : c.delivering + fresh.length,
            }
          : c,
      );
      return withLog(
        {
          ...state,
          campaigns,
          delivery: [...state.delivery, ...rows],
          assets: [...assets, ...state.assets],
        },
        action.campaignId,
        `${String(fresh.length)} creator${fresh.length === 1 ? '' : 's'} added`,
        'matching and creative build queued',
      );
    }

    case 'advanceAutomation': {
      const campaign = state.campaigns.find((c) => c.id === action.campaignId);
      if (!campaign || campaign.status !== 'running') return state;

      const campaignRows = state.delivery.filter((d) => d.campaignId === campaign.id);
      const campaignAssets = state.assets.filter((a) => a.campaignId === campaign.id);
      const sourceAssetId = sourceIdsForCampaign(state, campaign)[0];

      // Each stage is deliberately separated by a tick so matching, safety
      // clearance and publishing never appear to happen at the same moment.
      const readyToClear = campaignRows.find((row) => {
        const asset = campaignAssets.find((item) => item.creatorId === row.creatorId);
        return (
          row.state === 'preparing' &&
          asset?.status === 'generating' &&
          (row.matchedAt ?? 0) < state.tick
        );
      });
      if (readyToClear) {
        const creator = state.creators.find((item) => item.id === readyToClear.creatorId);
        const asset = campaignAssets.find((item) => item.creatorId === readyToClear.creatorId);
        if (creator && asset) {
          return withLog(
            {
              ...state,
              assets: state.assets.map((item) =>
                item.id === asset.id
                  ? { ...item, status: 'ready' as const, approvedAt: state.tick }
                  : item,
              ),
            },
            campaign.id,
            'Creative auto-cleared',
            `${creator.name} · video passed automated brand and safety checks`,
          );
        }
      }

      const readyToPublish = campaignRows.find((row) => {
        const asset = campaignAssets.find((item) => item.creatorId === row.creatorId);
        return (
          row.state === 'preparing' &&
          asset?.status === 'ready' &&
          (asset.approvedAt ?? 0) < state.tick - 0
        );
      });
      if (readyToPublish) {
        const creator = state.creators.find((item) => item.id === readyToPublish.creatorId);
        const asset = campaignAssets.find((item) => item.creatorId === readyToPublish.creatorId);
        if (creator && asset) {
          if (shouldSimulatePlatformRejection(creator) && (asset.retryCount ?? 0) === 0) {
            const campaigns = state.campaigns.map((item) =>
              item.id === campaign.id ? { ...item, closed: item.closed + 1 } : item,
            );
            return withLog(
              {
                ...state,
                campaigns,
                delivery: state.delivery.map((item) =>
                  item.creatorId === readyToPublish.creatorId && item.campaignId === campaign.id
                    ? {
                        ...item,
                        state: 'rejected' as const,
                        impressions: 0,
                        clicks: 0,
                        views: 0,
                        revenue: 0,
                        pacing: 0,
                        closedAt: state.tick,
                      }
                    : item,
                ),
                assets: state.assets.map((item) =>
                  item.id === asset.id ? { ...item, status: 'ready' as const } : item,
                ),
              },
              campaign.id,
              'Ad rejected',
              `${creator.name} · platform safety review closed this ad; other creators continue`,
            );
          }
          const published = publishDelivery(readyToPublish);
          const campaigns = state.campaigns.map((item) =>
            item.id === campaign.id
              ? {
                  ...item,
                  delivering: item.delivering + 1,
                  spend: Math.min(item.cap, item.spend + 680),
                  impressions: item.impressions + published.impressions,
                  reach: item.reach + Math.round(published.impressions * 0.78),
                  installs: item.installs + Math.max(1, Math.round(published.clicks * 0.22)),
                  cpi:
                    (item.spend + 680) /
                    Math.max(1, item.installs + Math.round(published.clicks * 0.22)),
                  roas: Math.max(item.roas, published.roas),
                }
              : item,
          );
          return withLog(
            {
              ...state,
              campaigns,
              delivery: state.delivery.map((item) =>
                item.creatorId === published.creatorId && item.campaignId === published.campaignId
                  ? { ...published, publishedAt: state.tick }
                  : item,
              ),
            },
            campaign.id,
            'Creator post published',
            `${creator.name} is live on ${creator.platforms.join('/').toUpperCase()} · auto-approved`,
          );
        }
      }

      const existing = new Set(campaignRows.map((d) => d.creatorId));
      const remaining = Math.max(0, (campaign.targetKols ?? campaign.kols) - campaign.kols);
      const batchSize = Math.min(remaining, 3 + (state.tick % 2));
      const matchedCreators = state.creators
        .filter((candidate) => !existing.has(candidate.id))
        .slice(0, batchSize);
      if (matchedCreators.length === 0 && remaining > 0) {
        const generated = generatedCreator(state, campaign);
        if (generated) matchedCreators.push(generated);
      }
      if (matchedCreators.length > 0) {
        const deliveries = matchedCreators.map((creator) =>
          preparingDelivery(creator, campaign.id, state.tick),
        );
        const assets = matchedCreators.map((creator, index) =>
          reviewAsset(
            creator,
            campaign.id,
            `auto-${campaign.id}-${String(state.tick)}-${String(index)}`,
            campaign.productId,
            sourceAssetId,
          ),
        );
        const campaigns = state.campaigns.map((item) =>
          item.id === campaign.id ? { ...item, kols: item.kols + matchedCreators.length } : item,
        );
        return withLog(
          {
            ...state,
            creators: [
              ...matchedCreators.filter(
                (creator) => !state.creators.some((item) => item.id === creator.id),
              ),
              ...state.creators,
            ],
            campaigns,
            delivery: [...deliveries, ...state.delivery],
            assets: [...assets, ...state.assets],
          },
          campaign.id,
          'KOLs matched',
          `${String(matchedCreators.length)} creators connected · AI creative rendering in parallel`,
        );
      }

      const liveRows = campaignRows.filter((row) => row.state === 'live');
      if (liveRows.length === 0) return { ...state, tick: state.tick + 1 };
      const delivery = state.delivery.map((item) => {
        if (item.campaignId !== campaign.id || item.state !== 'live') return item;
        const creator = state.creators.find((candidate) => candidate.id === item.creatorId);
        const followers = creator?.followers ?? 250_000;
        // Larger audiences accumulate views faster, while the small floor
        // keeps nano creators visibly moving too.
        const viewDelta = Math.max(180, Math.round(Math.sqrt(followers) * 6));
        const impressionDelta = Math.max(viewDelta, Math.round(viewDelta * 1.16));
        const clickDelta = Math.max(1, Math.round(impressionDelta * 0.027));
        return {
          ...item,
          impressions: item.impressions + impressionDelta,
          clicks: item.clicks + clickDelta,
          revenue: item.revenue + Math.max(1, Math.round(impressionDelta * 0.0045)),
          views: item.views + viewDelta,
          pacing: Math.min(100, item.pacing + 2),
          cpi: item.cpi > 0 ? item.cpi : 2.18,
        };
      });
      const deltaSpend = liveRows.length * 145;
      const deltaImpressions = liveRows.reduce(
        (sum, item) => sum + Math.max(1, Math.round(item.impressions * 0.018)),
        0,
      );
      const deltaInstalls = Math.max(1, Math.round(deltaImpressions * 0.006));
      const campaigns = state.campaigns.map((item) =>
        item.id === campaign.id
          ? {
              ...item,
              spend: Math.min(item.cap, item.spend + deltaSpend),
              impressions: item.impressions + deltaImpressions,
              reach: item.reach + Math.round(deltaImpressions * 0.76),
              installs: item.installs + deltaInstalls,
              cpi: (item.spend + deltaSpend) / Math.max(1, item.installs + deltaInstalls),
              roas: Math.min(9.99, Math.max(item.roas, 0.92 + item.delivering * 0.04)),
            }
          : item,
      );
      const next = { ...state, campaigns, delivery, tick: state.tick + 1 };
      // A pulse is a meaningful checkpoint, not a heartbeat. The delivery
      // metrics still move every tick, while the log records every third one.
      const nextCampaign = campaigns.find((item) => item.id === campaign.id);
      return state.tick % 3 === 0
        ? withLog(
            next,
            campaign.id,
            'Campaign performance update',
            `${String(liveRows.length)} videos live · ${String(nextCampaign?.impressions.toLocaleString('en-US') ?? '0')} impressions · ${String(nextCampaign?.installs.toLocaleString('en-US') ?? '0')} installs · $${String(nextCampaign?.spend.toLocaleString('en-US') ?? '0')} spent`,
          )
        : next;
    }

    case 'retryRejectedAds': {
      const campaign = state.campaigns.find((item) => item.id === action.campaignId);
      if (!campaign) return state;
      const rejectedRows = state.delivery.filter(
        (item) => item.campaignId === campaign.id && item.state === 'rejected',
      );
      if (rejectedRows.length === 0) return state;

      const rejectedIds = new Set(rejectedRows.map((item) => item.creatorId));
      const nextAssets = [...state.assets];
      rejectedRows.forEach((row, index) => {
        const creator = state.creators.find((item) => item.id === row.creatorId);
        if (!creator) return;
        const existingIndex = nextAssets.findIndex(
          (asset) => asset.campaignId === campaign.id && asset.creatorId === creator.id,
        );
        const existing = existingIndex >= 0 ? nextAssets[existingIndex] : undefined;
        const retryCount = (existing?.retryCount ?? 0) + 1;
        const replacement = reviewAsset(
          creator,
          campaign.id,
          `retry-${campaign.id}-${String(state.tick)}-${String(index)}`,
          campaign.productId,
          sourceIdsForCampaign(state, campaign)[0],
        );
        const nextAsset: Asset = {
          ...(existing ?? replacement),
          ...replacement,
          id: existing?.id ?? replacement.id,
          file: `ai_${creator.handle
            .replace(/^@/, '')
            .replace(/[^a-z0-9]+/gi, '-')
            .toLowerCase()}_retry-${String(retryCount)}.mp4`,
          retryCount,
          status: 'generating',
        };
        if (existingIndex >= 0) nextAssets[existingIndex] = nextAsset;
        else nextAssets.unshift(nextAsset);
      });

      const campaigns = state.campaigns.map((item) =>
        item.id === campaign.id
          ? { ...item, closed: Math.max(0, item.closed - rejectedRows.length) }
          : item,
      );
      return withLog(
        {
          ...state,
          campaigns,
          assets: nextAssets,
          delivery: state.delivery.map((item) =>
            rejectedIds.has(item.creatorId) && item.campaignId === campaign.id
              ? { ...item, state: 'preparing' as const, matchedAt: state.tick }
              : item,
          ),
        },
        campaign.id,
        'Rejected ads rebuilding',
        `${String(rejectedRows.length)} ads sent back to AI creative generation and upload`,
      );
    }

    case 'stopDelivery': {
      const current = state.delivery.find(
        (item) => item.campaignId === action.campaignId && item.creatorId === action.creatorId,
      );
      const campaign = state.campaigns.find((item) => item.id === action.campaignId);
      const creator = state.creators.find((item) => item.id === action.creatorId);
      if (
        !current ||
        !campaign ||
        !creator ||
        current.state === 'paused' ||
        current.state === 'rejected'
      ) {
        return state;
      }
      const wasLive = current.state === 'live';
      const campaigns = state.campaigns.map((item) =>
        item.id === campaign.id
          ? {
              ...item,
              delivering: Math.max(0, item.delivering - (wasLive ? 1 : 0)),
              closed: item.closed + 1,
            }
          : item,
      );
      return withLog(
        {
          ...state,
          campaigns,
          delivery: state.delivery.map((item) =>
            item === current ? { ...item, state: 'paused' as const, closedAt: state.tick } : item,
          ),
        },
        campaign.id,
        'Creator video stopped',
        `${creator.name} · delivery paused by workspace admin`,
      );
    }

    case 'approveAsset': {
      const asset = state.assets.find((item) => item.id === action.id);
      if (!asset || asset.status !== 'review' || !asset.creatorId) return state;
      const campaign = state.campaigns.find((item) => item.id === asset.campaignId);
      const creator = state.creators.find((item) => item.id === asset.creatorId);
      const currentDelivery = state.delivery.find(
        (item) => item.campaignId === asset.campaignId && item.creatorId === asset.creatorId,
      );
      if (!campaign || !creator || !currentDelivery) {
        return {
          ...state,
          assets: state.assets.map((item) =>
            item.id === asset.id ? { ...item, status: 'ready' as const } : item,
          ),
        };
      }
      const published = publishDelivery(currentDelivery);
      const campaigns = state.campaigns.map((item) =>
        item.id === campaign.id
          ? {
              ...item,
              delivering: item.delivering + (currentDelivery.state === 'live' ? 0 : 1),
              spend: Math.min(item.cap, item.spend + 680),
              impressions: item.impressions + published.impressions,
              reach: item.reach + Math.round(published.impressions * 0.78),
              installs: item.installs + Math.max(1, Math.round(published.clicks * 0.22)),
              cpi:
                (item.spend + 680) /
                Math.max(1, item.installs + Math.round(published.clicks * 0.22)),
              roas: Math.max(item.roas, published.roas),
            }
          : item,
      );
      return withLog(
        {
          ...state,
          campaigns,
          delivery: state.delivery.map((item) =>
            item.creatorId === published.creatorId && item.campaignId === published.campaignId
              ? published
              : item,
          ),
          assets: state.assets.map((item) =>
            item.id === asset.id ? { ...item, status: 'ready' as const } : item,
          ),
        },
        campaign.id,
        'Creator post published',
        `${creator.name} is live on ${creator.platforms.join('/').toUpperCase()} · video approved`,
      );
    }

    case 'setDraft': {
      return { ...state, draft: action.draft };
    }

    case 'updateCreator': {
      if (!state.creators.some((creator) => creator.id === action.id)) return state;
      return {
        ...state,
        creators: state.creators.map((creator) =>
          creator.id === action.id ? { ...creator, ...action.patch } : creator,
        ),
      };
    }

    case 'addAsset': {
      return { ...state, assets: [action.asset, ...state.assets] };
    }

    case 'updateAsset': {
      return {
        ...state,
        assets: state.assets.map((a) => (a.id === action.id ? { ...a, ...action.patch } : a)),
      };
    }

    case 'removeAsset': {
      return { ...state, assets: state.assets.filter((a) => a.id !== action.id) };
    }
  }
}

interface StoreValue {
  state: StoreState;
  dispatch: (action: PaAction) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

export function PaStoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  // 恢复只能在 effect 里做：服务端没有 sessionStorage，
  // 直接拿它当 useReducer 的初始值会造成 hydration 不匹配。
  useEffect(() => {
    let email: string | null = null;
    let signedIn = false;
    try {
      email = globalThis.sessionStorage.getItem(SESSION_KEY);
      signedIn = email !== null;
    } catch {
      // 隐私模式下 sessionStorage 可能抛异常。当作未登录处理，不要让整个应用挂掉。
    }
    dispatch({ type: 'hydrate', signedIn, email });
  }, []);

  // 会话变化时同步回 sessionStorage。hydrate 之前不写，否则会把恢复出来的值抹掉。
  useEffect(() => {
    if (!state.hydrated) return;
    try {
      if (state.signedIn) globalThis.sessionStorage.setItem(SESSION_KEY, state.user.email);
      else globalThis.sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // 同上：存不进去不影响本次会话可用。
    }
  }, [state.hydrated, state.signedIn, state.user.email]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function usePaStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('usePaStore 必须在 <PaStoreProvider> 内使用');
  return value;
}
