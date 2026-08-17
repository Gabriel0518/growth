#!/usr/bin/env node
/**
 * 对比飞书表格与 Dashboard 个人面板数据差异（仅屹恒syh）
 * 飞书表格: 苏屹恒投放日报 (V7nysbQd3huZvStpd6Tcv7HUnJc)
 * Dashboard: 个人面板 API syh 数据
 * 日期范围: 2026-06-01 ~ 昨天
 * 对比: A列日期, C列消耗, F列原始收入, G列修正收入
 */

const { execSync } = require('child_process');
const http = require('http');
const fs = require('fs');

const SPREADSHEET_TOKEN = 'V7nysbQd3huZvStpd6Tcv7HUnJc';
const DASHBOARD_BASE = 'http://localhost:8081';

const EXCLUDE_SHEETS = ['苏屹恒汇总', '苏屹恒汇总（FB+TT）', '苏屹恒汇总（Google）'];

// Sheet 名 → {product, channel, sheetId}
function parseSheetName(name) {
  if (name.includes('W2A')) return null; // 跳过 W2A 子表
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const channel = parts[parts.length - 1]; // TT, FB, GG
  let product = parts.slice(0, -1).join(' ');
  if (product === 'GC iOS' || product === 'GC') product = 'GraceChat';
  if (product === 'Luma iOS') product = 'Luma';
  // Dashboard 产品名映射: 表格里 "Doni And" = Dashboard 的 "Doni"
  if (product === 'Doni And') product = 'Doni';
  return { product, channel, sheetName: name };
}

function parseCSVLine(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else current += c;
  }
  result.push(current.trim());
  return result;
}

function parseAmount(str) {
  if (!str || str === '#DIV/0!' || str === '#REF!' || str === '') return 0;
  const num = parseFloat(str.replace(/[$,]/g, ''));
  return isNaN(num) ? 0 : num;
}

function parseDate(str) {
  if (!str) return null;
  const m = str.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function fetchSheetData(sheetId) {
  const cmd = `lark-cli sheets +csv-get --spreadsheet-token ${SPREADSHEET_TOKEN} --sheet-id ${sheetId} --range A:G --as user --format json 2>/dev/null`;
  try {
    const raw = execSync(cmd, { encoding: 'utf-8', timeout: 60000 });
    const json = JSON.parse(raw);
    if (!json.ok || !json.data?.annotated_csv) return [];
    return json.data.annotated_csv.split('\n').filter(l => l.trim()).map(line => {
      const match = line.match(/^\[row=(\d+)\]\s*(.*)/);
      if (!match) return null;
      return { row: parseInt(match[1]), cells: parseCSVLine(match[2]) };
    }).filter(Boolean);
  } catch (e) {
    console.error(`  Error reading sheet ${sheetId}: ${e.message.slice(0, 100)}`);
    return [];
  }
}

// HTTP helpers
let sessionCookie = '';
function httpReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, DASHBOARD_BASE);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: { 'Cookie': sessionCookie }
    };
    if (body) {
      const b = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(b);
    }
    const req = http.request(opts, res => {
      const sc = res.headers['set-cookie'];
      if (sc) for (const c of sc) { const m = c.match(/connect\.sid=[^;]+/); if (m) sessionCookie = m[0]; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function login() {
  const r = await httpReq('POST', '/login', 'username=admin&password=' + process.env.DASHBOARD_ADMIN_PASS);
  if (r.status !== 302 && r.status !== 200) throw new Error('Login failed');
}

async function dashGet(path) {
  const r = await httpReq('GET', path);
  return JSON.parse(r.data);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getDateRange() {
  const dates = [];
  const start = new Date('2026-06-01T00:00:00+08:00');
  const now = new Date();
  const yesterday = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  yesterday.setDate(yesterday.getDate() - 1);
  for (let d = new Date(start); d <= yesterday; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().split('T')[0];
    // Ensure we're in the right timezone
    const local = new Date(d.getTime() + 8 * 3600000);
    dates.push(local.toISOString().split('T')[0]);
  }
  // Fix: just use simple date strings
  const result = [];
  for (let i = 0; i < 100; i++) {
    const d = new Date(2026, 5, 1 + i); // June 1 = month 5
    if (d.getMonth() !== 5) break;
    const ds = `2026-06-${String(d.getDate()).padStart(2, '0')}`;
    if (ds > '2026-06-14') break; // yesterday was June 14
    result.push(ds);
  }
  return result;
}

async function main() {
  console.log('=== 飞书表格 vs Dashboard (syh) 数据对比 ===\n');

  const dates = getDateRange();
  console.log(`日期范围: ${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length} 天)\n`);

  // Step 1: Get sheet list
  console.log('Step 1: 获取飞书表格结构...');
  const wbRaw = execSync(`lark-cli sheets +workbook-info --spreadsheet-token ${SPREADSHEET_TOKEN} --as user --format json 2>/dev/null`, { encoding: 'utf-8' });
  const wbInfo = JSON.parse(wbRaw);
  const sheets = wbInfo.data.sheets.filter(s => !EXCLUDE_SHEETS.includes(s.sheet_name));

  const sheetMappings = [];
  for (const s of sheets) {
    const m = parseSheetName(s.sheet_name);
    if (m) sheetMappings.push({ ...m, sheetId: s.sheet_id });
  }
  console.log(`  有效 sheet: ${sheetMappings.length} 个`);
  sheetMappings.forEach(m => console.log(`    ${m.sheetName} → ${m.product} × ${m.channel}`));

  // Step 2: Read all Feishu sheet data
  console.log('\nStep 2: 读取飞书表格数据...');
  const sheetData = {}; // "product|channel" → { date: { cost, originalRevenue, correctedRevenue } }

  for (let i = 0; i < sheetMappings.length; i++) {
    const m = sheetMappings[i];
    console.log(`  [${i + 1}/${sheetMappings.length}] ${m.sheetName}...`);
    const rows = fetchSheetData(m.sheetId);
    const key = `${m.product}|${m.channel}`;
    sheetData[key] = {};

    for (const row of rows) {
      if (row.row === 1) continue; // skip header
      const c = row.cells;
      if (c.length < 7) continue;
      const date = parseDate(c[0]);
      if (!date || !dates.includes(date)) continue;
      sheetData[key][date] = {
        cost: parseAmount(c[2]),           // C列 消耗
        originalRevenue: parseAmount(c[5]), // F列 原始收入
        correctedRevenue: parseAmount(c[6]) // G列 修正收入
      };
    }
    await sleep(300);
  }

  // Step 3: Login & fetch dashboard data
  console.log('\nStep 3: 登录 Dashboard...');
  await login();

  console.log('Step 4: 获取 Dashboard syh 数据 + 修正系数...');
  const dashboardData = {};    // date → "product|channel" → { cost, revenue, correctedRevenue }
  const correctionFactors = {}; // date → { product: number | {fb, other} }

  for (const date of dates) {
    console.log(`  ${date}...`);

    // Personal panel
    let personal;
    try {
      personal = await dashGet(`/api/postback/personal?date=${date}&operator=syh`);
    } catch (e) {
      console.error(`    Error: ${e.message}`);
      continue;
    }

    // Correction factors
    let factors = {};
    try {
      const fr = await dashGet(`/api/correction-factors?date=${date}`);
      factors = fr.factors || {};
    } catch (e) { /* ignore */ }
    correctionFactors[date] = factors;

    dashboardData[date] = {};

    // Find syh operator
    const syhOp = (personal.operators || []).find(o => o.operator === 'syh');
    if (!syhOp) {
      console.log(`    ⚠️ syh not found`);
      continue;
    }

    for (const prod of syhOp.products || []) {
      const product = prod.product;
      for (const ch of prod.channels || []) {
        const channel = ch.channel; // FB, GG, TT, FB W2A
        if (channel === 'FB W2A') continue; // 跳过 W2A

        const key = `${product}|${channel}`;
        const cost = ch.cost || 0;
        const revenue = ch.revenue || 0;

        // Compute corrected revenue using correction factors
        let corrRev = revenue;
        const factor = factors[product];
        if (factor !== undefined) {
          if (typeof factor === 'number') {
            corrRev = revenue * factor;
          } else {
            corrRev = revenue * (channel === 'FB' ? factor.fb : factor.other);
          }
        }

        if (!dashboardData[date][key]) {
          dashboardData[date][key] = { cost: 0, revenue: 0, correctedRevenue: 0 };
        }
        dashboardData[date][key].cost += cost;
        dashboardData[date][key].revenue += revenue;
        dashboardData[date][key].correctedRevenue += corrRev;
      }
    }
    await sleep(200);
  }

  // Step 5: Compare
  console.log('\nStep 5: 对比数据...');

  const allKeys = new Set();
  for (const k of Object.keys(sheetData)) allKeys.add(k);
  for (const date of dates) {
    for (const k of Object.keys(dashboardData[date] || {})) allKeys.add(k);
  }

  // Daily aggregated comparison
  const dailyAgg = {};
  for (const date of dates) {
    dailyAgg[date] = {
      cost: { sheetTotal: 0, dashTotal: 0, absDiff: 0 },
      originalRevenue: { sheetTotal: 0, dashTotal: 0, absDiff: 0 },
      correctedRevenue: { sheetTotal: 0, dashTotal: 0, absDiff: 0 }
    };
  }

  const details = []; // per product×channel×date×metric

  for (const key of allKeys) {
    const [product, channel] = key.split('|');
    for (const date of dates) {
      const sv = sheetData[key]?.[date] || { cost: 0, originalRevenue: 0, correctedRevenue: 0 };
      const dv = dashboardData[date]?.[key] || { cost: 0, revenue: 0, correctedRevenue: 0 };

      // 消耗
      const costDiff = sv.cost - dv.cost;
      dailyAgg[date].cost.sheetTotal += sv.cost;
      dailyAgg[date].cost.dashTotal += dv.cost;
      dailyAgg[date].cost.absDiff += costDiff;

      // 原始收入
      const revDiff = sv.originalRevenue - dv.revenue;
      dailyAgg[date].originalRevenue.sheetTotal += sv.originalRevenue;
      dailyAgg[date].originalRevenue.dashTotal += dv.revenue;
      dailyAgg[date].originalRevenue.absDiff += revDiff;

      // 修正收入
      const corrDiff = sv.correctedRevenue - dv.correctedRevenue;
      dailyAgg[date].correctedRevenue.sheetTotal += sv.correctedRevenue;
      dailyAgg[date].correctedRevenue.dashTotal += dv.correctedRevenue;
      dailyAgg[date].correctedRevenue.absDiff += corrDiff;

      if (Math.abs(costDiff) > 0.01 || Math.abs(revDiff) > 0.01 || Math.abs(corrDiff) > 0.01) {
        details.push({ date, product, channel, costDiff, revDiff, corrDiff,
          sheetCost: sv.cost, dashCost: dv.cost,
          sheetRev: sv.originalRevenue, dashRev: dv.revenue,
          sheetCorr: sv.correctedRevenue, dashCorr: dv.correctedRevenue
        });
      }
    }
  }

  // Output
  const output = { dates, allKeys: [...allKeys].sort(), dailyAgg, details, correctionFactors };
  const outPath = '/home/admin/.openclaw/workspace/scripts/compare-result.json';
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n结果已保存: ${outPath}`);

  // Print daily summary table
  console.log('\n=== 每日汇总差异 ===');
  console.log('日期\t\t消耗绝对差\t消耗相对差\t原始收入绝对差\t原始收入相对差\t修正收入绝对差\t修正收入相对差');
  for (const date of dates) {
    const d = dailyAgg[date];
    const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
    const relPct = (agg) => agg.dashTotal !== 0 ? (agg.absDiff / Math.abs(agg.dashTotal) * 100).toFixed(2) + '%' : 'N/A';
    console.log(`${date}\t${fmt(d.cost.absDiff)}\t${relPct(d.cost)}\t${fmt(d.originalRevenue.absDiff)}\t${relPct(d.originalRevenue)}\t${fmt(d.correctedRevenue.absDiff)}\t${relPct(d.correctedRevenue)}`);
  }

  // Also print which product×channel combos have data in sheet but not dashboard, and vice versa
  console.log('\n=== 数据覆盖差异 ===');
  for (const key of [...allKeys].sort()) {
    const sheetDates = Object.keys(sheetData[key] || {}).filter(d => dates.includes(d));
    const dashDates = dates.filter(d => dashboardData[d]?.[key]);
    const onlySheet = sheetDates.filter(d => !dashDates.includes(d));
    const onlyDash = dashDates.filter(d => !sheetDates.includes(d));
    if (onlySheet.length > 0 || onlyDash.length > 0) {
      console.log(`  ${key}:`);
      if (onlySheet.length) console.log(`    仅表格有: ${onlySheet.join(', ')}`);
      if (onlyDash.length) console.log(`    仅Dashboard有: ${onlyDash.join(', ')}`);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
