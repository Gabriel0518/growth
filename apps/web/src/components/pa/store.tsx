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
import type { Asset, Campaign, CampaignStatus, Draft, PaState } from '@/lib/pa/types';

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
  | { type: 'setDraft'; draft: Draft | null }
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
      const product = state.products.find((p) => p.id === draft.productId);
      const created: Campaign = {
        id: `CMP-2409-${String(100 + state.campaigns.length)}`,
        name: draft.name,
        market: draft.market,
        productId: draft.productId,
        // 发布后先进自动化阶段：匹配 / 素材 / 建广告都还没跑完。
        status: 'automating',
        owner: state.user.name,
        kols: draft.kolTarget || 40,
        spend: 0,
        cap: draft.cap,
        reach: 0,
        impressions: 0,
        installs: 0,
        cpi: 0,
        roas: 0,
        days: draft.days || 30,
        channels: draft.channels.length > 0 ? draft.channels : ['ig', 'tt'],
        schedule: draft.schedule,
        delivering: 0,
        closed: 0,
        isNew: true,
      };
      return withLog(
        { ...state, campaigns: [created, ...state.campaigns], draft: null },
        created.id,
        'Campaign created',
        `${draft.market} · ${product?.objective ?? 'unknown objective'} · $${draft.cap.toLocaleString('en-US')}`,
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
      }));

      const campaigns = state.campaigns.map((c) =>
        c.id === action.campaignId
          ? { ...c, kols: c.kols + fresh.length, delivering: c.delivering + fresh.length }
          : c,
      );
      return withLog(
        { ...state, campaigns, delivery: [...state.delivery, ...rows] },
        action.campaignId,
        `${String(fresh.length)} creator${fresh.length === 1 ? '' : 's'} added`,
        'matching and creative build queued',
      );
    }

    case 'setDraft': {
      return { ...state, draft: action.draft };
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
