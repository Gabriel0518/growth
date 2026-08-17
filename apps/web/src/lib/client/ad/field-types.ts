/**
 * channel_extra 字段类型分类 + 展示规则。
 * 通用规则按 JSON value 类型匹配，key 匹配规则优先级更高（后续按需扩展）。
 *
 * 展示模式：
 *   readonly  — 不可编辑文本
 *   text      — 可编辑输入框
 *   select    — 单选下拉（支持搜索）
 *   multi     — 多选下拉（支持搜索）
 */

export type DisplayMode = 'readonly' | 'text' | 'select' | 'multi';

export interface FieldDef {
  key: string;
  value: unknown;
  mode: DisplayMode;
  options: string[] | undefined;
  label: string;
}

// ── 通用规则：按 value 类型 → DisplayMode ──

function classifyByType(_key: string, value: unknown): DisplayMode {
  if (value === null || value === undefined) return 'readonly';
  if (typeof value === 'boolean') return 'select'; // true/false 用选择器
  if (typeof value === 'number') return 'text';
  if (Array.isArray(value)) {
    // 空数组或字符串数组 → multi select
    if (value.length === 0 || typeof value[0] === 'string') return 'multi';
    return 'readonly'; // 对象数组 → 只读
  }
  if (typeof value === 'object') return 'readonly'; // 嵌套对象 → 只读
  return 'text'; // 字符串默认可编辑
}

// ── Key 级别覆盖规则（优先级高于类型规则）──

const READONLY_KEYS = new Set([
  'id',
  'account_id',
  'campaign_id',
  'adset_id',
  'created_time',
  'updated_time',
  'start_time',
  'stop_time',
  'budget_remaining',
  'configured_status',
  'effective_status',
  'issues_info',
  'recommendations',
  'ad_review_feedback',
  'learning_stage_info',
  'failed_delivery_checks',
  'preview_shareable_link',
  'last_updated_by_app_id',
  'source_ad_id',
  'source_adset_id',
  'source_campaign_id',
  'topline_id',
  'rf_prediction_id',
  'demolink_hash',
  'creative',
  'campaign',
  'adset',
  'is_skadnetwork_attribution',
  'has_secondary_skadnetwork_reporting',
  'can_create_brand_lift_study',
  'can_use_spend_cap',
  'is_dynamic_creative',
  'is_incremental_attribution_enabled',
  'promoted_object',
]);

const SELECT_ENUMS: Record<string, string[]> = {
  status: ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'],
  objective: [
    'OUTCOME_AWARENESS',
    'OUTCOME_TRAFFIC',
    'OUTCOME_ENGAGEMENT',
    'OUTCOME_LEADS',
    'OUTCOME_APP_PROMOTION',
    'OUTCOME_SALES',
  ],
  bid_strategy: [
    'LOWEST_COST_WITHOUT_CAP',
    'LOWEST_COST_WITH_BID_CAP',
    'COST_CAP',
    'LOWEST_COST_WITH_MIN_ROAS',
  ],
  billing_event: ['IMPRESSIONS', 'CLICKS', 'LINK_CLICKS', 'APP_INSTALLS', 'THRUPLAY', 'PURCHASE'],
  optimization_goal: [
    'NONE',
    'APP_INSTALLS',
    'IMPRESSIONS',
    'REACH',
    'LINK_CLICKS',
    'CONVERSIONS',
    'VALUE',
    'THRUPLAY',
    'POST_ENGAGEMENT',
    'OFFSITE_CONVERSIONS',
    'AD_RECALL_LIFT',
  ],
  buying_type: ['AUCTION', 'RESERVED'],
  destination_type: ['WEBSITE', 'APP', 'MESSENGER', 'INSTAGRAM_DIRECT', 'WHATSAPP', 'ON_AD', 'ON_POST'],
  smart_promotion_type: ['GUIDED_CREATION', 'SMART_APP_PROMOTION'],
  campaign_attribution: ['SKAN', 'AEM'],
  bid_type: ['CPC', 'CPM', 'MULTI_PREMIUM', 'ABSOLUTE_OCPM', 'CPA'],
  dynamic_ad_voice: ['DYNAMIC', 'STORY_OWNER'],
};

const MULTI_SELECT_KEYS = new Set([
  'pacing_type',
  'special_ad_categories',
]);

// ── 中文标签映射 ──

const LABEL_MAP: Record<string, string> = {
  name: '名称',
  id: 'ID',
  account_id: '广告账户 ID',
  campaign_id: '广告系列 ID',
  adset_id: '广告组 ID',
  status: '状态',
  objective: '营销目标',
  daily_budget: '日预算',
  lifetime_budget: '生命周期预算',
  spend_cap: '花费上限',
  bid_strategy: '出价策略',
  bid_amount: '出价金额',
  billing_event: '计费事件',
  optimization_goal: '优化目标',
  buying_type: '购买类型',
  pacing_type: '投放节奏',
  start_time: '开始时间',
  stop_time: '结束时间',
  created_time: '创建时间',
  updated_time: '更新时间',
  effective_status: '生效状态',
  configured_status: '设定状态',
  budget_remaining: '剩余预算',
  targeting: '定向',
  promoted_object: '推广对象',
  special_ad_categories: '特殊广告类别',
  attribution_spec: '归因窗口',
  destination_type: '跳转类型',
  issues_info: '投放问题',
  recommendations: '优化建议',
  source_campaign_id: '来源 Campaign ID',
  creative: '创意',
  campaign: '广告系列',
  adset: '广告组',
};

/** 将 channel_extra 的每个字段分类为 FieldDef[] */
export function classifyFields(channelExtra: Record<string, unknown>): FieldDef[] {
  if (typeof channelExtra !== 'object') return [];
  return Object.entries(channelExtra).map(([key, value]) => classifyField(key, value));
}

function classifyField(key: string, value: unknown): FieldDef {
  let mode: DisplayMode;

  // 1. Key 级别覆盖
  if (READONLY_KEYS.has(key)) {
    mode = 'readonly';
  } else if (MULTI_SELECT_KEYS.has(key)) {
    mode = 'multi';
  } else if (SELECT_ENUMS[key] === undefined) {
    // 2. 通用类型规则
    mode = classifyByType(key, value);
  } else {
    mode = 'select';
  }

  return {
    key,
    value,
    mode,
    options: SELECT_ENUMS[key],
    label: LABEL_MAP[key] ?? key,
  };
}
