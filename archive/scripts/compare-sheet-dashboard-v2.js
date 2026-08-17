#!/usr/bin/env node
/**
 * 日报核查：飞书表格 vs Dashboard 数据对比
 * 用法: node compare-sheet-dashboard-v2.js <spreadsheet_token> <operator_code> [start_date] [end_date]
 */

const { execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DASHBOARD_BASE = 'http://localhost:8081';
const ADMIN_USER = 'admin';
const ADMIN_PASS = process.env.DASHBOARD_ADMIN_PASS;

// Parse args
const spreadsheetToken = process.argv[2];
const operatorCode = process.argv[3];
const startDate = process.argv[4] || null;
const endDate = process.argv[5] || null;

if (!spreadsheetToken || !operatorCode) {
  console.error('Usage: node compare-sheet-dashboard-v2.js <spreadsheet_token> <operator_code> [start_date] [end_date]');
  process.exit(1);
}

const EXCLUDE_SHEETS_PATTERNS = ['汇总', '测新数据'];

function shouldExcludeSheet(name) {
  return EXCLUDE_SHEETS_PATTERNS.some(p => name.includes(p));
}

function normalizeProduct(p) {
  p = p.replace(/\bIOS\b/g, 'iOS').replace(/\bios\b/g, 'iOS').replace(/\band\b/g, 'And');
  if (p === 'GC iOS' || p === 'GC') p = 'GraceChat';
  if (p === 'Luma iOS') p = 'Luma';
  if (p === 'Doni And') p = 'Doni';
  return p;
}

function parseSheetName(name) {
  if (/w2a/i.test(name)) return null;
  // Remove Chinese name prefix like "张苗"
  const cleaned = name.replace(/^[\u4e00-\u9fff]+/g, '').trim();
  
  // Pattern: "GG-Doni And" → channel=GG, product=Doni And
  const chPrefix = cleaned.match(/^(GG|TT|FB)[-\s](.+)$/i);
  if (chPrefix) {
    return { product: normalizeProduct(chPrefix[2].trim()), channel: chPrefix[1].toUpperCase(), sheetName: name };
  }
  
  // Pattern: "GC ios-FB" → product=GC iOS, channel=FB
  const chSuffix = cleaned.match(/^(.+?)[-\s](FB|GG|TT)$/i);
  if (chSuffix) {
    return { product: normalizeProduct(chSuffix[1].trim()), channel: chSuffix[2].toUpperCase(), sheetName: name };
  }
  
  // Default: last space-delimited token = channel
  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) return null;
  const ch = parts[parts.length - 1].toUpperCase();
  if (!['TT', 'FB', 'GG'].includes(ch)) return null;
  return { product: normalizeProduct(parts.slice(0, -1).join(' ')), channel: ch, sheetName: name };
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
  const cmd = `lark-cli sheets +csv-get --spreadsheet-token ${spreadsheetToken} --sheet-id ${sheetId} --range A:G --as user --format json 2>/dev/null`;
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
  const r = await httpReq('POST', '/login', `username=${ADMIN_USER}&password=${encodeURIComponent(ADMIN_PASS)}`);
  if (r.status !== 302 && r.status !== 200) throw new Error('Login failed');
}

async function dashGet(path) {
  const r = await httpReq('GET', path);
  return JSON.parse(r.data);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getDateRange() {
  const now = new Date();
  // Beijing yesterday
  const bjNow = new Date(now.getTime() + 8 * 3600000);
  const bjYesterday = new Date(bjNow);
  bjYesterday.setUTCDate(bjYesterday.getUTCDate() - 1);
  const end = endDate || bjYesterday.toISOString().split('T')[0];
  const start = startDate || `${end.slice(0, 7)}-01`;
  
  const dates = [];
  let d = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T00:00:00Z');
  while (d <= endD) {
    dates.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

async function main() {
  console.log(`=== 日报核查: ${operatorCode} ===`);
  console.log(`飞书表格: ${spreadsheetToken}`);
  console.log(`Dashboard operator: ${operatorCode}\n`);

  const dates = getDateRange();
  console.log(`日期范围: ${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length} 天)\n`);

  // Step 1: Get workbook info
  console.log('Step 1: 获取飞书表格结构...');
  const wbRaw = execSync(`lark-cli sheets +workbook-info --spreadsheet-token ${spreadsheetToken} --as user --format json 2>/dev/null`, { encoding: 'utf-8' });
  const wbInfo = JSON.parse(wbRaw);
  const sheets = wbInfo.data.sheets.filter(s => !shouldExcludeSheet(s.sheet_name));

  const sheetMappings = [];
  for (const s of sheets) {
    const m = parseSheetName(s.sheet_name);
    if (m) sheetMappings.push({ ...m, sheetId: s.sheet_id });
  }
  console.log(`  有效 sheet: ${sheetMappings.length} 个`);
  sheetMappings.forEach(m => console.log(`    ${m.sheetName} → ${m.product} × ${m.channel}`));

  // Step 2: Read all Feishu sheet data
  console.log('\nStep 2: 读取飞书表格数据...');
  const sheetData = {};

  for (let i = 0; i < sheetMappings.length; i++) {
    const m = sheetMappings[i];
    console.log(`  [${i + 1}/${sheetMappings.length}] ${m.sheetName}...`);
    const rows = fetchSheetData(m.sheetId);
    const key = `${m.product}|${m.channel}`;
    sheetData[key] = {};

    for (const row of rows) {
      if (row.row === 1) continue;
      const c = row.cells;
      if (c.length < 7) continue;
      const date = parseDate(c[0]);
      if (!date || !dates.includes(date)) continue;
      sheetData[key][date] = {
        cost: parseAmount(c[2]),
        originalRevenue: parseAmount(c[5]),
        correctedRevenue: parseAmount(c[6])
      };
    }
    await sleep(300);
  }

  // Step 3: Login & fetch dashboard data
  console.log('\nStep 3: 登录 Dashboard...');
  await login();

  console.log('Step 4: 获取 Dashboard 数据...');
  const dashboardData = {};
  const correctionFactors = {};

  for (const date of dates) {
    console.log(`  ${date}...`);
    let personal;
    try { personal = await dashGet(`/api/postback/personal?date=${date}&operator=${operatorCode}`); }
    catch (e) { console.error(`    Error: ${e.message}`); continue; }

    let factors = {};
    try { const fr = await dashGet(`/api/correction-factors?date=${date}`); factors = fr.factors || {}; }
    catch (e) { /* ignore */ }
    correctionFactors[date] = factors;

    dashboardData[date] = {};

    // Only get the target operator's data
    // Note: sheet revenue may include product-wide revenue (all operators), not just this operator's attribution
    // This is a known口径差异 - sheet shows product×channel total, dashboard shows operator attribution
    const op = (personal.operators || []).find(o => o.operator === operatorCode);
    if (!op) { console.log(`    ⚠️ ${operatorCode} not found`); continue; }

    for (const prod of op.products || []) {
      const product = prod.product;
      for (const ch of prod.channels || []) {
        const channel = ch.channel;
        if (channel === 'FB W2A') continue;
        let product = prod.product;
        // Normalize Dashboard product names to match sheet naming
        if (product === 'Nalo: Meet, Swipe & Chat') product = 'Nalo And';
        const key = `${product}|${channel}`;
        const cost = ch.cost || 0;
        const revenue = ch.revenue || 0;
        let corrRev = revenue;
        const factor = factors[product];
        if (factor !== undefined) {
          if (typeof factor === 'number') corrRev = revenue * factor;
          else corrRev = revenue * (channel === 'FB' ? factor.fb : factor.other);
        }
        if (!dashboardData[date][key]) dashboardData[date][key] = { cost: 0, revenue: 0, correctedRevenue: 0 };
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
  for (const date of dates) for (const k of Object.keys(dashboardData[date] || {})) allKeys.add(k);

  const dailyAgg = {};
  for (const date of dates) {
    dailyAgg[date] = {
      cost: { sheetTotal: 0, dashTotal: 0, absDiff: 0 },
      originalRevenue: { sheetTotal: 0, dashTotal: 0, absDiff: 0 },
      correctedRevenue: { sheetTotal: 0, dashTotal: 0, absDiff: 0 }
    };
  }

  const details = [];

  for (const key of allKeys) {
    const [product, channel] = key.split('|');
    for (const date of dates) {
      const sv = sheetData[key]?.[date] || { cost: 0, originalRevenue: 0, correctedRevenue: 0 };
      const dv = dashboardData[date]?.[key] || { cost: 0, revenue: 0, correctedRevenue: 0 };
      const costDiff = sv.cost - dv.cost;
      const revDiff = sv.originalRevenue - dv.revenue;
      const corrDiff = sv.correctedRevenue - dv.correctedRevenue;

      dailyAgg[date].cost.sheetTotal += sv.cost;
      dailyAgg[date].cost.dashTotal += dv.cost;
      dailyAgg[date].cost.absDiff += costDiff;
      dailyAgg[date].originalRevenue.sheetTotal += sv.originalRevenue;
      dailyAgg[date].originalRevenue.dashTotal += dv.revenue;
      dailyAgg[date].originalRevenue.absDiff += revDiff;
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

  // Save output
  const output = { operator: operatorCode, spreadsheetToken, dates, allKeys: [...allKeys].sort(), dailyAgg, details, correctionFactors };
  const outPath = '/home/admin/.openclaw/workspace/scripts/compare-result.json';
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n结果已保存: ${outPath}`);

  // Print daily summary
  console.log('\n=== 每日汇总差异 ===');
  console.log('日期\t\t消耗绝对差\t消耗相对差\t原始收入绝对差\t原始收入相对差\t修正收入绝对差\t修正收入相对差');
  for (const date of dates) {
    const d = dailyAgg[date];
    const fmt = v => (v >= 0 ? '+' : '') + v.toFixed(2);
    const relPct = agg => agg.dashTotal !== 0 ? (agg.absDiff / Math.abs(agg.dashTotal) * 100).toFixed(2) + '%' : 'N/A';
    console.log(`${date}\t${fmt(d.cost.absDiff)}\t${relPct(d.cost)}\t${fmt(d.originalRevenue.absDiff)}\t${relPct(d.originalRevenue)}\t${fmt(d.correctedRevenue.absDiff)}\t${relPct(d.correctedRevenue)}`);
  }

  // Print coverage gaps
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
