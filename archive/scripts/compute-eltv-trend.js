#!/usr/bin/env node
// Optimized eLTV trend computation - pre-buckets data, uses vectorized ops

const Database = require('/home/admin/.openclaw/workspace/dashboard/node_modules/better-sqlite3');
const db = new Database('/home/admin/dataserver/data.db');

const LTV_APP_IDS = {
  'id6746109957': 'Dora iOS',
  'id6746782904': 'Romi iOS',
  'id6746466099': 'Luma',
  'id1658972379': 'GraceChat',
  'com.doramatch.app': 'Dora And',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.meraki.kira': 'Kira And',
};

function fitTripleExp(xArr, yArr, initParams, maxIter = 5000) {
  const N = xArr.length;
  let p = initParams ? [...initParams] : [0.73, 0.24, 3.0, 0.31, 0.022];

  function f(t) {
    const [a1, a2, l1, l2, l3] = p;
    const a3 = 1 - a1 - a2;
    return a1 * Math.exp(-l1 * (t - 1)) + a2 * Math.exp(-l2 * (t - 1)) + a3 * Math.exp(-l3 * (t - 1));
  }

  function loss() {
    let s = 0;
    for (let i = 0; i < N; i++) {
      const r = yArr[i] - f(xArr[i]);
      s += r * r;
    }
    return s;
  }

  let lr = 1e-4;
  const bounds = [[0.3, 0.95], [0.05, 0.6], [1.0, 15.0], [0.05, 2.0], [0.001, 0.1]];

  for (let iter = 0; iter < maxIter; iter++) {
    const eps = 1e-6;
    const currentLoss = loss();
    const newP = p.map((pi, i) => {
      const pp = [...p]; pp[i] += eps;
      const pm = [...p]; pm[i] -= eps;
      const g = (() => { const op = p[i]; p[i] = pp[i]; const lp = loss(); p[i] = pm[i]; const lm = loss(); p[i] = op; return (lp - lm) / (2 * eps); })();
      let v = pi - lr * g;
      v = Math.max(bounds[i][0], Math.min(bounds[i][1], v));
      return v;
    });
    const op = [...p]; p = newP;
    const newLoss = loss();
    if (newLoss < currentLoss) { lr *= 1.05; }
    else { p = op; lr *= 0.5; }
    if (lr < 1e-12) break;
  }
  return p;
}

function computeD180Ltv(params) {
  const [a1, a2, l1, l2, l3] = params;
  const a3 = 1 - a1 - a2;
  let ltv = 0;
  for (let d = 1; d <= 180; d++) {
    ltv += a1 * Math.exp(-l1 * (d - 1)) + a2 * Math.exp(-l2 * (d - 1)) + a3 * Math.exp(-l3 * (d - 1));
  }
  return ltv;
}

// Load all data at once
const allRows = db.prepare(`
  SELECT app_id, event_time, install_time, revenue
  FROM records_202605
  WHERE event_name='af_purchase'
    AND install_time IS NOT NULL AND install_time != ''
    AND revenue > 0
`).all();
db.close();

// Parse into structured data grouped by (product, installDate, d)
const productBuckets = {}; // product -> { installDate -> { d -> { revenue, cohorts } } }
for (const row of allRows) {
  const product = LTV_APP_IDS[row.app_id];
  if (!product) continue;
  
  const et = new Date(row.event_time.replace(' ', 'T') + 'Z');
  const it = new Date(row.install_time.replace(' ', 'T') + 'Z');
  if (isNaN(et) || isNaN(it)) continue;
  const diffH = (et - it) / 3600000;
  if (diffH < 0) continue;
  const d = Math.floor(diffH / 24) + 1;
  const installDate = row.install_time.slice(0, 10);
  
  if (!productBuckets[product]) productBuckets[product] = {};
  if (!productBuckets[product][installDate]) productBuckets[product][installDate] = {};
  if (!productBuckets[product][installDate][d]) productBuckets[product][installDate][d] = 0;
  productBuckets[product][installDate][d] += row.revenue;
}

// Sort install dates for each product
for (const product of Object.keys(productBuckets)) {
  productBuckets[product] = Object.entries(productBuckets[product])
    .sort(([a], [b]) => a.localeCompare(b))
    .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});
}

// Define daily cutoffs from 2026-05-06 to 2026-05-18
const cutoffs = [];
let cur = new Date('2026-05-06T00:00:00Z');
const endDate = new Date('2026-05-18T00:00:00Z');
while (cur <= endDate) {
  cutoffs.push(cur.toISOString().slice(0, 10));
  cur = new Date(cur.getTime() + 86400000);
}

// For each product+day, accumulate data incrementally
const results = {};

for (const [product, installBuckets] of Object.entries(productBuckets)) {
  const installDates = Object.keys(installBuckets);
  results[product] = { dataPoints: [] };
  
  let prevParams = null;
  
  // Pre-accumulate: dayRevenue and dayCohorts, adding one install date at a time
  const dayRevenue = {};
  const dayCohorts = {};
  let dateIdx = 0;
  
  for (const cutoff of cutoffs) {
    // Add all install dates up to this cutoff
    while (dateIdx < installDates.length && installDates[dateIdx] <= cutoff) {
      const id = installDates[dateIdx];
      const buckets = installBuckets[id];
      for (const [d, rev] of Object.entries(buckets)) {
        const dn = parseInt(d);
        dayRevenue[dn] = (dayRevenue[dn] || 0) + rev;
        if (!dayCohorts[dn]) dayCohorts[dn] = new Set();
        dayCohorts[dn].add(id);
      }
      dateIdx++;
    }
    
    if (!dayRevenue[1] || !dayCohorts[1] || dayCohorts[1].size < 7) continue;
    
    const d1PerCohort = dayRevenue[1] / dayCohorts[1].size;
    const xArr = [], yArr = [];
    for (let d = 1; d <= 220; d++) {
      if (!dayCohorts[d] || dayCohorts[d].size === 0) continue;
      const norm = (dayRevenue[d] / dayCohorts[d].size) / d1PerCohort;
      xArr.push(d);
      yArr.push(norm);
    }
    
    if (xArr.length < 3) continue;
    
    const params = fitTripleExp(xArr, yArr, prevParams, 3000);
    prevParams = [...params];
    const d180 = computeD180Ltv(params);
    
    let totalRecords = 0;
    for (const coh of Object.values(dayCohorts)) totalRecords += coh.size;
    
    results[product].dataPoints.push({
      cutoff,
      d180: Math.round(d180 * 100) / 100,
      d1Span: dayCohorts[1].size,
      maxDay: xArr[xArr.length - 1]
    });
  }
  
  process.stderr.write(`${product}: ${results[product].dataPoints.length} points done\n`);
}

console.log(JSON.stringify(results, null, 2));
