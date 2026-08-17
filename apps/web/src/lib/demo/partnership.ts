/**
 * sitin.ai 客户门户（/demo）合创(partnership)真实数据取数 —— 数据库 + FB 官方 API 双源。
 *
 * 数据分工（不要混用，两边口径不同）：
 *   · 消耗 / 曝光 / 点击 / 视频播放 / 互动 / 安装 / 付费次数 ← **FB Graph Insights 实时**
 *     （与 fb-partnership-autopilot.py 的调价依据同源；不走 XMP，XMP 是 T+1 且有回填延迟）
 *   · 收入（总 / 新用户）                                    ← **PG 月表 records_YYYYMM**
 *   · 创作者授权名单                                          ← **FB branded_content_ad_permissions**
 *   · eLTV D180 倍数                                          ← eltv_cache（getEltvMultipliers）
 *   · FB 凭据                                                 ← ad_fb_token（token-service），代码零凭据
 *
 * 「创作者」这一维度来自广告组名：合创的广告组名是 `{创作者IG用户名} && {YYMMDD}_{序号}`，
 * `&&` 之前那段就是创作者。这与个人面板合创桶的口径是同一份（复用 partnershipGroupKey），
 * 不在此处另立一套。
 *
 * ⚠️ 两路回传取广告组名的方式**不一样**，这是本文件最容易写错的地方：AF 路在 `adset` 列，
 * AD 路（iOS 自有埋点）在 payload JSON 的 `adgroup` 字段里、列是空的。只读列的话 iOS 那一路
 * 收入会整体退化成「无法归因」（实测约占总收入 7%），详见 fetchRevenue 里的注释。
 * 真正归不到组的收入（若有）计入 unattributedRevenue：只进汇总、**不摊进任何创作者**——
 * 摊掉会让每个创作者的 ROAS 系统性虚高，留白反而诚实。
 */

import { query } from '@agentic-ug/db';

import { partnershipGroupKey } from '@/lib/client/pb-personal';
import { getAdAccountConfigs } from '@/lib/dashboard/ad/token-service';
import { getCorrectionFactors } from '@/lib/dashboard/correction-factors';
import type { FactorMap } from '@/lib/dashboard/correction-factors';
import { getTablesForRange, todayBeijing } from '@/lib/dashboard/dates';
import { getEltvMultipliers } from '@/lib/dashboard/eltv';
import { isPartnership, normAdset } from '@/lib/dashboard/operators';
import {
  fetchAdsets,
  fetchApprovedCreators,
  fetchCampaigns,
  fetchInsights,
} from '@/lib/demo/fb-client';
import type { FbInsightRow } from '@/lib/demo/fb-client';
import type {
  DemoCampaignStat,
  DemoCreatorStat,
  DemoMaterialStat,
  DemoMetrics,
  DemoOverview,
  DemoPoolCreator,
  DemoProductSlotCell,
  DemoSummary,
  DemoTrendPoint,
} from '@/lib/demo/types';

/** 门户默认看多少天。14 天既能看出趋势，又不至于让 insights 翻页太久。 */
export const DEMO_RANGE_DAYS = 14;

/**
 * 合创品牌方（sponsor）IG 账号 —— 与 scripts/fb-partnership-build.py 的 BRANDS 同一份，
 * 改这里不会影响投放脚本，两边都改才算改全。
 */
const BRAND_IG = [
  { key: 'sitin', label: 'sitin.ai_official', igId: '17841449380711493' },
  { key: 'sophie', label: 'sophieamae.312', igId: '17841401243003177' },
] as const;

/**
 * 【展示口径】eLTV ROAS 对客户展示时统一再乘的系数（屹恒 2026-08-14 定）。
 * 内部面板的 eLTV ROAS = **修正后**新用户收入/消耗 × D180 倍数，是 D180 口径；门户按更长的
 * 回收周期对客户口径展示，故在此再乘 1.5。此系数与修正系数是两码事：修正系数把回传低报的
 * 收入校准回真实值（在收入取数处已乘），本系数只做 D180→更长周期的展示折算。
 * **只作用于门户展示，不回写任何内部计算**。要调口径改这一个常量即可，UI 说明也引用它。
 */
export const ELTV_DISPLAY_FACTOR = 1.5;

/**
 * 【展示口径】门户对客户展示的**收入统一上调系数**（屹恒定）。在「修正系数校准到真实口径」
 * 之上，所有收入（总收入 / 新用户收入 / 趋势 / 创作者·产品·素材各维度）再乘此系数；ROAS 与
 * eLTV ROAS 因分子是收入，也随之等比抬升。**只作用于门户展示，不回写任何内部计算**，改口径
 * 改这一个常量即可。
 */
export const REVENUE_DISPLAY_FACTOR = 1.2;

/**
 * campaign 名里的产品段 → eltv_cache / 修正系数的产品键（两边命名历史上就不一致，只能显式对表）。
 * eLTV 与修正系数两套映射目标产品名一致（都是 core 里的规范名），故共用这一份。
 */
const ELTV_PRODUCT_ALIAS: Record<string, string> = {
  'Doni And': 'Doni',
  'Luma iOS': 'Luma',
  'Gracechat iOS': 'GraceChat',
};

/**
 * 修正系数（回传收入 → 后端真实收入）在 FB 渠道的标量。合创只在 FB 投，故固定取 FB 分量。
 * factor = 某北京自然日 athena 真实收入 / 同日付费渠道回传收入（见 core/correction.ts），
 * 一般 > 1（SKAN/S2S 低报）。产品名先过 alias 对齐 core 规范名，取不到按 1（不修正）。
 */
function fbCorrectionFactor(factors: FactorMap, product: string): number {
  const f = factors[ELTV_PRODUCT_ALIAS[product] ?? product];
  if (f === undefined) return 1;
  return typeof f === 'number' ? f : f.fb;
}

/** 修正系数取数日：当天数据未定稿，用昨天的系数兜底（与内部 campaign-context 同一规则）。 */
function correctionDate(day: string, today: string): string {
  return day >= today ? shiftDay(today, -1) : day;
}

/** FB insights actions 里我们关心的 action_type（其余几十种忽略）。 */
const ACT_INSTALL = 'mobile_app_install';
const ACT_ACTIVATE = 'omni_activate_app';
const ACT_PURCHASE = 'purchase';
const ACT_REGISTER = 'complete_registration';
const ACT_VIDEO_VIEW = 'video_view';
const ACT_ENGAGEMENT = 'post_engagement';

// ─────────────────────────── 小工具 ───────────────────────────

function emptyMetrics(): DemoMetrics {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    videoViews: 0,
    engagements: 0,
    installs: 0,
    purchases: 0,
    revenue: 0,
    newUserRevenue: 0,
  };
}

function addMetrics(target: DemoMetrics, src: DemoMetrics): void {
  target.spend += src.spend;
  target.impressions += src.impressions;
  target.clicks += src.clicks;
  target.videoViews += src.videoViews;
  target.engagements += src.engagements;
  target.installs += src.installs;
  target.purchases += src.purchases;
  target.revenue += src.revenue;
  target.newUserRevenue += src.newUserRevenue;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundMetrics(m: DemoMetrics): void {
  m.spend = round2(m.spend);
  m.revenue = round2(m.revenue);
  m.newUserRevenue = round2(m.newUserRevenue);
}

/** 从 insights 的 actions 数组里取某个 action_type 的数值，缺失按 0。 */
function actionValue(row: FbInsightRow, type: string): number {
  const hit = (row.actions ?? []).find((a) => a.action_type === type);
  return hit === undefined ? 0 : Number(hit.value);
}

/** insights 行 → 指标（收入留 0，收入只从库里来）。 */
function metricsFromInsight(row: FbInsightRow): DemoMetrics {
  return {
    spend: Number(row.spend ?? 0),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    videoViews: actionValue(row, ACT_VIDEO_VIEW),
    engagements: actionValue(row, ACT_ENGAGEMENT),
    // 安装取 mobile_app_install；AEO 系列优化的是「激活」，安装为 0 时用激活兜底，
    // 否则 AEO 档在门户里会显示成一个装机量都没有。
    installs: actionValue(row, ACT_INSTALL) || actionValue(row, ACT_ACTIVATE),
    purchases: actionValue(row, ACT_PURCHASE) || actionValue(row, ACT_REGISTER),
    revenue: 0,
    newUserRevenue: 0,
  };
}

/**
 * campaign 名 → 产品段。合创命名一律是 `{产品}_...`（`Dora And_260807_Partnership Ads_test_AEO`、
 * `Luma iOS_Partnership_VO_2_syh`），取第一个下划线之前那段即产品。
 */
export function productOfCampaign(campaign: string): string {
  const i = campaign.indexOf('_');
  return (i === -1 ? campaign : campaign.slice(0, i)).trim();
}

/**
 * campaign 名 → 投放档位。门户口径**只分 AEO 与 VO 两档**（屹恒定）：VO_1 / VO_2 / VO_Post 等
 * 一切价值优化变体全部并入 `VO`，识别不出的历史命名归 `其他`（产品×档位矩阵里会被忽略）。
 * 当前 18 条固定 campaign 是 `{产品}_Partnership_{AEO|VO_1|VO_2}_syh`；2026-08-10 之前的历史
 * 命名结尾是 `_AEO`/`_VO`/`_VO_Post`，一并识别。
 */
export function slotOfCampaign(campaign: string): string {
  const m = /_(AEO|VO_1|VO_2|VO)(?:_syh)?(?:_Post)?\s*$/i.exec(campaign.trim());
  if (m === null) return '其他';
  return (m[1] ?? '').toUpperCase().startsWith('VO') ? 'VO' : 'AEO';
}

/** 门户产品×档位矩阵只认这两档，顺序固定（AEO 在前）。其余（含「其他」）不进矩阵。 */
export const DEMO_SLOTS = ['AEO', 'VO'] as const;

/**
 * 授权口径：门户只展示**正常已授权**的创作者，忽略 SS / ZP / Max / 素人 开头的历史内部代号
 * （这些广告组名不是创作者 IG 号，是早期占位命名）。这里只判命名，是否在品牌授权名单里由
 * 调用处结合 approved 再收一道。CJK 无词边界，故 `素人` 用前缀匹配。
 */
export function isRealCreatorName(name: string): boolean {
  const s = name.trim();
  if (s === '') return false;
  if (s.startsWith('素人')) return false;
  return !/^(SS|ZP|Max)(?:[\s_\d]|$)/i.test(s);
}

/** 日期偏移，返回 YYYY-MM-DD（纯 epoch 计算，与服务器时区无关）。 */
function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 门户可查的最长区间（天）。区间越长 FB insights 翻页越久，92 天（约一季度）够客户复盘。 */
export const DEMO_MAX_RANGE_DAYS = 92;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DemoRange {
  start: string;
  end: string;
}

/** 含首尾的天数（'08-01'→'08-14' 记 14 天）。 */
function dayCount(start: string, end: string): number {
  return (
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/**
 * 归一并校验前端传入的区间：默认「今天往前 14 天」；start>end 自动对调；越界（未来 / 超长）
 * 收敛到合法范围。非法日期串一律回退默认，绝不把脏输入拼进 SQL。
 */
export function resolveRange(raw?: Partial<DemoRange>): DemoRange {
  const today = todayBeijing();
  const validEnd = raw?.end !== undefined && YMD_RE.test(raw.end) ? raw.end : undefined;
  const validStart = raw?.start !== undefined && YMD_RE.test(raw.start) ? raw.start : undefined;
  if (validStart === undefined || validEnd === undefined) {
    return { start: shiftDay(today, -(DEMO_RANGE_DAYS - 1)), end: today };
  }
  let start = validStart;
  let end = validEnd;
  if (Date.parse(start) > Date.parse(end)) [start, end] = [end, start];
  if (Date.parse(end) > Date.parse(today)) end = today; // 不查未来
  if (dayCount(start, end) > DEMO_MAX_RANGE_DAYS) start = shiftDay(end, -(DEMO_MAX_RANGE_DAYS - 1));
  return { start, end };
}

/**
 * 复合 Map 键的分隔符。**不能用空格或常见符号**：产品名带空格（`Dora And`）、广告组名带
 * ` && `（`victoria_meadows420 && 260811_1`），用它们拼键再拆会把名字拦腰截断。
 * 这些名字来自 FB 侧，不可能含 NUL。
 */
const SEP = '\u0000';

// ─────────────────────────── 收入（PG 月表）───────────────────────────

interface RevenueRow {
  campaign: string | null;
  adset: string | null;
  day: string | null;
  revenue: number | null;
  new_revenue: number | null;
}

/** epoch 秒 → 北京自然日 YYYY-MM-DD（纯偏移计算，与服务器时区无关）。 */
function beijingDayOfEpoch(ts: number): string {
  return new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

/** 宽松解析回传 payload：非法 JSON / 非对象一律当空对象，绝不因一条脏数据让整批收入丢失。 */
function parsePayload(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 区间内合创收入，按 (campaign, adset, 北京日) 聚合。
 *
 * 两路回传的时间列格式不同，**必须分开写 SQL**（照抄任一边都会漏掉另一路的全部收入）：
 *   · AF 路（source='Facebook Ads'）：event_time/install_time 是 UTC 文本 'YYYY-MM-DD HH:MI:SS.mmm'
 *   · AD 路（自有埋点）             ：event_time/install_time 是 **epoch 秒的字符串**
 * 收入事件只认 af_purchase / ad_purchase —— 库里还有 af_purchase_coins_200 之类的细分事件，
 * 它们与 af_purchase 重复计账，加进来收入会翻倍（与内部面板同一口径，勿改）。
 *
 * 新用户判定与个人面板一致：安装日（北京）== 事件日（北京）且事件在安装后 0~24h 内。
 */
async function fetchRevenue(startDate: string, endDate: string): Promise<RevenueRow[]> {
  const tables = getTablesForRange(startDate, endDate);
  // 北京日 [start 00:00, end+1 00:00) 的 UTC 边界。
  const loMs = Date.parse(`${startDate}T00:00:00+08:00`);
  const hiMs = Date.parse(`${endDate}T00:00:00+08:00`) + 86_400_000;
  const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const strLo = fmt(loMs);
  const strHi = fmt(hiMs);
  const epLo = Math.floor(loMs / 1000);
  const epHi = Math.floor(hiMs / 1000);

  const rows: RevenueRow[] = [];
  for (const table of tables) {
    // AF 路：文本时间，直接 ::timestamp 转换（PG 认这个格式）。
    const af = await query<RevenueRow>(
      `SELECT campaign,
              adset,
              to_char(event_time::timestamp + interval '8 hours', 'YYYY-MM-DD') AS day,
              SUM(COALESCE(revenue, 0))::float8 AS revenue,
              SUM(CASE
                    WHEN install_time IS NOT NULL
                     AND (install_time::timestamp + interval '8 hours')::date
                       = (event_time::timestamp + interval '8 hours')::date
                     AND event_time::timestamp >= install_time::timestamp
                     AND event_time::timestamp < install_time::timestamp + interval '24 hours'
                    THEN COALESCE(revenue, 0) ELSE 0
                  END)::float8 AS new_revenue
         FROM ${table}
        WHERE event_name = 'af_purchase'
          AND campaign ILIKE '%partnership%'
          AND event_time >= $1 AND event_time < $2
        GROUP BY 1, 2, 3`,
      [strLo, strHi],
    );
    rows.push(...af);

    // AD 路（自有埋点）：⚠️ **广告组名不在 adset 列里，而在 payload JSON 的 `adgroup` 字段**
    // （列里是空串），campaign 同样以 payload 里那份为准。两者都是 URL 编码且带 ` (id)` 后缀，
    // 由外层的 normAdset 统一解码归一。照抄 AF 路直接读列，会让 iOS 这一路的收入全部退化成
    // 「无法归因到创作者」——本项目踩过这个坑，勿改回去（口径与 personal.ts 的 adAdgroup 一致）。
    // 行数很小（14 天百余行），故拉明细在 JS 侧解析聚合，不在 SQL 里解 JSON（payload 可能非法，
    // ::jsonb 会让整条查询报错）。
    const adDetail = await query<{
      payload: string | null;
      revenue: number | null;
      event_time: string | null;
      install_time: string | null;
    }>(
      `SELECT payload, revenue, event_time, install_time
         FROM ${table}
        WHERE event_name = 'ad_purchase'
          AND campaign ILIKE '%partnership%'
          AND event_time ~ '^[0-9]+$'
          AND event_time::bigint >= $1 AND event_time::bigint < $2`,
      [epLo, epHi],
    );
    const adAgg = new Map<string, RevenueRow>();
    for (const r of adDetail) {
      const p = parsePayload(r.payload);
      const eventTs = Number.parseInt(r.event_time ?? '', 10);
      if (Number.isNaN(eventTs)) continue;
      const installTs = Number.parseInt(r.install_time ?? '', 10);
      const day = beijingDayOfEpoch(eventTs);
      const isNew =
        !Number.isNaN(installTs) &&
        beijingDayOfEpoch(installTs) === day &&
        eventTs >= installTs &&
        eventTs - installTs < 86_400;
      const campaign = typeof p['campaign'] === 'string' ? p['campaign'] : '';
      const adset = typeof p['adgroup'] === 'string' ? p['adgroup'] : '';
      const revenue = r.revenue ?? 0;
      const key = `${campaign}${SEP}${adset}${SEP}${day}`;
      const hit = adAgg.get(key);
      if (hit === undefined) {
        adAgg.set(key, { campaign, adset, day, revenue, new_revenue: isNew ? revenue : 0 });
      } else {
        hit.revenue = (hit.revenue ?? 0) + revenue;
        hit.new_revenue = (hit.new_revenue ?? 0) + (isNew ? revenue : 0);
      }
    }
    rows.push(...adAgg.values());
  }
  return rows;
}

// ─────────────────────────── 主流程 ───────────────────────────

interface AccountTask {
  accountId: string;
  token: string;
}

/**
 * 哪些广告账户在跑合创：从本地 ad_campaign 表反查（只有建过合创 campaign 的账户才需要拉
 * insights）。这样将来新增合创账户会自动纳入，不必改代码；账户没有对应 token 则跳过并告警。
 */
async function resolveAccounts(): Promise<{ tasks: AccountTask[]; warnings: string[] }> {
  const rows = await query<{ channel_account_id: string | null }>(
    `SELECT DISTINCT channel_account_id
       FROM ad_campaign
      WHERE name ILIKE '%partnership%' AND channel_account_id IS NOT NULL`,
  );
  const configs = await getAdAccountConfigs();
  const tasks: AccountTask[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    const accountId = row.channel_account_id;
    if (accountId === null || accountId === '') continue;
    const cfg = configs.find((c) => c.accountId === accountId);
    if (cfg === undefined) {
      warnings.push(`广告账户 ${accountId} 在 ad_fb_token 里没有可用凭据，已跳过`);
      continue;
    }
    tasks.push({ accountId, token: cfg.token });
  }
  return { tasks, warnings };
}

interface AdsetMeta {
  creator: string;
  campaign: string;
  product: string;
  slot: string;
  active: boolean;
}

/**
 * 拉取并聚合全部合创数据。**耗时接口**（数十次 FB 调用），务必经 cache.ts 的小时级缓存调用，
 * 不要让它挂在每个页面请求上。
 */
export async function buildPartnershipOverview(range?: Partial<DemoRange>): Promise<DemoOverview> {
  const { start: startDate, end: endDate } = resolveRange(range);
  const rangeDays = dayCount(startDate, endDate);
  const warnings: string[] = [];

  const { tasks, warnings: acctWarnings } = await resolveAccounts();
  warnings.push(...acctWarnings);

  // ── FB 侧：结构 + 三个粒度的 insights ──
  const adsetInsights: FbInsightRow[] = [];
  const adInsights: FbInsightRow[] = [];
  const dailyInsights: FbInsightRow[] = [];
  const adsetActive = new Map<string, boolean>();
  const campaignStatus = new Map<string, string>();

  for (const task of tasks) {
    try {
      const [adsets, campaigns, byAdset, byAd, byDay] = await Promise.all([
        fetchAdsets(task.token, task.accountId),
        fetchCampaigns(task.token, task.accountId),
        fetchInsights(task.token, task.accountId, 'adset', startDate, endDate),
        fetchInsights(task.token, task.accountId, 'ad', startDate, endDate),
        fetchInsights(task.token, task.accountId, 'campaign', startDate, endDate, true),
      ]);
      for (const a of adsets) adsetActive.set(a.id, (a.effective_status ?? a.status) === 'ACTIVE');
      for (const c of campaigns) {
        if (isPartnership(c.name)) campaignStatus.set(c.name, c.effective_status ?? c.status ?? '');
      }
      adsetInsights.push(...byAdset.filter((r) => isPartnership(r.campaign_name)));
      adInsights.push(...byAd.filter((r) => isPartnership(r.campaign_name)));
      dailyInsights.push(...byDay.filter((r) => isPartnership(r.campaign_name)));
    } catch (error) {
      warnings.push(`广告账户 ${task.accountId} 取 FB 数据失败：${(error as Error).message}`);
    }
  }

  // ── 库侧：收入 ──
  let revenueRows: RevenueRow[] = [];
  try {
    revenueRows = await fetchRevenue(startDate, endDate);
  } catch (error) {
    warnings.push(`收入查询失败：${(error as Error).message}`);
  }

  // ── 修正系数：回传收入被 SKAN/S2S 系统性低报，须按「athena 真实 / 回传」的修正系数校准到
  // 真实口径（与内部面板同源 getCorrectionFactors，合创统一按 FB 渠道取，当天用昨天系数兜底）。
  // 按天×产品预取一次；某天取不到就按不修正（cf=1）并告警，不因一日缺系数让整批收入丢失。
  const today = todayBeijing();
  const factorsByDate = new Map<string, FactorMap>();
  const neededCfDates = new Set<string>();
  for (const row of revenueRows) {
    if (row.day !== null && row.day !== '') neededCfDates.add(correctionDate(row.day, today));
  }
  for (const cfDate of neededCfDates) {
    try {
      factorsByDate.set(cfDate, await getCorrectionFactors(cfDate));
    } catch (error) {
      factorsByDate.set(cfDate, {});
      warnings.push(
        `修正系数取用失败（${cfDate}），该日收入按未修正处理：${(error as Error).message}`,
      );
    }
  }

  // 收入按 (归一 campaign, 归一 adset) 归位。库里的 campaign/adset 可能是 URL 编码、并带
  // ` (campaign_id)` 后缀（AF 侧 iOS 回传的老毛病），normAdset 一次性解码 + 剥后缀，
  // 解完就能和 FB 侧的名字对上。
  // value 里带上归一后的 campaign/adset 名：贴不上 FB 行时要靠它补出广告组，
  // 从复合键反向 split 太脆（名字里本来就有空格和 &&）。
  const revByAdset = new Map<
    string,
    { campaign: string; adset: string; revenue: number; newUserRevenue: number }
  >();
  const revByDay = new Map<string, { revenue: number; newUserRevenue: number }>();
  let unattributedRevenue = 0;
  for (const row of revenueRows) {
    const campaign = normAdset(row.campaign);
    const adset = normAdset(row.adset);
    const day = row.day ?? '';
    // 每笔收入先乘「当天×该产品」的修正系数校准到真实口径，再乘门户展示上调系数；之后所有
    // 维度（汇总/趋势/创作者/产品/eLTV 基数）都带这两层。
    const cf = fbCorrectionFactor(
      factorsByDate.get(correctionDate(day, today)) ?? {},
      productOfCampaign(campaign),
    );
    const revenue = (row.revenue ?? 0) * cf * REVENUE_DISPLAY_FACTOR;
    const newUserRevenue = (row.new_revenue ?? 0) * cf * REVENUE_DISPLAY_FACTOR;
    if (day !== '') {
      const d = revByDay.get(day) ?? { revenue: 0, newUserRevenue: 0 };
      d.revenue += revenue;
      d.newUserRevenue += newUserRevenue;
      revByDay.set(day, d);
    }
    if (adset === '') {
      // SKAN 回传没有广告组名 → 归不到创作者，单列，不摊。
      unattributedRevenue += revenue;
      continue;
    }
    const key = `${campaign}${SEP}${adset}`;
    const e = revByAdset.get(key) ?? { campaign, adset, revenue: 0, newUserRevenue: 0 };
    e.revenue += revenue;
    e.newUserRevenue += newUserRevenue;
    revByAdset.set(key, e);
  }

  // ── 广告组级：把 FB 消耗与库里收入合到一起，这是所有维度的共同底座 ──
  const adsetMeta = new Map<string, AdsetMeta>();
  const adsetMetrics = new Map<string, DemoMetrics>();

  // 第一遍：只聚合 FB 侧投放指标。**join key 两边都过 normAdset**——库里的名字可能是 URL
  // 编码并带 ` (campaign_id)` 后缀，FB 侧偶尔带复制产生的 ` (1)`，只有都归一才对得上；
  // 展示仍用 FB 原始名。收入放到第二遍统一贴，避免同 key 多行时把收入重复累加。
  for (const row of adsetInsights) {
    const campaignRaw = (row.campaign_name ?? '').trim();
    const adsetRaw = (row.adset_name ?? '').trim();
    if (campaignRaw === '' || adsetRaw === '') continue;
    const key = `${normAdset(campaignRaw)}${SEP}${normAdset(adsetRaw)}`;
    const prev = adsetMetrics.get(key);
    if (prev === undefined) adsetMetrics.set(key, metricsFromInsight(row));
    else addMetrics(prev, metricsFromInsight(row));
    adsetMeta.set(key, {
      creator: partnershipGroupKey(adsetRaw),
      campaign: campaignRaw,
      product: productOfCampaign(campaignRaw),
      slot: slotOfCampaign(campaignRaw),
      active: adsetActive.get(row.adset_id ?? '') ?? false,
    });
  }

  // 第二遍：贴收入。贴不上的（广告组已删、或在区间之外建的）补一条零消耗行——那笔钱是真
  // 收到的，丢掉会让门户的收入合计小于事实。
  for (const [key, rev] of revByAdset) {
    const existing = adsetMetrics.get(key);
    if (existing !== undefined) {
      existing.revenue += rev.revenue;
      existing.newUserRevenue += rev.newUserRevenue;
      continue;
    }
    const m = emptyMetrics();
    m.revenue = rev.revenue;
    m.newUserRevenue = rev.newUserRevenue;
    adsetMetrics.set(key, m);
    adsetMeta.set(key, {
      creator: partnershipGroupKey(rev.adset),
      campaign: rev.campaign,
      product: productOfCampaign(rev.campaign),
      slot: slotOfCampaign(rev.campaign),
      active: false,
    });
  }

  // ── eLTV 倍数（按产品，渠道固定 FB：合创只在 FB 投）──
  let eltvByProduct: Record<string, number> = {};
  try {
    const entry = await getEltvMultipliers(endDate);
    const out: Record<string, number> = {};
    for (const meta of adsetMeta.values()) {
      if (meta.product in out) continue;
      const eltvKey = ELTV_PRODUCT_ALIAS[meta.product] ?? meta.product;
      const perProduct = entry.multipliers[eltvKey];
      const fb = perProduct?.['FB'];
      if (fb !== undefined && fb.d180 !== null) out[meta.product] = fb.d180;
    }
    eltvByProduct = out;
  } catch (error) {
    warnings.push(`eLTV 倍数取用失败，长期回报按不可得处理：${(error as Error).message}`);
  }

  // ── 聚合各维度 ──
  const creatorAgg = new Map<
    string,
    {
      metrics: DemoMetrics;
      products: Set<string>;
      slots: Set<string>;
      adsets: number;
      activeAdsets: number;
    }
  >();
  const cellAgg = new Map<
    string,
    { metrics: DemoMetrics; campaigns: Set<string>; adsets: number; creators: Set<string> }
  >();
  const campAgg = new Map<
    string,
    { metrics: DemoMetrics; creators: Set<string>; adsets: number; product: string; slot: string }
  >();
  const total = emptyMetrics();
  // eLTV 按消耗加权（与内部面板一致：不能对各产品的 eLTV ROAS 直接取算术平均）。
  let eltvWeightedSum = 0;
  let eltvWeightedCost = 0;

  for (const [key, metrics] of adsetMetrics) {
    const meta = adsetMeta.get(key);
    if (meta === undefined) continue;
    addMetrics(total, metrics);

    const mult = eltvByProduct[meta.product];
    if (mult !== undefined && metrics.spend > 0) {
      eltvWeightedSum += (metrics.newUserRevenue / metrics.spend) * mult * metrics.spend;
      eltvWeightedCost += metrics.spend;
    }

    const c = creatorAgg.get(meta.creator) ?? {
      metrics: emptyMetrics(),
      products: new Set<string>(),
      slots: new Set<string>(),
      adsets: 0,
      activeAdsets: 0,
    };
    addMetrics(c.metrics, metrics);
    c.products.add(meta.product);
    c.slots.add(meta.slot);
    c.adsets += 1;
    if (meta.active) c.activeAdsets += 1;
    creatorAgg.set(meta.creator, c);

    const cellKey = `${meta.product}${SEP}${meta.slot}`;
    const cell = cellAgg.get(cellKey) ?? {
      metrics: emptyMetrics(),
      campaigns: new Set<string>(),
      adsets: 0,
      creators: new Set<string>(),
    };
    addMetrics(cell.metrics, metrics);
    cell.campaigns.add(meta.campaign);
    cell.adsets += 1;
    cell.creators.add(meta.creator);
    cellAgg.set(cellKey, cell);

    const camp = campAgg.get(meta.campaign) ?? {
      metrics: emptyMetrics(),
      creators: new Set<string>(),
      adsets: 0,
      product: meta.product,
      slot: meta.slot,
    };
    addMetrics(camp.metrics, metrics);
    camp.creators.add(meta.creator);
    camp.adsets += 1;
    campAgg.set(meta.campaign, camp);
  }

  // ── 素材级：ad 粒度的消耗直接来自 FB；收入无法拆到素材（回传只到广告组），故留 0 ──
  const materialAgg = new Map<string, DemoMaterialStat>();
  for (const row of adInsights) {
    const campaign = (row.campaign_name ?? '').trim();
    const adset = (row.adset_name ?? '').trim();
    const ad = (row.ad_name ?? '').trim();
    if (campaign === '' || ad === '') continue;
    const key = `${campaign}${SEP}${adset}${SEP}${ad}`;
    const existing = materialAgg.get(key);
    const m = metricsFromInsight(row);
    if (existing === undefined) {
      materialAgg.set(key, {
        ...m,
        ad,
        creator: partnershipGroupKey(adset),
        product: productOfCampaign(campaign),
        campaign,
        adset,
      });
    } else {
      addMetrics(existing, m);
    }
  }

  // ── 逐日趋势：消耗等来自 FB（campaign 级逐日），收入来自库（已按北京日聚合）──
  const trendMap = new Map<string, DemoMetrics>();
  for (const row of dailyInsights) {
    const day = row.date_start ?? '';
    if (day === '') continue;
    const t = trendMap.get(day) ?? emptyMetrics();
    addMetrics(t, metricsFromInsight(row));
    trendMap.set(day, t);
  }
  const trend: DemoTrendPoint[] = [];
  for (let i = 0; i < rangeDays; i++) {
    const day = shiftDay(startDate, i);
    const m = trendMap.get(day) ?? emptyMetrics();
    const rev = revByDay.get(day);
    if (rev !== undefined) {
      m.revenue = rev.revenue;
      m.newUserRevenue = rev.newUserRevenue;
    }
    roundMetrics(m);
    trend.push({ ...m, day });
  }

  // ── 创作者授权池 ──
  const pool: DemoPoolCreator[] = [];
  const approvedBrand = new Map<string, string>();
  const poolToken = tasks[0]?.token;
  if (poolToken !== undefined) {
    for (const brand of BRAND_IG) {
      try {
        const approved = await fetchApprovedCreators(poolToken, brand.igId);
        for (const p of approved) {
          const name = (p.creator_username ?? '').trim();
          if (name === '') continue;
          approvedBrand.set(name, brand.label);
          const stat = creatorAgg.get(name);
          pool.push({
            creator: name,
            igId: p.creator_ig_id ?? '',
            brand: brand.label,
            invested: stat !== undefined && stat.metrics.spend > 0,
            spend: round2(stat?.metrics.spend ?? 0),
            revenue: round2(stat?.metrics.revenue ?? 0),
          });
        }
      } catch (error) {
        warnings.push(`创作者授权名单（${brand.label}）拉取失败：${(error as Error).message}`);
      }
    }
  }
  pool.sort((a, b) => b.spend - a.spend || a.creator.localeCompare(b.creator));

  // ── 授权过滤 ──
  // 门户只对客户展示「正常已授权」的创作者：忽略 SS / ZP / Max / 素人 开头的历史内部代号，
  // 且要在品牌 branded content 授权名单里。若名单没取到（approvedBrand 为空，通常是 FB 拉取
  // 失败并已进 warnings），退化为只按命名过滤，避免整页创作者被清空。
  const strictAuth = approvedBrand.size > 0;
  const isAuthorized = (name: string): boolean =>
    isRealCreatorName(name) && (!strictAuth || approvedBrand.has(name));

  // ── 落成对外结构 ──
  const creators: DemoCreatorStat[] = [...creatorAgg]
    .filter(([creator]) => isAuthorized(creator))
    .map(([creator, v]) => {
      roundMetrics(v.metrics);
      return {
        ...v.metrics,
        creator,
        products: [...v.products].sort(),
        slots: [...v.slots].sort(),
        adsets: v.adsets,
        activeAdsets: v.activeAdsets,
        ads: [...materialAgg.values()].filter((m) => m.creator === creator).length,
        approved: approvedBrand.has(creator),
        brand: approvedBrand.get(creator) ?? null,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  const productSlots: DemoProductSlotCell[] = [...cellAgg]
    .map(([key, v]) => {
      roundMetrics(v.metrics);
      const parts = key.split(SEP);
      return {
        ...v.metrics,
        product: parts[0] ?? '',
        slot: parts[1] ?? '',
        campaigns: v.campaigns.size,
        adsets: v.adsets,
        creators: v.creators.size,
      };
    })
    // 门户只保留 AEO / VO 两档，历史命名归入的「其他」不进矩阵（屹恒定）。
    .filter((c) => c.slot === 'AEO' || c.slot === 'VO')
    .sort((a, b) => b.spend - a.spend);

  const campaigns: DemoCampaignStat[] = [...campAgg]
    .map(([campaign, v]) => {
      roundMetrics(v.metrics);
      return {
        ...v.metrics,
        campaign,
        product: v.product,
        slot: v.slot,
        status: campaignStatus.get(campaign) ?? 'UNKNOWN',
        creators: v.creators.size,
        adsets: v.adsets,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  // 素材同样只留授权创作者的：识别到广告组归属的是非授权创作者，连同它下面的素材一并忽略。
  const materials: DemoMaterialStat[] = [...materialAgg.values()]
    .filter((m) => isAuthorized(m.creator))
    .map((m) => {
      roundMetrics(m);
      return m;
    })
    .sort((a, b) => b.spend - a.spend);

  // 未归因收入（iOS SKAN 拿不到广告组名）计入**汇总**总收入：那是真实收到的钱，只是落不到
  // 具体创作者头上。因此「各维度明细相加 < 顶部汇总」是预期行为，页脚对客户有明确说明。
  // eLTV 的分子（新用户收入）有意不含这部分——归不到组就取不到对应产品的倍数，宁可低估。
  total.revenue += unattributedRevenue;
  roundMetrics(total);
  // 产品清单取自 AEO/VO 矩阵（与产品×档位表对齐），档位固定 AEO→VO。
  const productSet = new Set(productSlots.map((c) => c.product));
  const slotSet = new Set(productSlots.map((c) => c.slot));
  const summary: DemoSummary = {
    ...total,
    roas: total.spend > 0 ? total.revenue / total.spend : null,
    eltvRoas:
      eltvWeightedCost > 0 ? (eltvWeightedSum / eltvWeightedCost) * ELTV_DISPLAY_FACTOR : null,
    ctr: total.impressions > 0 ? total.clicks / total.impressions : null,
    cpm: total.impressions > 0 ? (total.spend / total.impressions) * 1000 : null,
    cpc: total.clicks > 0 ? total.spend / total.clicks : null,
    cpi: total.installs > 0 ? total.spend / total.installs : null,
    creators: creators.length,
    activeCreators: creators.filter((c) => c.activeAdsets > 0).length,
    products: productSet.size,
    campaigns: campaigns.length,
    adsets: adsetMetrics.size,
    ads: materials.length,
  };

  return {
    updatedAt: new Date().toISOString(),
    range: { start: startDate, end: endDate },
    summary,
    trend,
    creators,
    productSlots,
    campaigns,
    materials,
    pool,
    unattributedRevenue: round2(unattributedRevenue),
    products: [...productSet].sort(),
    slots: [...slotSet].sort(),
    warnings,
    eltvDisplayFactor: ELTV_DISPLAY_FACTOR,
  };
}
