#!/usr/bin/env node
/**
 * eLTV multiplier analysis by Product × Channel
 * Same methodology as server.js: double exponential fit, D30 undiscounted, new users only (>= 2026-05-10)
 */

const Database = require('/home/admin/.openclaw/workspace/dashboard/node_modules/better-sqlite3');
const path = require('path');

const DB_PATH = '/home/admin/dataserver/data.db';
const ELTV_INSTALL_CUTOFF = '2026-05-10';

const LTV_APP_IDS = {
  'id6746109957': 'Dora iOS',
  'id6746782904': 'Romi iOS',
  'id6746466099': 'Luma',
  'id1658972379': 'GraceChat',
  'com.doramatch.app': 'Dora And',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
};

const CHANNEL_MAP = {
  'Facebook Ads': 'FB',
  'googleadwords_int': 'GG',
  'tiktokglobal_int': 'TT',
  'organic': 'Organic',
  'restricted': 'Restricted',
  'Social_facebook': 'FB(Social)',
};

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

function computeD30Ltv(params) {
  const [a1, l1, l2] = params;
  const a2 = 1 - a1;
  let ltv = 0;
  for (let d = 1; d <= 30; d++) {
    ltv += a1 * Math.exp(-l1 * (d - 1)) + a2 * Math.exp(-l2 * (d - 1));
  }
  return ltv;
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' AND name >= 'records_202605' ORDER BY name").all().map(r => r.name);

  // Collect data: { appId: { mediaSource: { dayRevenue, dayCohorts, totalRecords } } }
  const data = {};

  for (const table of tables) {
    console.error(`Scanning ${table}...`);
    const stmt = db.prepare(`
      SELECT app_id, media_source, event_time, install_time, revenue
      FROM ${table}
      WHERE event_name='af_purchase'
        AND install_time >= ?
        AND revenue > 0
        AND media_source IS NOT NULL AND media_source != ''
    `);

    for (const row of stmt.iterate(ELTV_INSTALL_CUTOFF)) {
      const appId = row.app_id;
      const ms = row.media_source;
      if (!LTV_APP_IDS[appId]) continue;

      if (!data[appId]) data[appId] = {};
      if (!data[appId][ms]) data[appId][ms] = { dayRevenue: {}, dayCohorts: {}, totalRecords: 0 };
      // Also aggregate "ALL" for comparison
      if (!data[appId]['__ALL__']) data[appId]['__ALL__'] = { dayRevenue: {}, dayCohorts: {}, totalRecords: 0 };

      const installDate = row.install_time.slice(0, 10);
      const et = new Date(row.event_time.replace(' ', 'T') + 'Z');
      const it = new Date(row.install_time.replace(' ', 'T') + 'Z');
      if (isNaN(et) || isNaN(it)) continue;
      const diffH = (et - it) / 3600000;
      if (diffH < 0) continue;
      const d = Math.floor(diffH / 24) + 1;

      for (const key of [ms, '__ALL__']) {
        const entry = data[appId][key];
        entry.totalRecords++;
        entry.dayRevenue[d] = (entry.dayRevenue[d] || 0) + row.revenue;
        if (!entry.dayCohorts[d]) entry.dayCohorts[d] = new Set();
        entry.dayCohorts[d].add(installDate);
      }
    }
  }

  // Compute eLTV for each product × channel
  const results = [];

  for (const [appId, channels] of Object.entries(data)) {
    const product = LTV_APP_IDS[appId];
    for (const [ms, entry] of Object.entries(channels)) {
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
      const d30 = computeD30Ltv(params);
      const channelName = ms === '__ALL__' ? '全渠道' : (CHANNEL_MAP[ms] || ms);
      const d1Span = dayCohorts[1].size;

      results.push({
        product,
        channel: channelName,
        d30: Math.round(d30 * 100) / 100,
        records: totalRecords,
        d1Span,
        dataPoints: xArr.length,
        maxDay: Math.max(...xArr),
        rmse: Math.round(rmse * 10000) / 10000,
      });
    }
  }

  // Sort by product then channel
  results.sort((a, b) => {
    if (a.product !== b.product) return a.product.localeCompare(b.product);
    if (a.channel === '全渠道') return -1;
    if (b.channel === '全渠道') return 1;
    return b.records - a.records;
  });

  // Output
  console.log('产品 | 渠道 | D30倍数 | 付费记录 | D1天数 | 数据点 | 最大D | RMSE');
  console.log('--- | --- | --- | --- | --- | --- | --- | ---');
  for (const r of results) {
    console.log(`${r.product} | ${r.channel} | ${r.d30} | ${r.records} | ${r.d1Span} | ${r.dataPoints} | D${r.maxDay} | ${r.rmse}`);
  }

  db.close();
}

main();
