#!/usr/bin/env node
/**
 * eLTV by channel — unified script for AF and AD products
 * Methodology: identical to server.js (double exponential fit on daily revenue decay, D30 undiscounted)
 * 
 * AF products: event_time/install_time are ISO strings (UTC)
 * AD products: event_time/install_time are Unix timestamps (seconds)
 * 
 * Usage: NODE_PATH=dashboard/node_modules node scripts/eltv-by-channel-unified.js [af|ad|all]
 */

const Database = require('better-sqlite3');
const DB_PATH = '/home/admin/dataserver/data.db';
const ELTV_INSTALL_CUTOFF_ISO = '2026-05-10';
const ELTV_INSTALL_CUTOFF_TS = new Date('2026-05-10T00:00:00+08:00').getTime() / 1000;

const LTV_APP_IDS = {
  // AF (iOS with id prefix + Android)
  'id6746109957': 'Dora iOS', 'id6746782904': 'Romi iOS', 'id6746466099': 'Luma',
  'id1658972379': 'GraceChat', 'com.doramatch.app': 'Dora And', 'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni', 'com.romiandroid.appmatch': 'Romi And', 'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
  // AD (Adjust — numeric app_id)
  '6746466099': 'Luma', '6746109957': 'Dora iOS', '6746782904': 'Romi iOS', '1658972379': 'GraceChat',
};

// Channel classification
function classifyChannel(mediaSource, platform) {
  if (!mediaSource) return 'Unknown';
  const s = mediaSource.replace(/\+/g, ' ');
  if (platform === 'af') {
    // AF media_source values
    if (s === 'Facebook Ads' || s === 'Facebook Installs' || s === 'Instagram Installs' ||
        s === 'Off-Facebook Installs' || s === 'Social_facebook' || s === 'facebook') return 'FB';
    if (s.includes('W2A') || s.includes('web') || s === 'Facebook web') return 'FB W2A';
    if (s === 'googleadwords_int' || s === 'Google Ads ACI') return 'GG';
    if (s === 'tiktokglobal_int' || s === 'TikTok SAN') return 'TT';
    if (s === 'organic' || s === 'Organic' || s === 'restricted' || s === 'Unattributed') return 'Organic';
  } else {
    // AD (Adjust) media_source values
    if (s.includes('Facebook') || s.includes('Instagram') || s.includes('Off-Facebook')) return 'FB';
    if (s.includes('W2A') || s.includes('web')) return 'FB W2A';
    if (s.includes('TikTok')) return 'TT';
    if (s === 'Organic' || s === 'Unattributed' || s === 'Untrusted Devices') return 'Organic';
  }
  return mediaSource;
}

// ── Fitting: same as server.js ──
function fitDoubleExp(xArr, yArr) {
  const N = xArr.length;
  function f(t, p) {
    const [a1, l1, l2] = p;
    return a1 * Math.exp(-l1 * (t - 1)) + (1 - a1) * Math.exp(-l2 * (t - 1));
  }
  function loss(p) {
    let s = 0;
    for (let i = 0; i < N; i++) { const r = yArr[i] - f(xArr[i], p); s += r * r; }
    return s;
  }
  let p = [0.75, 2.0, 0.05];
  let lr = 1e-4;
  const bounds = [[0.3, 0.95], [0.5, 15.0], [0.005, 0.5]];
  for (let iter = 0; iter < 50000; iter++) {
    const eps = 1e-6;
    const grad = p.map((_, i) => {
      const pp = [...p]; pp[i] += eps;
      const pm = [...p]; pm[i] -= eps;
      return (loss(pp) - loss(pm)) / (2 * eps);
    });
    const newP = p.map((pi, i) => Math.max(bounds[i][0], Math.min(bounds[i][1], pi - lr * grad[i])));
    if (loss(newP) < loss(p)) { p = newP; lr *= 1.05; } else { lr *= 0.5; }
    if (lr < 1e-12) break;
  }
  return { params: p, rmse: Math.sqrt(loss(p) / N) };
}

function computeD30(params) {
  const [a1, l1, l2] = params;
  let s = 0;
  for (let d = 1; d <= 30; d++) s += a1 * Math.exp(-l1 * (d - 1)) + (1 - a1) * Math.exp(-l2 * (d - 1));
  return s;
}

// ── Parse day offset (D1 = install day) ──
function getInstallDate_AF(installTime) {
  // ISO string like "2026-05-10 12:34:56.789" — this is UTC, convert to Beijing
  const d = new Date(installTime.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return null;
  const bj = new Date(d.getTime() + 8 * 3600000);
  return bj.toISOString().slice(0, 10);
}
function getDayDiff_AF(installTime, eventTime) {
  const it = new Date(installTime.replace(' ', 'T') + 'Z');
  const et = new Date(eventTime.replace(' ', 'T') + 'Z');
  if (isNaN(it) || isNaN(et)) return null;
  const diffH = (et - it) / 3600000;
  if (diffH < 0) return null;
  return Math.floor(diffH / 24) + 1; // D1 = first 24h
}

function getInstallDate_AD(installTimestamp) {
  const ts = parseInt(installTimestamp);
  if (isNaN(ts)) return null;
  const bj = new Date((ts + 8 * 3600) * 1000);
  return bj.toISOString().slice(0, 10);
}
function getDayDiff_AD(installTimestamp, eventTimestamp) {
  const it = parseInt(installTimestamp);
  const et = parseInt(eventTimestamp);
  if (isNaN(it) || isNaN(et)) return null;
  const diffH = (et - it) / 3600;
  if (diffH < 0) return null;
  return Math.floor(diffH / 24) + 1; // D1 = first 24h
}

function main() {
  const mode = process.argv[2] || 'all'; // af | ad | all
  const filterProduct = process.argv[3] || ''; // optional product name filter

  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' AND name >= 'records_202605' ORDER BY name").all().map(r => r.name);

  // data[product][channel] = { dayRevenue: { d: total }, dayCohorts: { d: Set<installDate> }, totalRecords: n }
  const data = {};

  function addRecord(product, channel, d, installDate, revenue) {
    if (!data[product]) data[product] = {};
    for (const ch of [channel, '__ALL__']) {
      if (!data[product][ch]) data[product][ch] = { dayRevenue: {}, dayCohorts: {}, totalRecords: 0 };
      const entry = data[product][ch];
      entry.totalRecords++;
      entry.dayRevenue[d] = (entry.dayRevenue[d] || 0) + revenue;
      if (!entry.dayCohorts[d]) entry.dayCohorts[d] = new Set();
      entry.dayCohorts[d].add(installDate);
    }
  }

  for (const table of tables) {
    console.error(`Scanning ${table}...`);

    // AF data
    if (mode === 'af' || mode === 'all') {
      const afStmt = db.prepare(`
        SELECT app_id, media_source, event_time, install_time, revenue
        FROM ${table}
        WHERE event_name = 'af_purchase'
          AND install_time >= ?
          AND revenue > 0
          AND media_source IS NOT NULL AND media_source != ''
      `);
      for (const row of afStmt.iterate(ELTV_INSTALL_CUTOFF_ISO)) {
        const product = LTV_APP_IDS[row.app_id];
        if (!product) continue;
        if (filterProduct && product !== filterProduct) continue;
        const d = getDayDiff_AF(row.install_time, row.event_time);
        if (!d || d > 60) continue;
        const installDate = getInstallDate_AF(row.install_time);
        if (!installDate) continue;
        const channel = classifyChannel(row.media_source, 'af');
        addRecord(product, channel, d, installDate, row.revenue);
      }
    }

    // AD data
    if (mode === 'ad' || mode === 'all') {
      const adStmt = db.prepare(`
        SELECT app_id, media_source, event_time, install_time, revenue
        FROM ${table}
        WHERE event_name = 'ad_purchase'
          AND CAST(install_time AS INTEGER) >= ?
          AND revenue > 0
          AND media_source IS NOT NULL AND media_source != ''
      `);
      for (const row of adStmt.iterate(ELTV_INSTALL_CUTOFF_TS)) {
        const product = LTV_APP_IDS[row.app_id];
        if (!product) continue;
        if (filterProduct && product !== filterProduct) continue;
        const d = getDayDiff_AD(row.install_time, row.event_time);
        if (!d || d > 60) continue;
        const installDate = getInstallDate_AD(row.install_time);
        if (!installDate) continue;
        const channel = classifyChannel(row.media_source, 'ad');
        addRecord(product, channel, d, installDate, row.revenue);
      }
    }
  }

  // Fit and output
  const results = [];

  for (const [product, channels] of Object.entries(data)) {
    for (const [ch, entry] of Object.entries(channels)) {
      const { dayRevenue, dayCohorts, totalRecords } = entry;
      if (!dayRevenue[1] || !dayCohorts[1] || dayCohorts[1].size < 3) continue;

      const d1PerCohort = dayRevenue[1] / dayCohorts[1].size;
      const xArr = [], yArr = [];
      for (let d = 1; d <= 220; d++) {
        if (!dayCohorts[d] || dayCohorts[d].size === 0) continue;
        const norm = (dayRevenue[d] / dayCohorts[d].size) / d1PerCohort;
        xArr.push(d);
        yArr.push(norm);
      }
      if (xArr.length < 3) continue;

      const { params, rmse } = fitDoubleExp(xArr, yArr);
      const d30 = computeD30(params);
      const channelName = ch === '__ALL__' ? '全渠道' : ch;

      results.push({
        product, channel: channelName,
        d30: Math.round(d30 * 100) / 100,
        records: totalRecords, d1Span: dayCohorts[1].size,
        dataPoints: xArr.length, maxDay: Math.max(...xArr),
        rmse: Math.round(rmse * 10000) / 10000,
      });
    }
  }

  results.sort((a, b) => {
    if (a.product !== b.product) return a.product.localeCompare(b.product);
    if (a.channel === '全渠道') return -1;
    if (b.channel === '全渠道') return 1;
    return b.records - a.records;
  });

  console.log('产品 | 渠道 | D30倍数 | 付费记录 | D1天数 | 数据点 | 最大D | RMSE');
  console.log('--- | --- | --- | --- | --- | --- | --- | ---');
  for (const r of results) {
    console.log(`${r.product} | ${r.channel} | ${r.d30} | ${r.records} | ${r.d1Span} | ${r.dataPoints} | D${r.maxDay} | ${r.rmse}`);
  }

  db.close();
}

main();
