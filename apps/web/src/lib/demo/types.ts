/**
 * sitin.ai 客户门户（/demo）的对外数据类型 —— 服务端取数与前端渲染共用同一份定义。
 *
 * 单独成文件的原因：取数实现（partnership.ts）里 import 了 @agentic-ug/db 和 FB 客户端，
 * 客户端组件若直接从那里取类型，容易在重构中把值也一起 import 进去、把服务端依赖拖进
 * 浏览器 bundle。类型放这里，两边都只依赖纯声明。
 */

/** 一组基础指标。所有维度（创作者/产品/campaign/素材/趋势）共用同一套字段，便于前端复用渲染。 */
export interface DemoMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  videoViews: number;
  engagements: number;
  installs: number;
  purchases: number;
  revenue: number;
  /** 新用户收入：不在门户展示，仅作 eLTV ROAS 的计算基数（与内部面板同口径）。 */
  newUserRevenue: number;
}

export interface DemoCreatorStat extends DemoMetrics {
  creator: string;
  products: string[];
  slots: string[];
  adsets: number;
  activeAdsets: number;
  ads: number;
  /** 是否仍在 branded content 授权名单里。 */
  approved: boolean;
  brand: string | null;
}

export interface DemoProductSlotCell extends DemoMetrics {
  product: string;
  slot: string;
  campaigns: number;
  adsets: number;
  creators: number;
}

export interface DemoCampaignStat extends DemoMetrics {
  campaign: string;
  product: string;
  slot: string;
  status: string;
  creators: number;
  adsets: number;
}

export interface DemoMaterialStat extends DemoMetrics {
  ad: string;
  creator: string;
  product: string;
  campaign: string;
  adset: string;
}

export interface DemoTrendPoint extends DemoMetrics {
  day: string;
}

export interface DemoPoolCreator {
  creator: string;
  igId: string;
  brand: string;
  /** 区间内是否有实际投放（有广告组且有消耗）。 */
  invested: boolean;
  spend: number;
  revenue: number;
}

export interface DemoSummary extends DemoMetrics {
  /** 总收入 / 消耗。门户口径用总收入，比内部的新用户口径更贴近客户直觉。 */
  roas: number | null;
  /** 新用户收入/消耗 × D180 × ELTV_DISPLAY_FACTOR，按消耗加权。 */
  eltvRoas: number | null;
  ctr: number | null;
  cpm: number | null;
  cpc: number | null;
  cpi: number | null;
  creators: number;
  activeCreators: number;
  products: number;
  campaigns: number;
  adsets: number;
  ads: number;
}

export interface DemoOverview {
  updatedAt: string;
  range: { start: string; end: string };
  summary: DemoSummary;
  trend: DemoTrendPoint[];
  creators: DemoCreatorStat[];
  productSlots: DemoProductSlotCell[];
  campaigns: DemoCampaignStat[];
  materials: DemoMaterialStat[];
  pool: DemoPoolCreator[];
  /** 归不到创作者的收入（iOS SKAN 无广告组名），单列不摊。 */
  unattributedRevenue: number;
  products: string[];
  slots: string[];
  /** 取数过程中的降级说明（某个源失败时前端要能看出来，而不是默默显示 0）。 */
  warnings: string[];
  eltvDisplayFactor: number;
}
