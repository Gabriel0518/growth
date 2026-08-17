#!/usr/bin/env node
/**
 * eLTV by channel for AD (Adjust) products
 * Uses Unix timestamps for event_time/install_time
 * Focuses on Luma (app_id = 6746466099)
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.resolve('/home/admin/dataserver/data.db');

// Channel classification for AD media_source
function classifyChannel(ms) {
  if (!ms) return 'Unknown';
  const s = ms.replace(/\+/g, ' ');
  if (s.includes('TikTok')) return 'TT';
  if (s.includes('Facebook') || s.includes('Instagram') || s.includes('Off-Facebook')) return 'FB';
  if (s.includes('W2A') || s.includes('web')) return 'FB W2A';
  if (s === 'Organic') return 'Organic';
  if (s === 'Unattributed') return 'Organic';
  return ms;
}

// Double exponential fit: f(t) = a1 * exp(-l1*(t-1)) + (1-a1) * exp(-l2*(t-1))
function fitDoubleExp(cumRatios) {
  // cumRatios: array of { d, ratio } where ratio = cumRevenue(d) / cumRevenue(1)
  // We fit the cumulative ratio curve
  let bestRMSE = Infinity, bestParams = null;
  
  // Grid search
  for (let a1 = 0.1; a1 <= 0.95; a1 += 0.05) {
    for (let l1 = 0.01; l1 <= 1.0; l1 += 0.02) {
      for (let l2 = 0.001; l2 <= 0.3; l2 += 0.005) {
        if (l2 >= l1) continue; // l1 > l2 (fast + slow decay)
        let sse = 0;
        for (const { d, ratio } of cumRatios) {
          // Predicted cumulative at day d = sum_{t=1}^{d} of [a1*e^{-l1*(t-1)} + (1-a1)*e^{-l2*(t-1)}]
          let pred = 0;
          for (let t = 1; t <= d; t++) {
            pred += a1 * Math.exp(-l1 * (t - 1)) + (1 - a1) * Math.exp(-l2 * (t - 1));
          }
          // Normalize: pred at d=1 = 1.0
          const predNorm = pred; // at d=1, pred = a1 + (1-a1) = 1.0 ✓
          sse += (predNorm - ratio) ** 2;
        }
        const rmse = Math.sqrt(sse / cumRatios.length);
        if (rmse < bestRMSE) {
          bestRMSE = rmse;
          bestParams = { a1, l1, l2 };
        }
      }
    }
  }
  
  if (!bestParams) return null;
  
  // Calculate D30 multiplier
  let d30sum = 0;
  for (let t = 1; t <= 30; t++) {
    d30sum += bestParams.a1 * Math.exp(-bestParams.l1 * (t - 1)) + (1 - bestParams.a1) * Math.exp(-bestParams.l2 * (t - 1));
  }
  
  return { ...bestParams, d30: d30sum, rmse: bestRMSE };
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' ORDER BY name").all().map(r => r.name);
  
  const APP_ID = '6746466099'; // Luma
  const CUTOFF_INSTALL = new Date('2026-05-10T00:00:00+08:00').getTime() / 1000; // Unix seconds
  
  // Collect all ad_purchase records for Luma
  // Group by channel, then by (install_day, event_day) to get daily revenue cohorts
  const channelData = {}; // channel -> { installDay -> { eventDayOffset -> revenue } }
  
  for (const table of tables) {
    const rows = db.prepare(`
      SELECT event_time, install_time, revenue, media_source
      FROM ${table}
      WHERE event_name = 'ad_purchase'
        AND app_id = ?
        AND CAST(install_time AS INTEGER) >= ?
    `).all(APP_ID, CUTOFF_INSTALL);
    
    for (const row of rows) {
      const evtTs = parseInt(row.event_time);
      const instTs = parseInt(row.install_time);
      if (isNaN(evtTs) || isNaN(instTs) || instTs < CUTOFF_INSTALL) continue;
      
      const rev = parseFloat(row.revenue) || 0;
      if (rev <= 0) continue;
      
      const channel = classifyChannel(row.media_source);
      
      // Convert to Beijing time days
      const instDay = Math.floor((instTs + 8 * 3600) / 86400);
      const evtDay = Math.floor((evtTs + 8 * 3600) / 86400);
      const dayOffset = evtDay - instDay; // D0, D1, D2, ...
      
      if (dayOffset < 0 || dayOffset > 60) continue;
      
      if (!channelData[channel]) channelData[channel] = {};
      if (!channelData[channel][instDay]) channelData[channel][instDay] = {};
      channelData[channel][instDay][dayOffset] = (channelData[channel][instDay][dayOffset] || 0) + rev;
    }
  }
  
  // Also collect all-channel combined
  const allChannel = {};
  for (const [ch, data] of Object.entries(channelData)) {
    if (ch === 'Organic') continue; // skip organic for "全渠道"
    for (const [instDay, offsets] of Object.entries(data)) {
      if (!allChannel[instDay]) allChannel[instDay] = {};
      for (const [d, rev] of Object.entries(offsets)) {
        allChannel[instDay][d] = (allChannel[instDay][d] || 0) + rev;
      }
    }
  }
  channelData['全渠道(付费)'] = allChannel;
  
  console.log('产品 | 渠道 | D30倍数 | 付费记录 | D1天数 | 数据点 | 最大D | RMSE');
  console.log('--- | --- | --- | --- | --- | --- | --- | ---');
  
  const channelOrder = ['全渠道(付费)', 'FB', 'FB W2A', 'TT', 'Organic'];
  
  for (const channel of channelOrder) {
    const data = channelData[channel];
    if (!data) continue;
    
    // Build cumulative ratio curve
    const installDays = Object.keys(data).map(Number).sort();
    const today = Math.floor((Date.now() / 1000 + 8 * 3600) / 86400);
    
    // For each day offset d, sum revenue across all install cohorts that have at least d days of history
    const dayRevenue = {}; // d -> { total, cohortCount }
    
    for (const instDay of installDays) {
      const maxD = today - instDay - 1; // max observable day offset
      const offsets = data[instDay];
      
      for (const [dStr, rev] of Object.entries(offsets)) {
        const d = parseInt(dStr);
        if (d > maxD) continue;
        if (!dayRevenue[d]) dayRevenue[d] = { total: 0, cohorts: 0 };
        dayRevenue[d].total += rev;
      }
    }
    
    // Count cohorts per day offset
    for (const instDay of installDays) {
      const maxD = today - instDay - 1;
      for (let d = 0; d <= Math.min(maxD, 60); d++) {
        if (!dayRevenue[d]) dayRevenue[d] = { total: 0, cohorts: 0 };
        dayRevenue[d].cohorts++;
      }
    }
    
    if (!dayRevenue[0] || dayRevenue[0].total === 0) continue;
    
    // Build cumulative ratios (normalized to D0 revenue = 1.0)
    const d0Rev = dayRevenue[0].total;
    let cumRev = 0;
    const cumRatios = [];
    const days = Object.keys(dayRevenue).map(Number).sort((a, b) => a - b);
    
    let totalPurchases = 0;
    for (const d of days) totalPurchases += dayRevenue[d].total > 0 ? Math.round(dayRevenue[d].total / 3.99) : 0; // rough count
    
    let maxD = 0;
    for (const d of days) {
      cumRev += dayRevenue[d].total / dayRevenue[d].cohorts; // average daily revenue per cohort
      if (d === 0) {
        // D1 (first day) reference
        continue;
      }
      maxD = d;
    }
    
    // Recalculate properly: cumulative ratio curve
    // ratio(d) = cumSum(avgDailyRev[0..d]) / avgDailyRev[0]
    const avgDaily = {};
    for (const d of days) {
      avgDaily[d] = dayRevenue[d].total / dayRevenue[d].cohorts;
    }
    
    let cum = 0;
    const d0Avg = avgDaily[0] || 0;
    if (d0Avg === 0) continue;
    
    const ratios = [];
    for (const d of days) {
      cum += avgDaily[d];
      ratios.push({ d: d + 1, ratio: cum / d0Avg }); // d+1 because D1 = first day
    }
    
    if (ratios.length < 3) continue;
    
    const fit = fitDoubleExp(ratios.slice(0, 30)); // fit on first 30 points max
    if (!fit) continue;
    
    const d1Days = dayRevenue[0].cohorts;
    const purchaseCount = days.reduce((s, d) => s + (dayRevenue[d].total > 0 ? 1 : 0), 0);
    const totalRecords = Object.values(dayRevenue).reduce((s, v) => s + Math.ceil(v.total), 0);
    
    console.log(`Luma | ${channel} | ${fit.d30.toFixed(2)} | ${totalRecords} | ${d1Days} | ${ratios.length} | D${maxD} | ${fit.rmse.toFixed(4)}`);
  }
  
  db.close();
}

main();
