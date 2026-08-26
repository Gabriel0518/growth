/**
 * Partnership ADS 的域类型。
 *
 * ⚠️ 这一层是**后端 DemoOverview 的超集**，不是另起一套模型。
 * 与 `lib/demo/types.ts` 能对上的字段沿用同名（spend / impressions / installs /
 * revenue / roas / creators…），接后端时写一个 DemoOverview → PaData 的映射即可。
 *
 * 标了 `designOnly` 的字段**目前没有后端来源**，接线时会撞上：
 *   - campaign：cap / market / owner / days / channels / schedule
 *   - creator：handle / followers / eng / platforms / tags / avgViews / market
 * 后端的 creator 实体是从 Facebook adset 命名里解析出来的
 * （`lib/demo/partnership.ts` 的 partnershipGroupKey），本来就没有社交档案维度。
 *
 * 这些字段不要在接线阶段被静默填成 0 —— 缺数一律走 `dash()` 显示为 '—'。
 */

/** campaign 生命周期。automating / ready 是自动化阶段，running / stopped 是投放阶段。 */
export type CampaignStatus = 'running' | 'review' | 'draft' | 'stopped' | 'automating' | 'ready';

/** 单条广告的三段状态链（CAMPAIGN-LIVE.md，从 9 态砍到 3 段）。 */
export type DeliveryState = 'live' | 'preparing' | 'paused' | 'rejected';

export type AssetStatus = 'ready' | 'generating' | 'review' | 'failed';

export type PlatformKey = 'ig' | 'tt' | 'yt';

/** Step 2 的优化目标。每个目标都和预算上限一起配置。 */
export type ConversionGoal = 'installs' | 'purchases' | 'signups' | 'leads' | 'roas' | 'cpm';

export interface Product {
  id: string;
  name: string;
  /** 品类。⚠️ KOL 数量估算依赖它，改品类估算就变（CREATE-CAMPAIGN.md）。 */
  category: string;
  objective: string;
  /** public/pa/icons/<icon>.png */
  icon: string;
  store: string;
  platforms: string;
}

export interface Campaign {
  id: string;
  name: string;
  productId: string;
  status: CampaignStatus;
  /** 后端有：来自 campaigns[].creators */
  kols: number;
  /** 新建 campaign 的目标创作者数；存量 mock campaign 没有也可以正常展示。 */
  targetKols?: number;
  spend: number;
  impressions: number;
  installs: number;
  cpi: number;
  roas: number;
  /** 触达人数。刻意低于 impressions —— 同一个人看三条帖是三次曝光但只有一个人。 */
  reach: number;
  delivering: number;
  closed: number;

  /* ---- 以下 designOnly：后端目前给不出 ---- */
  /** 预算上限。后端无此概念，广告平台侧才有。 */
  cap: number;
  market: string;
  owner: string;
  /** 剩余天数。停投后置 null（不是 0 —— 0 会被读成「今天结束」）。 */
  days: number | null;
  channels: PlatformKey[];
  schedule: string;
  /** 本会话内新建的，用于列表高亮。 */
  isNew?: boolean;
}

export interface Creator {
  id: string;
  name: string;
  /* ---- 以下 designOnly：后端只有 name / approved / brand + 指标 ---- */
  handle: string;
  market: string;
  platforms: PlatformKey[];
  tags: string[];
  followers: number;
  /** 互动率百分比。 */
  eng: number;
  /** 每次互动成本。 */
  cpe: number;
  joined: string;
  avgViews: number;
  /** 头像色相。真实头像接入后由 Avatar 的 src 覆盖。 */
  hue: number;
  /** 本地缓存的公开头像，避免首屏依赖第三方图片服务。 */
  avatar?: string;
  /** 本地缓存的公开视频封面，用于 KOL network 的内容预览。 */
  videoCovers?: string[];
  /** 公开社交主页，用于卡片和详情页的跳转。 */
  profileUrl?: string;
  /** 后端有：branded content 授权名单。 */
  authorized: boolean;
}

/** 某个创作者在某个 campaign 上的投放行。 */
export interface Delivery {
  creatorId: string;
  campaignId: string;
  impressions: number;
  clicks: number;
  revenue: number;
  pacing: number;
  roas: number;
  /** 匹配度 0–99。⚠️ 只在 campaign 详情算 —— 那里有品类+目标+预算三个约束；
      KOL Network 是无约束浏览，算了就是编的（CAMPAIGN-LIVE.md）。 */
  fit: number;
  state: DeliveryState;
  views: number;
  cpi: number;
  matchedAt?: number;
  publishedAt?: number;
  closedAt?: number;
}

export interface HistoryEntry {
  creatorId: string;
  campaignId: string;
  when: string;
  live: boolean;
  installs: number;
  roas: number;
}

export interface Asset {
  id: string;
  file: string;
  kind: string;
  ratio: string;
  len: string | null;
  status: AssetStatus;
  /** ai 变体与其源素材共用缩略图色相 —— 换脸只改人脸、场景不变，
      这样卡片上的血缘关系一眼可读（BACKLOG.md）。 */
  origin: 'original' | 'ai';
  creatorId?: string;
  hue: number;
  campaignId: string;
  error?: string;
  perf?: { impressions: number; ctr: number; roas: number; campaigns: number };
  /** Local creator cover used as a believable AI-video thumbnail. */
  cover?: string;
  approvedAt?: number;
  retryCount?: number;
}

export interface LogEntry {
  t: string;
  title: string;
  sub: string;
  campaignId?: string;
}

export interface AdAccount {
  id: string;
  platform: string;
  owner: string;
  connected: string;
  state: 'ok' | 'stale';
}

/** 创建向导在 step 1 → step 2 → review 之间携带的草稿。 */
export interface Draft {
  accountId: string;
  plan: string;
  name: string;
  market: string;
  productId: string;
  schedule: string;
  currency: string;
  cap: number;
  mode: ConversionGoal;
  targetRoas: number;
  targetCpm: number;
  kolTarget: number;
  channels: PlatformKey[];
  days: number;
}

export interface WorkspaceUser {
  name: string;
  role: string;
  initials: string;
  email: string;
}

export interface PaState {
  signedIn: boolean;
  user: WorkspaceUser;
  monthlySpendPct: number;
  lastSync: string;
  audience: number;
  products: Product[];
  campaigns: Campaign[];
  creators: Creator[];
  delivery: Delivery[];
  history: HistoryEntry[];
  assets: Asset[];
  automationLog: LogEntry[];
  adAccounts: AdAccount[];
  draft: Draft | null;
}

/** 全站合计。⚠️ cpi / roas 是**加权混合**不是各 campaign 取平均。 */
export interface Totals {
  spend: number;
  reach: number;
  impressions: number;
  installs: number;
  kols: number;
  revenue: number;
  audience: number;
  cpi: number;
  roas: number;
  count: number;
}
