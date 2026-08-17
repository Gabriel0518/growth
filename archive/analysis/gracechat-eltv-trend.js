#!/usr/bin/env node
/**
 * GraceChat eLTV 倍数趋势分析
 * 
 * 目的：按时间递增模拟"截止到某月"的数据，观察 D3/D7/D30/D90/D180 倍数变化。
 * 验证假设：GraceChat 新用户少、老用户多→倍数虚高。
 */

const sqlite3 = require('../dashboard/node_modules/better-sqlite3');
const path = require('path');

const DB_PATH = '/home/admin/dataserver/data.db';
const APP_ID = 'id1658972379'; // GraceChat

// ── Triple exponential fit (same as server.js) ──
function fitTripleExp(xArr, yArr) {
  const N = xArr.length;
  let p = [0.73, 0.24, 3.0, 0.31, 0.022];

  function f(t, p) {
    const [a1, a2, l1, l2, l3] = p;
    const a3 = 1 - a1 - a2;
    return a1 * Math.exp(-l1 * (t - 1)) + a2 * Math.exp(-l2 * (t - 1)) + a3 * Math.exp(-l3 * (t - 1));
  }

  function loss(p) {
    let s = 0;
    for (let i = 0; i < N; i++) {
      const r = yArr[i] - f(xArr[i], p);
      s += r * r;
    }
    return s;
  }

  let lr = 1e-4;
  const bounds = [[0.3, 0.95], [0.05, 0.6], [1.0, 15.0], [0.05, 2.0], [0.001, 0.1]];

  for (let iter = 0; iter < 50000; iter++) {
    const eps = 1e-6;
    const grad = p.map((pi, i) => {
      const pp = [...p]; pp[i] += eps;
      const pm = [...p]; pm[i] -= eps;
      return (loss(pp) - loss(pm)) / (2 * eps);
    });
    const newP = p.map((pi, i) => {
      let v = pi - lr * grad[i];
      v = Math.max(bounds[i][0], Math.min(bounds[i][1], v));
      return v;
    });
    if (loss(newP) < loss(p)) { p = newP; lr *= 1.05; }
    else { lr *= 0.5; }
    if (lr < 1e-12) break;
  }
  return p;
}

function computeLtv(params, days) {
  const [a1, a2, l1, l2, l3] = params;
  const a3 = 1 - a1 - a2;
  let ltv = 0;
  for (let d = 1; d <= days; d++) {
    ltv += a1 * Math.exp(-l1 * (d - 1)) + a2 * Math.exp(-l2 * (d - 1)) + a3 * Math.exp(-l3 * (d - 1));
  }
  return ltv;
}

// ── Main ──
const db = new sqlite3(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('journal_mode = WAL');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' ORDER BY name").all().map(r => r.name);

console.log(`=== GraceChat eLTV 倍数趋势分析 ===`);
console.log(`App ID: ${APP_ID}`);
console.log(`可用月表: ${tables.join(', ')}`);
console.log();

// Collect ALL rows from all tables for GraceChat
const allRows = [];
for (const table of tables) {
  const rows = db.prepare(`
    SELECT event_time, install_time, revenue
    FROM ${table}
    WHERE app_id=? AND event_name='af_purchase'
      AND install_time IS NOT NULL AND install_time != ''
      AND revenue > 0
  `).all(APP_ID);
  allRows.push(...rows);
}

console.log(`总付费记录数: ${allRows.length}`);

// Parse and tag each row with install month
const parsed = [];
for (const row of allRows) {
  const et = new Date(row.event_time.replace(' ', 'T') + 'Z');
  const it = new Date(row.install_time.replace(' ', 'T') + 'Z');
  if (isNaN(et) || isNaN(it)) continue;
  const diffH = (et - it) / 3600000;
  if (diffH < 0) continue;
  const d = Math.floor(diffH / 24) + 1;
  const installDate = row.install_time.slice(0, 10);
  const installMonth = row.install_time.slice(0, 7);
  parsed.push({ d, revenue: row.revenue, installDate, installMonth });
}

console.log(`有效记录数: ${parsed.length}`);

// Get unique install months sorted
const installMonths = [...new Set(parsed.map(r => r.installMonth))].sort();
console.log(`安装月份范围: ${installMonths[0]} ~ ${installMonths[installMonths.length - 1]}`);
console.log();

// ── Analysis 1: 逐月累积看 eLTV 倍数变化 ──
console.log('=== 分析 1：逐月累积 eLTV 倍数 ===');
console.log('（每次多加入一个月的安装用户数据，重新拟合）');
console.log();
console.log(pad('截止月', 10) + pad('记录数', 8) + pad('D1天数', 8) + pad('D3', 8) + pad('D7', 8) + pad('D30', 10) + pad('D90', 10) + pad('D180', 10));
console.log('-'.repeat(72));

for (let cutoffIdx = 0; cutoffIdx < installMonths.length; cutoffIdx++) {
  const cutoffMonth = installMonths[cutoffIdx];
  // Include all records where install month <= cutoffMonth
  const subset = parsed.filter(r => r.installMonth <= cutoffMonth);
  
  const dayRevenue = {};
  const dayCohorts = {};
  for (const r of subset) {
    dayRevenue[r.d] = (dayRevenue[r.d] || 0) + r.revenue;
    if (!dayCohorts[r.d]) dayCohorts[r.d] = new Set();
    dayCohorts[r.d].add(r.installDate);
  }

  if (!dayRevenue[1] || !dayCohorts[1]) {
    console.log(pad(cutoffMonth, 10) + pad(subset.length, 8) + '  (no D1 data)');
    continue;
  }

  const d1PerCohort = dayRevenue[1] / dayCohorts[1].size;
  const xArr = [], yArr = [];
  for (let d = 1; d <= 220; d++) {
    if (!dayCohorts[d] || dayCohorts[d].size === 0) continue;
    const norm = (dayRevenue[d] / dayCohorts[d].size) / d1PerCohort;
    xArr.push(d);
    yArr.push(norm);
  }

  const params = fitTripleExp(xArr, yArr);
  const d3 = computeLtv(params, 3);
  const d7 = computeLtv(params, 7);
  const d30 = computeLtv(params, 30);
  const d90 = computeLtv(params, 90);
  const d180 = computeLtv(params, 180);
  const d1Span = dayCohorts[1].size;

  console.log(
    pad(cutoffMonth, 10) +
    pad(subset.length, 8) +
    pad(d1Span, 8) +
    pad(d3.toFixed(2), 8) +
    pad(d7.toFixed(2), 8) +
    pad(d30.toFixed(2), 10) +
    pad(d90.toFixed(2), 10) +
    pad(d180.toFixed(2), 10)
  );
}

// ── Analysis 2: 每个月单独看 eLTV ──
console.log();
console.log('=== 分析 2：单月安装用户的 eLTV 倍数 ===');
console.log('（只看某月安装的用户的后续付费数据）');
console.log();
console.log(pad('安装月', 10) + pad('记录数', 8) + pad('D1天数', 8) + pad('最大D', 8) + pad('D3', 8) + pad('D7', 8) + pad('D30', 10) + pad('D90', 10) + pad('D180', 10));
console.log('-'.repeat(80));

for (const month of installMonths) {
  const subset = parsed.filter(r => r.installMonth === month);
  
  const dayRevenue = {};
  const dayCohorts = {};
  for (const r of subset) {
    dayRevenue[r.d] = (dayRevenue[r.d] || 0) + r.revenue;
    if (!dayCohorts[r.d]) dayCohorts[r.d] = new Set();
    dayCohorts[r.d].add(r.installDate);
  }

  if (!dayRevenue[1] || !dayCohorts[1]) {
    console.log(pad(month, 10) + pad(subset.length, 8) + '  (no D1 data)');
    continue;
  }

  const maxD = Math.max(...Object.keys(dayRevenue).map(Number));
  const d1PerCohort = dayRevenue[1] / dayCohorts[1].size;
  const xArr = [], yArr = [];
  for (let d = 1; d <= 220; d++) {
    if (!dayCohorts[d] || dayCohorts[d].size === 0) continue;
    const norm = (dayRevenue[d] / dayCohorts[d].size) / d1PerCohort;
    xArr.push(d);
    yArr.push(norm);
  }

  const params = fitTripleExp(xArr, yArr);
  const d3 = computeLtv(params, 3);
  const d7 = computeLtv(params, 7);
  const d30 = computeLtv(params, 30);
  const d90 = computeLtv(params, 90);
  const d180 = computeLtv(params, 180);
  const d1Span = dayCohorts[1].size;

  console.log(
    pad(month, 10) +
    pad(subset.length, 8) +
    pad(d1Span, 8) +
    pad(maxD, 8) +
    pad(d3.toFixed(2), 8) +
    pad(d7.toFixed(2), 8) +
    pad(d30.toFixed(2), 10) +
    pad(d90.toFixed(2), 10) +
    pad(d180.toFixed(2), 10)
  );
}

// ── Analysis 3: D1 cohort composition (new vs old users) ──
console.log();
console.log('=== 分析 3：各天 cohort 组成 ===');
console.log('（看 D1 vs D30 vs D90 vs D180 的 cohort 数和每 cohort 收入）');
console.log();

const dayRevenue = {};
const dayCohorts = {};
for (const r of parsed) {
  dayRevenue[r.d] = (dayRevenue[r.d] || 0) + r.revenue;
  if (!dayCohorts[r.d]) dayCohorts[r.d] = new Set();
  dayCohorts[r.d].add(r.installDate);
}

console.log(pad('Day', 6) + pad('Cohorts', 10) + pad('Revenue', 12) + pad('Rev/Cohort', 12) + pad('Norm', 8));
console.log('-'.repeat(48));
const d1Rev = dayRevenue[1] || 1;
const d1Coh = dayCohorts[1] ? dayCohorts[1].size : 1;
const d1PerCoh = d1Rev / d1Coh;

for (const d of [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 120, 150, 180]) {
  if (!dayCohorts[d]) continue;
  const cohorts = dayCohorts[d].size;
  const rev = dayRevenue[d] || 0;
  const revPerCohort = rev / cohorts;
  const norm = revPerCohort / d1PerCoh;
  console.log(
    pad(d, 6) +
    pad(cohorts, 10) +
    pad('$' + rev.toFixed(2), 12) +
    pad('$' + revPerCohort.toFixed(2), 12) +
    pad(norm.toFixed(4), 8)
  );
}

// Show install date distribution
console.log();
console.log('=== 分析 4：安装日期分布（每月新装机用户的D1付费数）===');
const d1Cohorts = dayCohorts[1];
if (d1Cohorts) {
  const monthDist = {};
  for (const installDate of d1Cohorts) {
    const m = installDate.slice(0, 7);
    monthDist[m] = (monthDist[m] || 0) + 1;
  }
  const months = Object.keys(monthDist).sort();
  for (const m of months) {
    console.log(`  ${m}: ${monthDist[m]} 天有 D1 付费`);
  }
}

db.close();

function pad(v, w) { const s = String(v); return s + ' '.repeat(Math.max(0, w - s.length)); }
