/**
 * 投放运营人（operator）归属与广告组归一 —— 复刻旧 dashboard/server.js。
 * 纯字符串规则，无副作用；个人面板与 revenue-by-install 共用。
 */

const OPERATOR_CODES = ['syh', 'zm1', 'zme', 'wcx', 'zmf', 'mcy', 'lh', 'ymt', 'wty', 'wvv', 'zjc'];

/**
 * 已撤销的投手代码 —— 不再作为独立投手出现在任何面板/日报中。
 *
 * matchOperator 已把这些代码的 campaign 改判给接手人（cy1→syh），所以【新】快照里不会再
 * 出现这些 operator；但 2026-08-01 之前已定稿的 daily_snapshots(kind='personal') 里仍留有
 * 它们的历史条目（未做数据迁移，历史留档保持原样）。读取侧据此过滤，使前端看不到。
 *
 * 注意：只用于「投手维度」的展示与取数过滤，不能用于产品级合计——投放日报的 PWA 成本按
 * 「该渠道收入 / 该产品全投手总收入」分摊，分母若剔掉这些历史条目会让其余投手分摊虚高。
 */
export const RETIRED_OPERATORS: ReadonlySet<string> = new Set(['cy1']);

/** campaign 含「测」或 test → 测试/创意测试。 */
export function isTestCreative(campaign: string | null | undefined): boolean {
  if (!campaign) return false;
  if (campaign.includes('测')) return true;
  if (campaign.toLowerCase().includes('test')) return true;
  return false;
}

/** 合创（partnership）广告的归属桶名。个人面板对该桶单独按「广告组名→产品」重排展示。 */
export const PARTNERSHIP_OPERATOR = 'partnership';

/** campaign 是否合创广告：名含 partnership（不分大小写）。 */
export function isPartnership(campaign: string | null | undefined): boolean {
  if (!campaign) return false;
  return campaign.toLowerCase().includes('partnership');
}

/**
 * campaign 精准归属白名单：完整 campaign 名（trim 去前后空格后）**大小写敏感全等**命中即定向归属，
 * 优先级高于下方所有规则。仅用于个别 campaign 名无法被通用规则正确归类、需人工钉死归属的情形。
 * 目前：`5.14 AEOc cyl`、`5.30 AEOc value cyl` → 吴天越(wty)；
 * 11 个 Dora And / Doni And 合创（Partnership）campaign → 苏屹恒(syh)。
 */
const CAMPAIGN_OPERATOR_WHITELIST: ReadonlyMap<string, string> = new Map([
  ['5.14 AEOc cyl', 'wty'],
  ['5.30 AEOc value cyl', 'wty'],
  ['Dora And_260807_Partnership Ads_test_AEO', 'syh'],
  ['Dora And_260807_Partnership Ads_test_VO', 'syh'],
  ['Dora And_260717_Partnership Ads_test_VO', 'syh'],
  ['Doni And_260807_Partnership Ads_test_VO', 'syh'],
  ['Doni And_260807_Partnership Ads_test_AEO', 'syh'],
  ['Doni And_260806_Partnership Ads_test_VO', 'syh'],
  ['Doni And_260809_Partnership_VO', 'syh'],
  ['Doni And_260808_Partnership_VO', 'syh'],
  ['Doni And_260809_Partnership_AEO', 'syh'],
  ['Doni And_260808_Partnership_AEO', 'syh'],
  ['Dora And_260809_Partnership_AEO', 'syh'],
]);

/**
 * 从 campaign 名匹配归属桶。优先级：精准白名单 → 投手码/别名 → 测素材(test_creative)；无匹配返回 null。
 *
 * ⚠️ partnership **不参与**此归类：合创广告按其自身投手码/test 正常落入对应桶（投手/test/
 * 未匹配桶因此自然包含各自的 partnership campaign）。合创只作为一个**额外的聚合维度**在个人
 * 面板前端单独合成展示（见 pb-personal 的 buildPartnershipOverlay），不从投手桶抽离，也不改
 * 变 mia / 渠道汇总 / revenue-by-install 的口径。
 *
 * 投手层内部：主代码（含 zme，赵媚儿；在 zm 兜底之前先命中）→ 别名（cy1→syh，陈祎已撤，
 * 存量归 syh；liuh→lh；仅含 zm、不含 zmf → 兜底 zm1）。cy1 必须留成别名、不能只从
 * OPERATOR_CODES 删掉：删掉后含 cy1 的 campaign 会落到 return null 变「未匹配」而非归 syh。
 */
export function matchOperator(campaign: string | null | undefined): string | null {
  if (!campaign) return null;
  // 精准白名单最高优先：仅忽略前后空格，大小写敏感全等，只钉死列出的这几个 campaign。
  const whitelisted = CAMPAIGN_OPERATOR_WHITELIST.get(campaign.trim());
  if (whitelisted) return whitelisted;
  const lower = campaign.toLowerCase();
  for (const code of OPERATOR_CODES) {
    if (lower.includes(code)) return code;
  }
  if (lower.includes('cy1')) return 'syh';
  if (lower.includes('liuh')) return 'lh';
  if (lower.includes('zm') && !lower.includes('zmf')) return 'zm1';
  if (isTestCreative(campaign)) return 'test_creative';
  return null;
}

/**
 * 归一广告组名，使 DB（AF/AD）键与 XMP adset_name 折叠成同一串以便 join。
 * urldecode（+→空格）后剥掉末尾 "(数字)"，再 trim。
 */
export function normAdset(raw: string | null | undefined): string {
  if (raw == null || raw === '') return '';
  let s = raw;
  try {
    s = decodeURIComponent(s.replaceAll('+', ' '));
  } catch {
    s = s.replaceAll('+', ' ');
  }
  s = s.replace(/\s*\(\d+\)\s*$/, '');
  return s.trim();
}

/** 个人面板：付费媒体源集合。 */
/** 运营商代码 → 真实姓名（来自 fs_user 飞书登录信息）。 */
export const OPERATOR_NAMES: Record<string, string> = {
  syh: '苏屹恒',
  zme: '赵媚儿',
  zm1: '未知(仅含zm)',
  zmf: '张梦凡',
  mcy: '马崇岩',
  lh: '刘欢',
  ymt: '杨梅亭',
  wcx: '武春香',
  wty: '吴天越',
  wvv: '王维维',
  zjc: '张嘉铖',
  cy1: '陈祎',
};

/** 将运营商代码解析为真实姓名，未知代码返回原值或 null。 */
export function resolveOperatorName(code: string | null): string | null {
  if (!code || code === 'test_creative') return null;
  return OPERATOR_NAMES[code] ?? code;
}

export const AD_PAID_SOURCES: ReadonlySet<string> = new Set([
  'Facebook+Installs',
  'Facebook Installs',
  'Instagram+Installs',
  'Instagram Installs',
  'Facebook+web',
  'Facebook web',
  'TikTok+SAN',
  'TikTok SAN',
  'Google+Ads+ACI',
  'Google Ads ACI',
]);

/** 个人面板：自然量媒体源集合。 */
export const AD_ORGANIC_SOURCES: ReadonlySet<string> = new Set([
  'Organic',
  'Unattributed',
  'organic',
  'restricted',
  'Untrusted Devices',
]);
