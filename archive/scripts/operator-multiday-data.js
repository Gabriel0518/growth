#!/usr/bin/env node
/**
 * Operator Multi-Day Data Export — outputs JSON for chart generation
 * 
 * Usage: node scripts/operator-multiday-data.js [startDate] [endDate]
 *   defaults: 1st of current month to yesterday
 * 
 * Output: JSON to stdout
 * { dates: [...], operators: { code: { name, daily: { date: { revenue, cost, profit, profitMargin, products: {...} } } } } }
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require(path.join(__dirname, '..', 'dashboard', 'node_modules', 'better-sqlite3'));

const POSTBACK_DB_PATH = '/home/admin/dataserver/data.db';
const DATA_DIR = path.join(__dirname, '..', 'dashboard', 'data');
const XMP_CACHE_DIR = path.join(DATA_DIR, 'xmp-cache');

const APP_ID_MAP = {
  'com.doramatch.app': 'Dora And', 'id6746109957': 'Dora iOS', 'id6746782904': 'Romi iOS',
  'com.qiga.vio': 'Jovia And', 'com.doni.appa': 'Doni', 'com.romiandroid.appmatch': 'Romi And',
  'id1658972379': 'GraceChat', 'id6759697686': 'Kira iOS', 'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And', '6746109957': 'Dora iOS', '6746782904': 'Romi iOS',
  '1658972379': 'GraceChat', '6759697686': 'Kira iOS', '6746466099': 'Luma',
  'com.circleconnect.dora': 'Dora iOS', 'com.chatsbridgeconnect.romi': 'Romi iOS',
  'com.odyssey.luma': 'Luma', 'id6746466099': 'Luma',
};

const ANDROID_APP_IDS = {
  'com.doramatch.app': 'Dora And', 'com.qiga.vio': 'Jovia And', 'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And', 'com.meraki.kira': 'Kira And', 'com.cavalier.nalo': 'Nalo And',
};
const IOS_AF_APP_IDS = { 'id6746109957': 'Dora iOS', 'id6746782904': 'Romi iOS', 'id6746466099': 'Luma', 'id1658972379': 'GraceChat' };
const IOS_AD_APP_IDS = { '6746109957': 'Dora iOS', '6746782904': 'Romi iOS', '6746466099': 'Luma', '1658972379': 'GraceChat' };
const IOS_FB_FIXED = { 'GraceChat': 2.0, 'Dora iOS': 1.4, 'Romi iOS': 1.4, 'Luma': 1.35 };

const PLATFORM_FEE = {
  'GraceChat': 0.3, 'Dora And': 0.2, 'Dora iOS': 0.3, 'Doni': 0.23, 'Romi iOS': 0.3,
  'Luma': 0.125, 'Jovia And': 0.26, 'Romi And': 0.3, 'Kira And': 0.15, 'Nalo And': 0.15,
};
const REFUND_RATE = 0.01;

const OPERATOR_CODES = ['syh', 'zm1', 'cyl', 'wcx', 'zmf', 'mcy', 'lh', 'ymt', 'wty', 'wvv', 'zjc', 'cy1'];
const OPERATOR_NAMES = {
  'syh': '苏屹恒', 'zm1': '张苗', 'cyl': '曹永麟', 'wcx': '武春香',
  'zmf': '张梦凡', 'mcy': '马崇岩', 'lh': '刘欢', 'ymt': '杨梅亭',
  'wty': '吴天越', 'wvv': '王维维', 'zjc': '张嘉铖', 'cy1': '陈祎',
};

const MEDIA_SOURCE_MAP = {
  'Facebook Ads': 'FB', 'Facebook+Installs': 'FB', 'Facebook Installs': 'FB',
  'Instagram+Installs': 'FB', 'Instagram Installs': 'FB', 'Off-Facebook+Installs': 'FB',
  'Social_facebook': 'FB', 'facebook': 'FB', 'Facebook+web': 'FB', 'Facebook web': 'FB',
  'googleadwords_int': 'GG', 'Google Ads ACI': 'GG', 'Google+Ads+ACI': 'GG',
  'tiktokglobal_int': 'TT', 'TikTok+SAN': 'TT', 'TikTok SAN': 'TT',
};

function mapMediaSource(src) {
  if (!src) return 'Unknown';
  if (MEDIA_SOURCE_MAP[src]) return MEDIA_SOURCE_MAP[src];
  if (src.toLowerCase().includes('w2a') || src.toLowerCase().includes('web')) return 'FB';
  return src;
}

function isFbSource(ms) {
  if (!ms) return false;
  const lower = ms.toLowerCase().replace(/\+/g, ' ');
  if (lower.includes('w2a') || lower.includes('web')) return false;
  if (lower.includes('facebook') || lower.includes('instagram') || lower.includes('off-facebook')) return true;
  if (ms === 'restricted' || ms === 'Unattributed') return true;
  return false;
}

function matchOperator(campaign) {
  if (!campaign) return null;
  const lower = campaign.toLowerCase();
  for (const code of OPERATOR_CODES) { if (lower.includes(code)) return code; }
  if (lower.includes('liuh')) return 'lh';
  if (lower.includes('zm') && !lower.includes('zmf')) return 'zm1';
  return null;
}

function tableForMonth(dateStr) { return 'records_' + dateStr.slice(0, 4) + dateStr.slice(5, 7); }

function computeCorrectionFactors(dateStr, db) {
  const factors = {};
  const dayDataPath = path.join(DATA_DIR, `${dateStr}.json`);
  const athenaMap = {};
  try {
    const dayData = JSON.parse(fs.readFileSync(dayDataPath, 'utf8'));
    let snap = null;
    for (const s of (dayData.snapshots || [])) { if (new Date(s.time).getUTCHours() === 16) { snap = s; break; } }
    if (!snap && dayData.snapshots && dayData.snapshots.length > 0) snap = dayData.snapshots[dayData.snapshots.length - 1];
    if (snap && snap.athena) { for (const item of snap.athena) athenaMap[item.product] = item.totalRevenue || 0; }
  } catch (_) {}

  const tableName = tableForMonth(dateStr);
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  if (!tableExists) { for (const p of [...Object.values(ANDROID_APP_IDS), ...Object.values(IOS_AF_APP_IDS)]) factors[p] = 1; return factors; }

  const androidIds = Object.keys(ANDROID_APP_IDS);
  if (androidIds.length > 0) {
    const rows = db.prepare(`SELECT app_id, ROUND(SUM(revenue), 4) as rev FROM ${tableName} WHERE event_name='af_purchase' AND date(event_time, '+8 hours')=? AND media_source != 'organic' AND app_id IN (${androidIds.map(() => '?').join(',')}) GROUP BY app_id`).all(dateStr, ...androidIds);
    for (const row of rows) { const p = ANDROID_APP_IDS[row.app_id]; const a = athenaMap[p] || 0; if (row.rev > 0 && a > 0) factors[p] = Math.round(a / row.rev * 0.95 * 10000) / 10000; }
  }
  for (const p of Object.values(ANDROID_APP_IDS)) { if (factors[p] == null) factors[p] = 1; }

  const iosAfIds = Object.keys(IOS_AF_APP_IDS);
  const afRows = db.prepare(`SELECT app_id, media_source, ROUND(SUM(revenue), 4) as rev FROM ${tableName} WHERE event_name='af_purchase' AND date(event_time, '+8 hours')=? AND media_source != 'organic' AND app_id IN (${iosAfIds.map(() => '?').join(',')}) GROUP BY app_id, media_source`).all(dateStr, ...iosAfIds);
  const iosAdIds = Object.keys(IOS_AD_APP_IDS);
  const adRows = db.prepare(`SELECT app_id, media_source, ROUND(SUM(revenue), 4) as rev FROM ${tableName} WHERE event_name='ad_purchase' AND date(datetime(event_time, 'unixepoch', '+8 hours'))=? AND media_source NOT IN ('Organic', 'organic') AND app_id IN (${iosAdIds.map(() => '?').join(',')}) GROUP BY app_id, media_source`).all(dateStr, ...iosAdIds);

  const iosProdRevenue = {};
  for (const p of Object.values(IOS_AF_APP_IDS)) iosProdRevenue[p] = { fb: 0, nonFb: 0 };
  for (const row of afRows) { const p = IOS_AF_APP_IDS[row.app_id]; if (isFbSource(row.media_source)) iosProdRevenue[p].fb += row.rev; else iosProdRevenue[p].nonFb += row.rev; }
  for (const row of adRows) { const p = IOS_AD_APP_IDS[row.app_id]; if (!p) continue; const ms = row.media_source.replace(/\+/g, ' '); if (isFbSource(ms)) iosProdRevenue[p].fb += row.rev; else iosProdRevenue[p].nonFb += row.rev; }

  for (const p of Object.values(IOS_AF_APP_IDS)) {
    if (p === 'Kira iOS') { factors[p] = 1; continue; }
    const athenaRev = athenaMap[p] || 0; const { fb, nonFb } = iosProdRevenue[p];
    const fbFixed = IOS_FB_FIXED[p] || 1; const totalBase = fb * fbFixed + nonFb;
    if (totalBase > 0 && athenaRev > 0) { const bf = Math.round(athenaRev / totalBase * 0.95 * 10000) / 10000; factors[p] = { fb: Math.round(bf * fbFixed * 10000) / 10000, other: bf }; }
    else factors[p] = { fb: fbFixed, other: 1 };
  }
  return factors;
}

function getCF(factors, product, channel) {
  const f = factors[product]; if (f == null) return 1;
  if (typeof f === 'number') return f;
  return (channel === 'FB' || channel === 'FB W2A') ? f.fb : f.other;
}

function getRevenueByOperator(dateStr, db, factors) {
  const tableName = tableForMonth(dateStr);
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  if (!tableExists) return {};
  const operators = {};

  const afRows = db.prepare(`SELECT app_id, campaign, media_source, ROUND(SUM(revenue), 4) as rev FROM ${tableName} WHERE event_name='af_purchase' AND date(event_time, '+8 hours')=? AND media_source != 'organic' GROUP BY app_id, campaign, media_source`).all(dateStr);
  for (const row of afRows) {
    const product = APP_ID_MAP[row.app_id]; if (!product) continue;
    const op = matchOperator(row.campaign); if (!op) continue;
    const cf = getCF(factors, product, mapMediaSource(row.media_source));
    if (!operators[op]) operators[op] = { revenue: 0, products: {} };
    operators[op].revenue += row.rev * cf;
    operators[op].products[product] = (operators[op].products[product] || 0) + row.rev * cf;
  }

  const iosAdIds = Object.keys(IOS_AD_APP_IDS);
  if (iosAdIds.length > 0) {
    const adRows = db.prepare(`SELECT app_id, campaign, media_source, ROUND(SUM(revenue), 4) as rev FROM ${tableName} WHERE event_name='ad_purchase' AND date(datetime(event_time, 'unixepoch', '+8 hours'))=? AND media_source NOT IN ('Organic', 'organic') AND app_id IN (${iosAdIds.map(() => '?').join(',')}) GROUP BY app_id, campaign, media_source`).all(dateStr, ...iosAdIds);
    for (const row of adRows) {
      const product = IOS_AD_APP_IDS[row.app_id]; if (!product) continue;
      const op = matchOperator(row.campaign); if (!op) continue;
      const cf = getCF(factors, product, mapMediaSource(row.media_source));
      if (!operators[op]) operators[op] = { revenue: 0, products: {} };
      operators[op].revenue += row.rev * cf;
      operators[op].products[product] = (operators[op].products[product] || 0) + row.rev * cf;
    }
  }
  return operators;
}

function getCostByOperator(dateStr) {
  const cachePath = path.join(XMP_CACHE_DIR, `xmp-campaigns-${dateStr}.json`);
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const operators = {};
    for (const row of cache.data || []) {
      const op = matchOperator(row.campaign); if (!op) continue;
      if (!operators[op]) operators[op] = { cost: 0, products: {} };
      operators[op].cost += row.cost || 0;
      const prod = row.product || 'Unknown';
      operators[op].products[prod] = (operators[op].products[prod] || 0) + (row.cost || 0);
    }
    return operators;
  } catch (_) { return {}; }
}

function computeProfit(revByProduct, cost) {
  let netRevenue = 0;
  for (const [product, rev] of Object.entries(revByProduct)) {
    const fee = PLATFORM_FEE[product] || 0.3;
    netRevenue += rev * (1 - fee) * (1 - REFUND_RATE);
  }
  return { profit: netRevenue - cost, netRevenue };
}

function main() {
  let startDate = process.argv[2];
  let endDate = process.argv[3];
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  if (!endDate) {
    const yd = new Date(now); yd.setUTCDate(yd.getUTCDate() - 1);
    endDate = yd.toISOString().slice(0, 10);
  }
  if (!startDate) { startDate = endDate.slice(0, 8) + '01'; }

  // Generate date range
  const dates = [];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const d = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  while (d <= end) {
    dates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    d.setDate(d.getDate() + 1);
  }

  console.error(`[MultiDay] ${startDate} to ${endDate}, ${dates.length} days`);

  const db = new sqlite3(POSTBACK_DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');

  const result = { dates, operators: {} };

  // Init all operators
  for (const code of OPERATOR_CODES) {
    result.operators[code] = { name: OPERATOR_NAMES[code] || code, daily: {} };
  }

  for (const dateStr of dates) {
    const factors = computeCorrectionFactors(dateStr, db);
    const revByOp = getRevenueByOperator(dateStr, db, factors);
    const costByOp = getCostByOperator(dateStr);

    for (const code of OPERATOR_CODES) {
      const rev = revByOp[code] || { revenue: 0, products: {} };
      const costData = costByOp[code] || { cost: 0 };
      const { profit } = computeProfit(rev.products, costData.cost);
      const profitMargin = rev.revenue > 0 ? profit / rev.revenue : 0;

      result.operators[code].daily[dateStr] = {
        revenue: Math.round(rev.revenue * 100) / 100,
        cost: Math.round(costData.cost * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        profitMargin: Math.round(profitMargin * 10000) / 10000,
      };
    }
    console.error(`[MultiDay] ${dateStr} done`);
  }

  db.close();
  process.stdout.write(JSON.stringify(result));
}

main();
