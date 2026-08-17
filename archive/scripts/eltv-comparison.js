#!/usr/bin/env node
/**
 * eLTV comparison: triple-exp vs double-exp, D30 vs D180
 * Uses the same data pipeline as the dashboard eLTV calculator
 */

const path = require('path');
const sqlite3 = require(path.join(__dirname, '..', 'dashboard', 'node_modules', 'better-sqlite3'));

const DB_PATH = '/home/admin/dataserver/data.db';
const ELTV_INSTALL_CUTOFF = '2026-05-10';
const DISCOUNT_RATE = 0.01;

const LTV_APP_IDS = {
  'id6746109957': 'Dora iOS',
  'id6746782904': 'Romi iOS',
  'id6746466099': 'Luma',
  'id1658972379': 'GraceChat',
  'com.doramatch.app': 'Dora And',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.meraki.kira': 'Kira And',
  'com.romiandroid.appmatch': 'Romi And',
  'com.cavalier.nalo': 'Nalo And',
};

// ── Triple exponential: f(t) = a1*e^{-l1*(t-1)} + a2*e^{-l2*(t-1)} + a3*e^{-l3*(t-1)}, a3=1-a1-a2 ──
function fitTripleExp(xArr, yArr) {
  const N = xArr.length;
  function f(t, p) {
    const [a1, a2, l1, l2, l3] = p;
    const a3 = 1 - a1 - a2;
    return a1 * Math.exp(-l1 * (t - 1)) + a2 * Math.exp(-l2 * (t - 1)) + a3 * Math.exp(-l3 * (t - 1));
  }
  function loss(p) {
    let s = 0;
    for (let i = 0; i < N; i++) { const r = yArr[i] - f(xArr[i], p); s += r * r; }
    return s;
  }
  let p = [0.73, 0.24, 3.0, 0.31, 0.022];
  let lr = 1e-4;
  const bounds = [[0.3, 0.95], [0.05, 0.6], [1.0, 15.0], [0.05, 2.0], [0.001, 0.1]];
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
  return p;
}

// ── Double exponential: f(t) = a1*e^{-l1*(t-1)} + a2*e^{-l2*(t-1)}, a2=1-a1 ──
function fitDoubleExp(xArr, yArr) {
  const N = xArr.length;
  function f(t, p) {
    const [a1, l1, l2] = p;
    const a2 = 1 - a1;
    return a1 * Math.exp(-l1 * (t - 1)) + a2 * Math.exp(-l2 * (t - 1));
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
  return p;
}

// ── Compute eLTV multiplier for given params and horizon ──
function computeLtv(params, horizon, discountRate, isDouble) {
  let ltv = 0;
  for (let d = 1; d <= horizon; d++) {
    let dayRev;
    if (isDouble) {
      const [a1, l1, l2] = params;
      const a2 = 1 - a1;
      dayRev = a1 * Math.exp(-l1 * (d - 1)) + a2 * Math.exp(-l2 * (d - 1));
    } else {
      const [a1, a2, l1, l2, l3] = params;
      const a3 = 1 - a1 - a2;
      dayRev = a1 * Math.exp(-l1 * (d - 1)) + a2 * Math.exp(-l2 * (d - 1)) + a3 * Math.exp(-l3 * (d - 1));
    }
    if (discountRate > 0) {
      ltv += dayRev / Math.pow(1 + discountRate, d - 1);
    } else {
      ltv += dayRev;
    }
  }
  return ltv;
}

// ── Main ──
function main() {
  const db = new sqlite3(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');

  // Only scan tables from May 2026 onwards (cutoff is 2026-05-10)
  const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' AND name >= 'records_202605' ORDER BY name").all().map(r => r.name);

  const results = [];

  for (const [appId, product] of Object.entries(LTV_APP_IDS)) {
    process.stderr.write(`Processing ${product}...`);
    const dayRevenue = {};
    const dayCohorts = {};
    let totalRecords = 0;

        for (const table of allTables) {
      const stmt = db.prepare(`
        SELECT event_time, install_time, revenue
        FROM ${table}
        WHERE app_id=? AND event_name='af_purchase'
          AND install_time >= ?
          AND revenue > 0
      `);
      for (const row of stmt.iterate(appId, ELTV_INSTALL_CUTOFF)) {
        const installDate = row.install_time.slice(0, 10);
        if (installDate < ELTV_INSTALL_CUTOFF) continue;
        const et = new Date(row.event_time.replace(' ', 'T') + 'Z');
        const it = new Date(row.install_time.replace(' ', 'T') + 'Z');
        if (isNaN(et) || isNaN(it)) continue;
        const diffH = (et - it) / 3600000;
        if (diffH < 0) continue;
        totalRecords++;
        const d = Math.floor(diffH / 24) + 1;
        dayRevenue[d] = (dayRevenue[d] || 0) + row.revenue;
        if (!dayCohorts[d]) dayCohorts[d] = new Set();
        dayCohorts[d].add(installDate);
      }
    }

    if (!dayRevenue[1] || !dayCohorts[1]) {
      results.push({ product, records: totalRecords, maxD: 0, tri_d180: null, tri_d30: null, dbl_d180: null, dbl_d30: null });
      continue;
    }

    const d1PerCohort = dayRevenue[1] / dayCohorts[1].size;
    const xArr = [], yArr = [];
    let maxD = 0;
    for (let d = 1; d <= 220; d++) {
      if (!dayCohorts[d] || dayCohorts[d].size === 0) continue;
      const norm = (dayRevenue[d] / dayCohorts[d].size) / d1PerCohort;
      xArr.push(d);
      yArr.push(norm);
      maxD = d;
    }

    const d1Span = dayCohorts[1] ? dayCohorts[1].size : 0;
    process.stderr.write(` ${totalRecords} records, maxD=${maxD}, fitting...`);

    // Triple exponential fit
    const triParams = fitTripleExp(xArr, yArr);
    const tri_d180 = computeLtv(triParams, 180, DISCOUNT_RATE, false);
    const tri_d30 = computeLtv(triParams, 30, 0, false);

    // Double exponential fit
    const dblParams = fitDoubleExp(xArr, yArr);
    const dbl_d180 = computeLtv(dblParams, 180, DISCOUNT_RATE, true);
    const dbl_d30 = computeLtv(dblParams, 30, 0, true);

    // Fit quality (RMSE)
    function rmse(params, isDouble) {
      let s = 0;
      for (let i = 0; i < xArr.length; i++) {
        let pred;
        if (isDouble) {
          const [a1, l1, l2] = params;
          const a2 = 1 - a1;
          pred = a1 * Math.exp(-l1 * (xArr[i] - 1)) + a2 * Math.exp(-l2 * (xArr[i] - 1));
        } else {
          const [a1, a2, l1, l2, l3] = params;
          const a3 = 1 - a1 - a2;
          pred = a1 * Math.exp(-l1 * (xArr[i] - 1)) + a2 * Math.exp(-l2 * (xArr[i] - 1)) + a3 * Math.exp(-l3 * (xArr[i] - 1));
        }
        s += (yArr[i] - pred) ** 2;
      }
      return Math.sqrt(s / xArr.length);
    }

    results.push({
      product,
      records: totalRecords,
      d1Span,
      maxD,
      triParams: triParams.map(v => +v.toFixed(4)),
      dblParams: dblParams.map(v => +v.toFixed(4)),
      tri_d180: +tri_d180.toFixed(2),
      tri_d30: +tri_d30.toFixed(2),
      dbl_d180: +dbl_d180.toFixed(2),
      dbl_d30: +dbl_d30.toFixed(2),
      tri_rmse: +rmse(triParams, false).toFixed(4),
      dbl_rmse: +rmse(dblParams, true).toFixed(4),
    });
    process.stderr.write(' done\n');
  }

  db.close();

  // Print table
  console.log('\n=== eLTV 倍数对比 ===\n');
  console.log('产品'.padEnd(14) + 
    '记录数'.padStart(8) + 
    'D1天数'.padStart(7) +
    '最大D'.padStart(6) + 
    '  三指数D180'.padStart(10) + 
    '三指数D30'.padStart(10) + 
    '双指数D180'.padStart(10) + 
    '双指数D30'.padStart(10) +
    '三RMSE'.padStart(8) +
    '双RMSE'.padStart(8)
  );
  console.log('-'.repeat(95));

  for (const r of results.sort((a, b) => (b.records || 0) - (a.records || 0))) {
    const tri180 = r.tri_d180 != null ? r.tri_d180.toFixed(2) : 'N/A';
    const tri30 = r.tri_d30 != null ? r.tri_d30.toFixed(2) : 'N/A';
    const dbl180 = r.dbl_d180 != null ? r.dbl_d180.toFixed(2) : 'N/A';
    const dbl30 = r.dbl_d30 != null ? r.dbl_d30.toFixed(2) : 'N/A';
    const trmse = r.tri_rmse != null ? r.tri_rmse.toFixed(4) : 'N/A';
    const drmse = r.dbl_rmse != null ? r.dbl_rmse.toFixed(4) : 'N/A';
    console.log(
      r.product.padEnd(14) +
      String(r.records).padStart(8) +
      String(r.d1Span || 0).padStart(7) +
      String(r.maxD).padStart(6) +
      tri180.padStart(12) +
      tri30.padStart(10) +
      dbl180.padStart(10) +
      dbl30.padStart(10) +
      trmse.padStart(8) +
      drmse.padStart(8)
    );
  }

  // Also output JSON
  console.log('\n=== JSON ===');
  console.log(JSON.stringify(results, null, 2));
}

main();
