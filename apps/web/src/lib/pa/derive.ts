/**
 * 派生计算。**所有合计一律现算，绝不写死** ——
 * Figma 稿上的 $620,825 / 271,265 installs / 4.65× 都是这里算出来的，
 * 一旦有人发布或暂停 campaign，四个页面的数字会同时跟着变。
 */

import type { Campaign, Creator, Delivery, HistoryEntry, PaState, Product, Totals } from './types';

export function findProduct(products: Product[], id: string): Product | undefined {
  return products.find((p) => p.id === id);
}

export function findCampaign(campaigns: Campaign[], id: string): Campaign | undefined {
  return campaigns.find((c) => c.id === id);
}

export function findCreator(creators: Creator[], id: string): Creator | undefined {
  return creators.find((c) => c.id === id);
}

/**
 * 「在投」只定义这一次。
 * 加这个函数之前，三个页面对「活跃 campaign」给出过三个不同的数字。
 * draft 从未花过钱，stopped 已经不再花钱，两者都不算在投。
 */
export function activeCampaigns(campaigns: Campaign[]): Campaign[] {
  return campaigns.filter((c) => c.status !== 'draft' && c.status !== 'stopped');
}

export function deliveryFor(delivery: Delivery[], campaignId: string): Delivery[] {
  return delivery.filter((d) => d.campaignId === campaignId);
}

export function historyFor(history: HistoryEntry[], creatorId: string): HistoryEntry[] {
  return history.filter((h) => h.creatorId === creatorId);
}

/**
 * 全站合计。
 * ⚠️ cpi 与 roas 是**加权混合**（总消耗 ÷ 总安装、总收入 ÷ 总消耗），
 * 不是把各 campaign 的比值取平均 —— 后者会让小预算 campaign 的极值主导整体，
 * 与广告平台的口径也对不上。
 */
export function totals(state: Pick<PaState, 'campaigns' | 'audience'>): Totals {
  const acc = { spend: 0, reach: 0, impressions: 0, installs: 0, kols: 0, revenue: 0 };
  for (const c of state.campaigns) {
    acc.spend += c.spend;
    acc.reach += c.reach;
    acc.impressions += c.impressions;
    acc.installs += c.installs;
    acc.kols += c.kols;
    acc.revenue += c.spend * c.roas;
  }
  return {
    ...acc,
    audience: state.audience,
    cpi: acc.installs ? acc.spend / acc.installs : 0,
    roas: acc.spend ? acc.revenue / acc.spend : 0,
    count: state.campaigns.length,
  };
}

/**
 * 演示用的确定性时钟。
 * 不用 Date.now()：截图必须可复现，日志里的时间戳才不会每次刷新都变。
 * 每调用一次往前走 7 分钟，从 14:05 起步。
 */
export function makeClock(startMinutes = 14 * 60 + 5): () => string {
  let tick = 0;
  return () => {
    tick += 7;
    const base = startMinutes + tick;
    const h = Math.floor(base / 60) % 24;
    const m = base % 60;
    return `${h < 10 ? '0' : ''}${String(h)}:${m < 10 ? '0' : ''}${String(m)}`;
  };
}
