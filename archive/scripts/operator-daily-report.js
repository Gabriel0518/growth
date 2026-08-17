#!/usr/bin/env node
/**
 * Operator Daily Report — generates a summary message for Feishu
 * 
 * Per operator: cost, corrected revenue, profit, profit margin
 * Sorted by revenue descending
 * 
 * Usage: node scripts/operator-daily-report.js [date]
 *   date defaults to yesterday
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require(path.join(__dirname, '..', 'dashboard', 'node_modules', 'better-sqlite3'));

// ── Config ──
const POSTBACK_DB_PATH = '/home/admin/dataserver/data.db';
const DATA_DIR = path.join(__dirname, '..', 'dashboard', 'data');
const XMP_CACHE_DIR = path.join(DATA_DIR, 'xmp-cache');

const APP_ID_MAP = {
  'com.doramatch.app': 'Dora And',
  'id6746109957': 'Dora iOS',
  'id6746782904': 'Romi iOS',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  'id1658972379': 'GraceChat',
  'id6759697686': 'Kira iOS',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
  '6746109957': 'Dora iOS',
  '6746782904': 'Romi iOS',
  '1658972379': 'GraceChat',
  '6759697686': 'Kira iOS',
  '6746466099': 'Luma',
  'com.circleconnect.dora': 'Dora iOS',
  'com.chatsbridgeconnect.romi': 'Romi iOS',
  'com.odyssey.luma': 'Luma',
  'id6746466099': 'Luma',
};

const ANDROID_APP_IDS = {
  'com.doramatch.app': 'Dora And',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
};

const IOS_AF_APP_IDS = {
  'id6746109957': 'Dora iOS',
  'id6746782904': 'Romi iOS',
  'id6746466099': 'Luma',
  'id1658972379': 'GraceChat',
};

const IOS_AD_APP_IDS = {
  '6746109957': 'Dora iOS',
  '6746782904': 'Romi iOS',
  '6746466099': 'Luma',
  '1658972379': 'GraceChat',
};

const IOS_FB_FIXED = {
  'GraceChat': 2.0,
  'Dora iOS': 1.4,
  'Romi iOS': 1.4,
  'Luma': 1.35,
};

// Platform fee rates per product
const PLATFORM_FEE = {
  'GraceChat': 0.3,
  'Dora And': 0.2,
  'Dora iOS': 0.3,
  'Doni': 0.23,
  'Romi iOS': 0.3,
  'Luma': 0.125,
  'Jovia And': 0.26,
  'Romi And': 0.3,
  'Kira And': 0.15,
  'Nalo And': 0.15,
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
  'Social_facebook': 'FB', 'facebook': 'FB',
  'Facebook+web': 'FB', 'Facebook web': 'FB',
  'googleadwords_int': 'GG', 'Google Ads ACI': 'GG', 'Google+Ads+ACI': 'GG',
  'tiktokglobal_int': 'TT', 'TikTok+SAN': 'TT', 'TikTok SAN': 'TT',
};

function mapMediaSource(src) {
  if (!src) return 'Unknown';
  if (MEDIA_SOURCE_MAP[src]) return MEDIA_SOURCE_MAP[src];
  const s = src.toLowerCase();
  if (s.includes('w2a') || s.includes('web')) return 'FB';
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
  for (const code of OPERATOR_CODES) {
    if (lower.includes(code)) return code;
  }
  if (lower.includes('liuh')) return 'lh';
  if (lower.includes('zm') && !lower.includes('zmf')) return 'zm1';
  return null;
}

function tableForMonth(dateStr) {
  return 'records_' + dateStr.slice(0, 4) + dateStr.slice(5, 7);
}

// ── Correction factors (same logic as server.js computeCorrectionFactorsSync) ──

function computeCorrectionFactors(dateStr, db) {
  const factors = {};
  
  // Load athena data
  const dayDataPath = path.join(DATA_DIR, `${dateStr}.json`);
  const athenaMap = {};
  try {
    const dayData = JSON.parse(fs.readFileSync(dayDataPath, 'utf8'));
    // Find midnight snapshot (UTC 16:xx) or last snapshot
    let snap = null;
    for (const s of (dayData.snapshots || [])) {
      if (new Date(s.time).getUTCHours() === 16) { snap = s; break; }
    }
    if (!snap && dayData.snapshots && dayData.snapshots.length > 0) {
      snap = dayData.snapshots[dayData.snapshots.length - 1];
    }
    if (snap && snap.athena) {
      for (const item of snap.athena) {
        athenaMap[item.product] = item.totalRevenue || 0;
      }
    }
  } catch (_) {}
  
  const tableName = tableForMonth(dateStr);
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  if (!tableExists) {
    for (const p of [...Object.values(ANDROID_APP_IDS), ...Object.values(IOS_AF_APP_IDS)]) factors[p] = 1;
    return factors;
  }
  
  // Android: athena / af_non_organic * 0.95
  const androidIds = Object.keys(ANDROID_APP_IDS);
  if (androidIds.length > 0) {
    const rows = db.prepare(`
      SELECT app_id, ROUND(SUM(revenue), 4) as rev
      FROM ${tableName}
      WHERE event_name='af_purchase' AND date(event_time, '+8 hours')=?
        AND media_source != 'organic'
        AND app_id IN (${androidIds.map(() => '?').join(',')})
      GROUP BY app_id
    `).all(dateStr, ...androidIds);
    for (const row of rows) {
      const product = ANDROID_APP_IDS[row.app_id];
      const athenaRev = athenaMap[product] || 0;
      if (row.rev > 0 && athenaRev > 0) {
        factors[product] = Math.round(athenaRev / row.rev * 0.95 * 10000) / 10000;
      }
    }
  }
  for (const p of Object.values(ANDROID_APP_IDS)) { if (factors[p] == null) factors[p] = 1; }
  
  // iOS: FB fixed multiplier then base factor
  const iosAfIds = Object.keys(IOS_AF_APP_IDS);
  const afRows = db.prepare(`
    SELECT app_id, media_source, ROUND(SUM(revenue), 4) as rev
    FROM ${tableName}
    WHERE event_name='af_purchase' AND date(event_time, '+8 hours')=?
      AND media_source != 'organic'
      AND app_id IN (${iosAfIds.map(() => '?').join(',')})
    GROUP BY app_id, media_source
  `).all(dateStr, ...iosAfIds);
  
  const iosAdIds = Object.keys(IOS_AD_APP_IDS);
  const adRows = db.prepare(`
    SELECT app_id, media_source, ROUND(SUM(revenue), 4) as rev
    FROM ${tableName}
    WHERE event_name='ad_purchase' AND date(datetime(event_time, 'unixepoch', '+8 hours'))=?
      AND media_source NOT IN ('Organic', 'organic')
      AND app_id IN (${iosAdIds.map(() => '?').join(',')})
    GROUP BY app_id, media_source
  `).all(dateStr, ...iosAdIds);
  
  const iosProdRevenue = {};
  for (const p of Object.values(IOS_AF_APP_IDS)) iosProdRevenue[p] = { fb: 0, nonFb: 0 };
  for (const row of afRows) {
    const p = IOS_AF_APP_IDS[row.app_id];
    if (isFbSource(row.media_source)) iosProdRevenue[p].fb += row.rev;
    else iosProdRevenue[p].nonFb += row.rev;
  }
  for (const row of adRows) {
    const p = IOS_AD_APP_IDS[row.app_id]; if (!p) continue;
    const ms = row.media_source.replace(/\+/g, ' ');
    if (isFbSource(ms)) iosProdRevenue[p].fb += row.rev;
    else iosProdRevenue[p].nonFb += row.rev;
  }
  
  for (const p of Object.values(IOS_AF_APP_IDS)) {
    if (p === 'Kira iOS') { factors[p] = 1; continue; }
    const athenaRev = athenaMap[p] || 0;
    const { fb, nonFb } = iosProdRevenue[p];
    const fbFixed = IOS_FB_FIXED[p] || 1;
    const fbAdjusted = fb * fbFixed;
    const totalBase = fbAdjusted + nonFb;
    if (totalBase > 0 && athenaRev > 0) {
      const baseFactor = Math.round(athenaRev / totalBase * 0.95 * 10000) / 10000;
      const fbFactor = Math.round(baseFactor * fbFixed * 10000) / 10000;
      factors[p] = { fb: fbFactor, other: baseFactor };
    } else {
      factors[p] = { fb: fbFixed, other: 1 };
    }
  }
  
  return factors;
}

function getCorrectionForProductChannel(factors, product, channel) {
  const f = factors[product];
  if (f == null) return 1;
  if (typeof f === 'number') return f;
  // iOS products with { fb, other }
  return (channel === 'FB' || channel === 'FB W2A') ? f.fb : f.other;
}

// ── Revenue from SQLite (AF + AD, per campaign) ──

function getRevenueByOperator(dateStr, db, factors) {
  const tableName = tableForMonth(dateStr);
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  if (!tableExists) return {};
  
  // result: { operator: { total: correctedRev, products: { product: correctedRev } } }
  const operators = {};
  
  // AF purchase (all products)
  const afRows = db.prepare(`
    SELECT app_id, campaign, media_source, ROUND(SUM(revenue), 4) as rev
    FROM ${tableName}
    WHERE event_name='af_purchase' AND date(event_time, '+8 hours')=?
      AND media_source != 'organic'
    GROUP BY app_id, campaign, media_source
  `).all(dateStr);
  
  for (const row of afRows) {
    const product = APP_ID_MAP[row.app_id];
    if (!product) continue;
    const op = matchOperator(row.campaign);
    if (!op) continue;
    const channel = mapMediaSource(row.media_source);
    const cf = getCorrectionForProductChannel(factors, product, channel);
    const correctedRev = row.rev * cf;
    
    if (!operators[op]) operators[op] = { revenue: 0, products: {} };
    operators[op].revenue += correctedRev;
    if (!operators[op].products[product]) operators[op].products[product] = 0;
    operators[op].products[product] += correctedRev;
  }
  
  // AD purchase (iOS only — Adjust data, event_time is unix timestamp)
  const iosAdIds = Object.keys(IOS_AD_APP_IDS);
  if (iosAdIds.length > 0) {
    const adRows = db.prepare(`
      SELECT app_id, campaign, media_source, ROUND(SUM(revenue), 4) as rev
      FROM ${tableName}
      WHERE event_name='ad_purchase' AND date(datetime(event_time, 'unixepoch', '+8 hours'))=?
        AND media_source NOT IN ('Organic', 'organic')
        AND app_id IN (${iosAdIds.map(() => '?').join(',')})
      GROUP BY app_id, campaign, media_source
    `).all(dateStr, ...iosAdIds);
    
    for (const row of adRows) {
      const product = IOS_AD_APP_IDS[row.app_id];
      if (!product) continue;
      const op = matchOperator(row.campaign);
      if (!op) continue;
      const channel = mapMediaSource(row.media_source);
      const cf = getCorrectionForProductChannel(factors, product, channel);
      const correctedRev = row.rev * cf;
      
      if (!operators[op]) operators[op] = { revenue: 0, products: {} };
      operators[op].revenue += correctedRev;
      if (!operators[op].products[product]) operators[op].products[product] = 0;
      operators[op].products[product] += correctedRev;
    }
  }
  
  return operators;
}

// ── XMP cost by operator ──

function getCostByOperator(dateStr) {
  const cachePath = path.join(XMP_CACHE_DIR, `xmp-campaigns-${dateStr}.json`);
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const operators = {};
    for (const row of cache.data || []) {
      const op = matchOperator(row.campaign);
      if (!op) continue;
      if (!operators[op]) operators[op] = { cost: 0, products: {} };
      operators[op].cost += row.cost || 0;
      const prod = row.product || 'Unknown';
      if (!operators[op].products[prod]) operators[op].products[prod] = 0;
      operators[op].products[prod] += row.cost || 0;
    }
    return operators;
  } catch (err) {
    console.error(`[OpReport] XMP cache error for ${dateStr}: ${err.message}`);
    return {};
  }
}

// ── Profit calculation ──
// profit = revenue * (1 - platform_fee) * (1 - refund_rate) - cost
// profit_margin = profit / revenue

function computeProfit(revByProduct, cost) {
  let netRevenue = 0;
  for (const [product, rev] of Object.entries(revByProduct)) {
    const fee = PLATFORM_FEE[product] || 0.3; // default 30%
    netRevenue += rev * (1 - fee) * (1 - REFUND_RATE);
  }
  return {
    profit: netRevenue - cost,
    netRevenue,
  };
}

// ── Format message ──

function formatMessage(dateStr, operatorData) {
  const sorted = Object.entries(operatorData)
    .sort((a, b) => b[1].revenue - a[1].revenue);
  
  const dateDisplay = `${dateStr.slice(0, 4)}/${parseInt(dateStr.slice(5, 7))}/${parseInt(dateStr.slice(8, 10))}`;
  
  let msg = `📊 投手日报 ${dateDisplay}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  
  let totalCost = 0, totalRevenue = 0, totalProfit = 0;
  
  for (const [op, data] of sorted) {
    const { cost, revenue, profit, profitMargin } = data;
    totalCost += cost;
    totalRevenue += revenue;
    totalProfit += profit;
    
    const name = OPERATOR_NAMES[op] || op.toUpperCase();
    const paddedName = name.length === 2 ? name + '\u3000\u3000' : name + '\u3000';
    const marginStr = revenue > 0 ? `${(profitMargin * 100).toFixed(1)}%` : '-';
    const profitStr = profit >= 0 ? `+$${profit.toLocaleString('en-US', {maximumFractionDigits: 0})}` : `-$${Math.abs(profit).toLocaleString('en-US', {maximumFractionDigits: 0})}`;
    
    msg += `${paddedName}消耗 $${cost.toLocaleString('en-US', {maximumFractionDigits: 0})} | 收入 $${revenue.toLocaleString('en-US', {maximumFractionDigits: 0})} | 利润 ${profitStr} | ${marginStr}\n`;
  }
  
  // Total
  const totalMargin = totalRevenue > 0 ? ((totalProfit / totalRevenue) * 100).toFixed(1) + '%' : '-';
  const totalProfitStr = totalProfit >= 0 ? `+$${totalProfit.toLocaleString('en-US', {maximumFractionDigits: 0})}` : `-$${Math.abs(totalProfit).toLocaleString('en-US', {maximumFractionDigits: 0})}`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📌 合计: 消耗 $${totalCost.toLocaleString('en-US', {maximumFractionDigits: 0})} | 收入 $${totalRevenue.toLocaleString('en-US', {maximumFractionDigits: 0})} | 利润 ${totalProfitStr} (${totalMargin})\n`;
  
  return msg;
}

// ── Main ──

function main() {
  // Default to yesterday
  let dateStr = process.argv[2];
  if (!dateStr) {
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    now.setUTCDate(now.getUTCDate() - 1);
    dateStr = now.toISOString().slice(0, 10);
  }
  
  console.log(`[OpReport] Generating for ${dateStr}`);
  
  const db = new sqlite3(POSTBACK_DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  
  try {
    // 1. Compute correction factors
    const factors = computeCorrectionFactors(dateStr, db);
    console.log('[OpReport] Correction factors:', JSON.stringify(factors));
    
    // 2. Get revenue by operator (corrected)
    const revByOp = getRevenueByOperator(dateStr, db, factors);
    
    // 3. Get cost by operator
    const costByOp = getCostByOperator(dateStr);
    
    // 4. Merge and compute profit
    const allOps = new Set([...Object.keys(revByOp), ...Object.keys(costByOp)]);
    const operatorData = {};
    
    for (const op of allOps) {
      const rev = revByOp[op] || { revenue: 0, products: {} };
      const costData = costByOp[op] || { cost: 0, products: {} };
      const cost = costData.cost;
      const revenue = rev.revenue;
      
      const { profit } = computeProfit(rev.products, cost);
      const profitMargin = revenue > 0 ? profit / revenue : 0;
      
      operatorData[op] = { cost, revenue, profit, profitMargin, products: rev.products };
    }
    
    // 5. Format message
    const msg = formatMessage(dateStr, operatorData);
    console.log('\n' + msg);
    
    // Output to stdout for piping
    process.stdout.write('\n---MESSAGE---\n' + msg + '\n---END---\n');
    
  } finally {
    db.close();
  }
}

main();
