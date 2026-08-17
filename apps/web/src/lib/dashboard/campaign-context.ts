/**
 * 单 campaign 上下文数据包 —— 复刻旧 server.js 的 /api/campaign-context。
 * 汇总某 campaign×product×channel 过去 7 天 + 今天的成本/新用户收入/修正/eLTV/回本 ROAS，
 * 并拼出投放大师 system prompt + 用户数据表 user message，供前端 POST 到 /api/llm/chat。
 * 修正系数复用 correction-factors、eLTV 复用 eltv、成本读 XMP 缓存；成本外的收入/安装直扫 records 月表。
 * SQLite→PG：af 用北京日 UTC 串边界，ad 用 epoch bigint；julianday*24 → EXTRACT(EPOCH)/3600。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { query, queryOne } from '@agentic-ug/db';

import { getCorrectionFactors, isFbSource, type FactorMap } from './correction-factors';
import { beijingDayBounds, tableForMonth, todayBeijing, yesterdayBeijing } from './dates';
import { AD_UID_EXPR, AF_UID_EXPR, buildDedupCountSql } from './dedup';
import { resolveContextEltv } from './eltv';
import { APP_ID_MAP } from './mapping';
import { AD_ORGANIC_SOURCES } from './operators';
import { fetchXmpCampaigns, type XmpRow } from './xmp';

export interface CampaignContextInput {
  campaign: string;
  product: string;
  channel: string;
  operator?: string;
  date?: string;
}

interface DayMetric {
  date: string;
  cost: number;
  impressions: number;
  clicks: number;
  installs: number;
  newUserRevenue: number;
  correctedNewUserRevenue: number;
  correctionFactor: number;
  eltvD180: number | null;
  eltvConfidence: string;
  breakevenROAS: number | null;
  cpm: number;
  cpc: number;
  cpi: number;
  newUserROAS: number;
  newUserEltvROAS: number;
  snapshotTime?: string;
}

export interface CampaignContextResult {
  summary: string;
  structuredInput: {
    campaign: string;
    product: string;
    channel: string;
    historyDays: DayMetric[];
    realtime: DayMetric;
  };
  messages: { role: string; content: string }[];
}

/** YYYY-MM-DD 偏移 deltaDays 天（UTC 午夜基准）。 */
function shiftDate(dateStr: string, deltaDays: number): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** $start..$(start+n-1) 占位符串。 */
function inClause(count: number, start: number): string {
  return Array.from({ length: count }, (_, i) => `$${(i + start).toString()}`).join(',');
}

/** ad campaign 解码：urldecode（+→空格）后剥末尾 "(…)"，再 trim。 */
function decodeAdCampaign(raw: string | null): string {
  if (raw == null || raw === '') return '';
  let campaign: string;
  try {
    campaign = decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {
    campaign = raw;
  }
  return campaign.replace(/\s*\(.*?\)\s*$/, '').trim();
}

/** channel 是否 FB（含 FB W2A 与 isFbSource 判定）。 */
function isChannelFB(channel: string): boolean {
  return channel === 'FB' || channel === 'FB W2A' || isFbSource(channel);
}

/** 把 FactorMap 里某产品×渠道解析成标量修正系数。 */
function resolveFactor(factors: FactorMap, product: string, channel: string): number {
  const f = factors[product];
  if (f === undefined) return 1;
  if (typeof f === 'number') return f;
  return isChannelFB(channel) ? f.fb : f.other;
}

interface AdRow {
  campaign: string | null;
  revenue: number | null;
  event_time: string;
  install_time: string;
  media_source: string | null;
}

interface DayContext {
  product: string;
  campaign: string;
  campaignTrimmed: string;
  appIds: string[];
  xmpByDay: Map<string, XmpRow[]>;
  correctionByCfDate: Map<string, number>;
  eltvD180: number | null;
  eltvConfidence: string;
  breakevenROAS: number | null;
}

async function tableExists(tbl: string): Promise<boolean> {
  const row = await queryOne<{ tablename: string }>(
    'SELECT tablename FROM pg_tables WHERE tablename = $1',
    [tbl],
  );
  return row != null;
}

/** 单日某 campaign 的 AF 新用户收入 + 安装（含跨日、跨月）。 */
async function computeAfPart(
  tbl: string,
  nextTbl: string | null,
  day: string,
  ctx: DayContext,
): Promise<{ newUserRev: number; installs: number }> {
  const { strLo, strHi } = beijingDayBounds(day);
  const next = beijingDayBounds(shiftDate(day, 1));
  const ids = ctx.appIds;
  const campIdx = 5 + ids.length;

  const mainRow = await queryOne<{ v: number }>(
    `SELECT COALESCE(SUM(CASE WHEN install_time >= $1 AND install_time < $2
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 >= 0
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 < 24
       THEN revenue ELSE 0 END), 0)::float8 as v
     FROM ${tbl}
     WHERE event_name = 'af_purchase' AND event_time >= $3 AND event_time < $4
       AND app_id IN (${inClause(ids.length, 5)}) AND campaign = $${campIdx.toString()}`,
    [strLo, strHi, strLo, strHi, ...ids, ctx.campaignTrimmed],
  );
  let newUserRev = mainRow?.v ?? 0;

  newUserRev += await afCrossDay(tbl, day, next.strLo, next.strHi, ctx);
  if (nextTbl && nextTbl !== tbl) {
    newUserRev += await afCrossDay(nextTbl, day, next.strLo, next.strHi, ctx);
  }

  const idxCamp = 3 + ids.length;
  const regRow = await queryOne<{ installs: number }>(
    buildDedupCountSql(
      '',
      'installs',
      'event_time, _tbl, _rid',
      `SELECT event_time, id AS _rid, 0 AS _tbl, ${AF_UID_EXPR} AS uid FROM ${tbl}
       WHERE event_name = 'af_complete_registration' AND event_time >= $1 AND event_time < $2
         AND app_id IN (${inClause(ids.length, 3)}) AND campaign = $${idxCamp.toString()}`,
    ),
    [strLo, strHi, ...ids, ctx.campaignTrimmed],
  );
  return { newUserRev, installs: regRow?.installs ?? 0 };
}

/** AF 跨日补充：install 落 day、event 落次日、diff<24h。 */
async function afCrossDay(
  tbl: string,
  day: string,
  nextLo: string,
  nextHi: string,
  ctx: DayContext,
): Promise<number> {
  const { strLo, strHi } = beijingDayBounds(day);
  const ids = ctx.appIds;
  const campIdx = 5 + ids.length;
  const row = await queryOne<{ v: number }>(
    `SELECT COALESCE(SUM(revenue), 0)::float8 as v FROM ${tbl}
     WHERE event_name = 'af_purchase'
       AND install_time >= $1 AND install_time < $2
       AND event_time >= $3 AND event_time < $4
       AND app_id IN (${inClause(ids.length, 5)}) AND campaign = $${campIdx.toString()}
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 >= 0
       AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 < 24`,
    [strLo, strHi, nextLo, nextHi, ...ids, ctx.campaignTrimmed],
  );
  return row?.v ?? 0;
}

/** 单日某 campaign 的 AD 新用户收入 + 安装（iOS Adjust，epoch 列，含跨日、跨月）。 */
async function computeAdPart(
  tbl: string,
  nextTbl: string | null,
  day: string,
  ctx: DayContext,
): Promise<{ newUserRev: number; installs: number }> {
  const { epLo, epHi } = beijingDayBounds(day);
  const next = beijingDayBounds(shiftDate(day, 1));
  const ids = ctx.appIds;
  let newUserRev = 0;
  let installs = 0;

  const paidRows = await query<AdRow>(
    `SELECT campaign, revenue, event_time, install_time, media_source FROM ${tbl}
     WHERE event_name = 'ad_purchase' AND event_time::bigint >= $1 AND event_time::bigint < $2
       AND app_id IN (${inClause(ids.length, 3)})`,
    [epLo, epHi, ...ids],
  );
  for (const row of paidRows) {
    if (decodeAdCampaign(row.campaign) !== ctx.campaignTrimmed) continue;
    if (row.media_source != null && AD_ORGANIC_SOURCES.has(row.media_source)) continue;
    const eventTs = Number.parseInt(row.event_time, 10);
    const installTs = Number.parseInt(row.install_time, 10);
    if (Number.isNaN(eventTs) || Number.isNaN(installTs)) continue;
    const installDay = new Date((installTs + 8 * 3600) * 1000).toISOString().slice(0, 10);
    const diff = eventTs - installTs;
    if (installDay === day && diff >= 0 && diff < 86_400) newUserRev += row.revenue ?? 0;
  }

  newUserRev += await adCrossDay(tbl, next.epLo, next.epHi, epLo, epHi, ctx);
  if (nextTbl && nextTbl !== tbl) {
    newUserRev += await adCrossDay(nextTbl, next.epLo, next.epHi, epLo, epHi, ctx);
  }

  const regRows = await query<{ campaign: string | null; cnt: number }>(
    buildDedupCountSql(
      'campaign',
      'cnt',
      'event_time::bigint, _tbl, _rid',
      `SELECT campaign, event_time, id AS _rid, 0 AS _tbl, ${AD_UID_EXPR} AS uid FROM ${tbl}
       WHERE event_name = 'ad_complete_registration'
         AND event_time::bigint >= $1 AND event_time::bigint < $2
         AND app_id IN (${inClause(ids.length, 3)})`,
    ),
    [epLo, epHi, ...ids],
  );
  for (const row of regRows) {
    if (decodeAdCampaign(row.campaign) === ctx.campaignTrimmed) installs += row.cnt;
  }
  return { newUserRev, installs };
}

/** AD 跨日补充：install 落 day、event 落次日、diff<86400s。 */
async function adCrossDay(
  tbl: string,
  eventLo: number,
  eventHi: number,
  installLo: number,
  installHi: number,
  ctx: DayContext,
): Promise<number> {
  const ids = ctx.appIds;
  const rows = await query<AdRow>(
    `SELECT campaign, revenue, event_time, install_time, media_source FROM ${tbl}
     WHERE event_name = 'ad_purchase'
       AND install_time::bigint >= $1 AND install_time::bigint < $2
       AND event_time::bigint >= $3 AND event_time::bigint < $4
       AND event_time::bigint - install_time::bigint >= 0
       AND event_time::bigint - install_time::bigint < 86400
       AND app_id IN (${inClause(ids.length, 5)})`,
    [installLo, installHi, eventLo, eventHi, ...ids],
  );
  let extra = 0;
  for (const row of rows) {
    if (decodeAdCampaign(row.campaign) !== ctx.campaignTrimmed) continue;
    if (row.media_source != null && AD_ORGANIC_SOURCES.has(row.media_source)) continue;
    extra += row.revenue ?? 0;
  }
  return extra;
}

function xmpForDay(
  ctx: DayContext,
  day: string,
): { cost: number; impressions: number; clicks: number } {
  let cost = 0;
  let impressions = 0;
  let clicks = 0;
  for (const row of ctx.xmpByDay.get(day) ?? []) {
    if (
      row.product === ctx.product &&
      (row.campaign === ctx.campaign || row.campaign.trim() === ctx.campaignTrimmed)
    ) {
      cost += row.cost;
      impressions += row.impressions;
      clicks += row.clicks;
    }
  }
  return { cost, impressions, clicks };
}

async function computeDayMetrics(day: string, ctx: DayContext): Promise<DayMetric | null> {
  const tbl = tableForMonth(day);
  if (!(await tableExists(tbl))) return null;
  const nextTbl = tableForMonth(shiftDate(day, 1));
  const nextExists = nextTbl !== tbl && (await tableExists(nextTbl));
  const nextTblArg = nextExists ? nextTbl : null;

  let newUserRev = 0;
  let installs = 0;
  if (ctx.appIds.length > 0) {
    const af = await computeAfPart(tbl, nextTblArg, day, ctx);
    const ad = await computeAdPart(tbl, nextTblArg, day, ctx);
    newUserRev = af.newUserRev + ad.newUserRev;
    installs = af.installs + ad.installs;
  }

  const { cost, impressions, clicks } = xmpForDay(ctx, day);
  const cfDate = day >= todayBeijing() ? yesterdayBeijing() : day;
  const correctionFactor = ctx.correctionByCfDate.get(cfDate) ?? 1;
  const correctedNuRev = newUserRev * correctionFactor;
  const nuROAS = cost > 0 ? correctedNuRev / cost : 0;
  const eltvROAS = nuROAS > 0 && ctx.eltvD180 != null ? nuROAS * ctx.eltvD180 : 0;

  return {
    date: day,
    cost: Math.round(cost * 100) / 100,
    impressions,
    clicks,
    installs,
    newUserRevenue: Math.round(newUserRev * 100) / 100,
    correctedNewUserRevenue: Math.round(correctedNuRev * 100) / 100,
    correctionFactor: Math.round(correctionFactor * 10_000) / 10_000,
    eltvD180: ctx.eltvD180,
    eltvConfidence: ctx.eltvConfidence,
    breakevenROAS: ctx.breakevenROAS,
    cpm: impressions > 0 ? Math.round((cost / impressions) * 1000 * 100) / 100 : 0,
    cpc: clicks > 0 ? Math.round((cost / clicks) * 100) / 100 : 0,
    cpi: installs > 0 ? Math.round((cost / installs) * 100) / 100 : 0,
    newUserROAS: nuROAS > 0 ? Math.round(nuROAS * 10_000) / 10_000 : 0,
    newUserEltvROAS: eltvROAS > 0 ? Math.round(eltvROAS * 10_000) / 10_000 : 0,
  };
}

const BREAKEVEN_ROAS_MAP: Record<string, number> = {
  'Dora And': 100,
  'Jovia And': 100,
  GraceChat: 100,
  Doni: 100,
  'Kira And': 100,
  'Romi iOS': 100,
  'Dora iOS': 100,
  Luma: 100,
  'Romi And': 100,
  'Nalo And': 100,
  'Ruby And': 100,
};

function resolveBreakeven(product: string, confidence: string): number | null {
  let breakeven = BREAKEVEN_ROAS_MAP[product] ?? null;
  if (confidence === 'red') {
    const isIOS = ['Dora iOS', 'Romi iOS', 'Luma', 'GraceChat', 'Kira iOS'].includes(product);
    return isIOS ? 60 : 30;
  }
  if (confidence === 'yellow' && breakeven != null) {
    breakeven = Math.round(breakeven * 1.05 * 10) / 10;
  }
  return breakeven;
}

function zeroMetric(day: string, ctx: DayContext): DayMetric {
  return {
    date: day,
    cost: 0,
    impressions: 0,
    clicks: 0,
    installs: 0,
    newUserRevenue: 0,
    correctedNewUserRevenue: 0,
    correctionFactor: 0,
    eltvD180: ctx.eltvD180,
    eltvConfidence: ctx.eltvConfidence,
    breakevenROAS: ctx.breakevenROAS,
    cpm: 0,
    cpc: 0,
    cpi: 0,
    newUserROAS: 0,
    newUserEltvROAS: 0,
  };
}

const confTag = (c: string): string =>
  c === 'green' ? '🟢可信' : c === 'yellow' ? '🟡供参考' : '🔴不可信';

/** 保留 3 位小数（截断不四舍五入，复刻旧 f3）。 */
function f3(v: number): string {
  const s = v.toString();
  const dot = s.indexOf('.');
  return dot === -1 ? s : s.slice(0, dot + 4);
}

/** 单元宽度：CJK 约 1.6 等宽单位。 */
function dw(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x7f ? 1.6 : 1;
  return Math.ceil(w);
}

function padCell(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - dw(s)));
}

async function loadPromptDoc(fileName: string, fallback: string): Promise<string> {
  try {
    return await readFile(path.join(process.cwd(), 'prompts', fileName), 'utf8');
  } catch {
    return fallback;
  }
}

/** 组织 campaign-context 数据包（7 天历史 + 今天实时 + system/user 消息）。 */
export async function computeCampaignContext(
  input: CampaignContextInput,
): Promise<CampaignContextResult> {
  const { campaign, product, channel } = input;
  const queryDate = (input.date ?? todayBeijing()).trim();
  const todayStr = todayBeijing();
  const campaignTrimmed = campaign.trim();

  const historyDays: string[] = [];
  for (let i = 7; i >= 1; i--) historyDays.push(shiftDate(queryDate, -i));

  const appIds = Object.entries(APP_ID_MAP)
    .filter(([, name]) => name === product)
    .map(([id]) => id);

  // XMP 成本：读缓存（缺失走 staleOk fetch）。
  const allDays = [...historyDays, todayStr];
  const xmpByDay = new Map<string, XmpRow[]>();
  for (const d of allDays) {
    try {
      xmpByDay.set(d, await fetchXmpCampaigns(d, { staleOk: true }));
    } catch {
      xmpByDay.set(d, []);
    }
  }

  // eLTV + 回本 ROAS。
  const { d180: eltvD180, confidence: eltvConfidence } = await resolveContextEltv(product, channel);
  const breakevenROAS = resolveBreakeven(product, eltvConfidence);

  // 修正系数：对每个需要的 cfDate 预取一次。
  const cfDates = new Set<string>();
  for (const d of allDays) cfDates.add(d >= todayStr ? yesterdayBeijing() : d);
  const correctionByCfDate = new Map<string, number>();
  for (const cfDate of cfDates) {
    try {
      const factors = await getCorrectionFactors(cfDate);
      correctionByCfDate.set(cfDate, resolveFactor(factors, product, channel));
    } catch {
      correctionByCfDate.set(cfDate, 1);
    }
  }

  const ctx: DayContext = {
    product,
    campaign,
    campaignTrimmed,
    appIds,
    xmpByDay,
    correctionByCfDate,
    eltvD180,
    eltvConfidence,
    breakevenROAS,
  };

  const historicalData: DayMetric[] = [];
  for (const day of historyDays) {
    historicalData.push((await computeDayMetrics(day, ctx)) ?? zeroMetric(day, ctx));
  }

  const realtimeData = (await computeDayMetrics(todayStr, ctx)) ?? zeroMetric(todayStr, ctx);
  realtimeData.snapshotTime = `${new Date(Date.now() + 8 * 3_600_000).toISOString().replace('T', ' ').replace('Z', '')} CST`;

  const structuredInput = {
    campaign,
    product,
    channel,
    historyDays: historicalData,
    realtime: realtimeData,
  };

  const rt = realtimeData;
  const summary = `
    <table>
      <tr><td>产品</td><td>${product}</td></tr>
      <tr><td>渠道</td><td>${channel}</td></tr>
      <tr><td>日期</td><td>${queryDate}</td></tr>
      <tr><td>XMP 消耗</td><td>$${rt.cost.toFixed(2)}</td></tr>
      <tr><td>CPM</td><td>$${rt.cpm.toFixed(2)}</td></tr>
      <tr><td>CPC</td><td>$${rt.cpc.toFixed(2)}</td></tr>
      <tr><td>CPI</td><td>$${rt.cpi.toFixed(2)}</td></tr>
      <tr><td>新用户收入</td><td>$${rt.newUserRevenue.toFixed(2)}</td></tr>
      <tr><td>修正后新用户收入</td><td>$${rt.correctedNewUserRevenue.toFixed(2)}</td></tr>
      <tr><td>新用户ROAS</td><td>${(rt.newUserROAS * 100).toFixed(1)}%</td></tr>
      <tr><td>eLTV ROAS</td><td>${(rt.newUserEltvROAS * 100).toFixed(1)}% ${confTag(rt.eltvConfidence)}</td></tr>
      ${rt.breakevenROAS == null ? '' : `<tr><td>回本ROAS</td><td>${rt.breakevenROAS.toString()}%</td></tr>`}
    </table>
  `;

  const masterDoc = await loadPromptDoc(
    '投放大师.md',
    '（投放大师.md 文件未找到，请确保文件存在）',
  );
  const dataDoc = await loadPromptDoc('AI投放决策.md', '');
  let systemPrompt = `你是投放大师AI。请严格按照以下决策指南的框架和规则，基于用户提供的输入数据给出预算调整建议。\n\n${masterDoc}`;
  if (dataDoc) {
    systemPrompt += `\n\n---\n\n以下是基于历史数据量化分析得出的补充决策规则。当上述经验框架与以下数据结论冲突时，以数据结论为准。\n\n${dataDoc}`;
  }

  const tHeaders = [
    '日期',
    '消耗',
    'CPM',
    'CPC',
    'CPI',
    '新用户收入',
    '修正后收入',
    '修正系数',
    '新用户ROAS',
    'eLTV_ROAS',
  ];
  const tRows = structuredInput.historyDays.map((d) => [
    d.date.slice(5),
    `$${f3(d.cost)}`,
    `$${f3(d.cpm)}`,
    `$${f3(d.cpc)}`,
    `$${f3(d.cpi)}`,
    `$${f3(d.newUserRevenue)}`,
    `$${f3(d.correctedNewUserRevenue)}`,
    f3(d.correctionFactor),
    `${(d.newUserROAS * 100).toFixed(1)}%`,
    `${(d.newUserEltvROAS * 100).toFixed(1)}%`,
  ]);
  const colWidths = tHeaders.map((h, i) => Math.max(dw(h), ...tRows.map((r) => dw(r[i] ?? ''))));
  const fmtRow = (cells: string[]): string =>
    `| ${cells.map((c, i) => padCell(c, colWidths[i] ?? 0)).join(' | ')} |`;
  const sepLine = `|${colWidths.map((w) => '-'.repeat(w + 2)).join('|')}|`;

  let userText = `Campaign: ${campaign}\nProduct: ${product}\nChannel: ${channel}\n\n`;
  userText += `=== 过去7天每日数据 ===\n`;
  userText += `${fmtRow(tHeaders)}\n`;
  userText += `${sepLine}\n`;
  for (const r of tRows) userText += `${fmtRow(r)}\n`;
  userText += `\n=== 今天实时数据 (截至 ${rt.snapshotTime ?? '?'}) ===\n`;
  userText += `日期: ${rt.date}\n`;
  userText += `消耗: $${f3(rt.cost)}\n`;
  userText += `CPM: $${f3(rt.cpm)}\n`;
  userText += `CPC: $${f3(rt.cpc)}\n`;
  userText += `CPI: $${f3(rt.cpi)}\n`;
  userText += `新用户收入: $${f3(rt.newUserRevenue)}\n`;
  userText += `修正后收入: $${f3(rt.correctedNewUserRevenue)}\n`;
  userText += `修正系数: ${f3(rt.correctionFactor)}\n`;
  userText += `新用户ROAS: ${(rt.newUserROAS * 100).toFixed(1)}%\n`;
  userText += `eLTV D180: ${rt.eltvD180?.toString() ?? 'N/A'}\n`;
  userText += `eLTV ROAS: ${(rt.newUserEltvROAS * 100).toFixed(1)}% ${confTag(rt.eltvConfidence)}\n`;
  if (rt.breakevenROAS != null) {
    userText += `回本ROAS: ${rt.breakevenROAS.toString()}%${rt.eltvConfidence === 'yellow' ? '（已含5%风险调整）' : ''}\n`;
  }

  return {
    summary,
    structuredInput,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
  };
}
