#!/usr/bin/env node
/**
 * Daily Report Sheet Writer
 * Fetches data from Athena API, XMP API, AF SQLite and writes to Feishu sheet.
 * 
 * Usage: node scripts/daily-report-sheet.js [spreadsheet_token] [sheet_id]
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const Database = require('/home/admin/.openclaw/workspace/dashboard/node_modules/better-sqlite3');

// ── Config ──
const SPREADSHEET_TOKEN = process.argv[2] || 'KlXHsPavJhpcbOtiZYecbOYun3b';
const SHEET_ID = process.argv[3] || '2c762a';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const FEISHU_API = 'https://open.feishu.cn/open-apis';

// Athena
const ATHENA_API = 'https://admin-api-prod.sitin.ai/api/open/admin/revenue';
const ATHENA_KEY = process.env.ATHENA_API_KEY;

// XMP
const XMP_CLIENT_ID = process.env.XMP_CLIENT_ID;
const XMP_CLIENT_SECRET = process.env.XMP_CLIENT_SECRET;
const XMP_HOST = 'xmp-open.mobvista.com';

// BytePlus DataFinder (PWA 女生注册人数 数据源)
// C 列 = 昨天(北京)全体用户 pwa_conv_cash_ready_pop_show 的触发人数(event_users)
// 详见 docs/byteplus-datafinder.md
const BP_AK = process.env.BYTEPLUS_DATAFINDER_AK;
const BP_SK = process.env.BYTEPLUS_DATAFINDER_SK;
const BP_HOST = 'analytics.byteplusapi.com';
const BP_PWA_APP_ID = 653834;
const BP_PWA_EVENT = 'pwa_conv_cash_ready_pop_show';

// AF DB
const AF_DB_PATH = '/home/admin/dataserver/data.db';

// Product order for the report
const PRODUCTS = [
  'GraceChat', 'Dora iOS', 'Dora And', 'Doni', 'Romi iOS',
  'Luma', 'Jovia And', 'Romi And', 'Kira And', 'Kira iOS', 'Nalo And'
];

// Athena API name → our name
const ATHENA_MAP = {
  'GraceChat': 'GraceChat', 'Dora': 'Dora iOS', 'Dora Android': 'Dora And',
  'Doni': 'Doni', 'Romi': 'Romi iOS', 'Romi Android': 'Romi And',
  'Luma': 'Luma', 'Jovia Android': 'Jovia And',
  'Kira': 'Kira iOS', 'Kira Android': 'Kira And', 'Nalo Android': 'Nalo And',
};

// XMP product name → our name
const XMP_MAP = {
  'Romi: Make Friends, Have Fun': 'Romi iOS',
  'Dora: Create and connect': 'Dora iOS',
  'Dora: Find Real Companionship': 'Dora And',
  'Doni: Easy Connection': 'Doni',
  'Luma: Make Friends, Have Fun': 'Luma',
  'Jovia: Find Real Love': 'Jovia And',
  'Romi: Swipe, Chat & Connect': 'Romi And',
  'GraceChat': 'GraceChat',
  'Kira: Creative Community': 'Kira iOS',
  'Kira: Find Your Romance': 'Kira And',
  'Nalo: Meet, Swipe & Chat': 'Nalo And',
};

// AF app_id → our name
const AF_MAP = {
  'id1658972379': 'GraceChat', 'id6746109957': 'Dora iOS',
  'com.doramatch.app': 'Dora And', 'com.doni.appa': 'Doni',
  'id6746782904': 'Romi iOS', 'id6746466099': 'Luma',
  'com.qiga.vio': 'Jovia And', 'com.romiandroid.appmatch': 'Romi And',
  'com.meraki.kira': 'Kira And', 'id6759697686': 'Kira iOS',
  'com.cavalier.nalo': 'Nalo And',
};

// ── Helpers ──

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
  });
}

function httpRequest(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const bodyStr = JSON.stringify(body);
    const options = {
      method, hostname: u.hostname, path: u.pathname + u.search, port: u.port || undefined,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
    };
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpPost(url, body, headers = {}) {
  return httpRequest('POST', url, body, headers);
}

function httpPut(url, body, headers = {}) {
  return httpRequest('PUT', url, body, headers);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getBeijingDates() {
  // Returns [yesterday, day_before_yesterday, 3_days_ago] in YYYY-MM-DD
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  const dates = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(beijing);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function formatDateDisplay(dateStr) {
  // "2026-06-03" → "2026/6/3"
  const [y, m, d] = dateStr.split('-');
  return `${y}/${parseInt(m)}/${parseInt(d)}`;
}

// ── Data Fetchers ──

async function fetchAthena(date) {
  const url = `${ATHENA_API}?date=${date}`;
  const res = await httpGet(url, { 'Authorization': `Bearer ${ATHENA_KEY}` });
  if (!res.success) throw new Error(`Athena API error: ${JSON.stringify(res)}`);
  const result = {};
  for (const p of res.data.products) {
    const name = ATHENA_MAP[p.appName];
    if (name) {
      result[name] = {
        totalRevenue: parseFloat(p.totalRevenue) || 0,
        totalPayingUsers: p.totalPayingUsers || 0,
        totalPayments: p.totalPayments || 0,
        newUserRevenue: parseFloat(p.newUserRevenue) || 0,
        newUserPayingUsers: p.newUserPayingUsers || 0,
      };
    }
  }
  return result;
}

function xmpSign() {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash('md5').update(XMP_CLIENT_SECRET + timestamp).digest('hex');
  return { timestamp, sign };
}

function xmpApiRequest(body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      method: 'POST', hostname: XMP_HOST, path: '/v2/media/account/report',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function fetchXmpForDate(date) {
  // Returns { products: { product: { total, tt } }, pwaCost: number }
  const products = {};
  let pwaCost = 0;
  const channels = ['facebook', 'google', 'tiktok'];
  
  for (const channel of channels) {
    const { timestamp, sign } = xmpSign();
    const resp = await xmpApiRequest({
      client_id: XMP_CLIENT_ID, timestamp, sign,
      start_date: date, end_date: date,
      dimension: ['product_name'],
      module: channel,
      metrics: ['cost'],
      currency: 'USD',
      page: 1, page_size: 1000,
    });
    
    if (resp.code !== 0) {
      throw new Error(`XMP API ${channel} error: ${resp.msg} (code ${resp.code})`);
    }
    
    if (resp.data && resp.data.list) {
      for (const row of resp.data.list) {
        const cost = parseFloat(row.cost) || 0;
        const pn = (row.product_name || '').trim();
        if (!pn) {
          // PWA = null/empty product_name (TT PWA campaigns)
          pwaCost += cost;
          continue;
        }
        const name = XMP_MAP[pn] || null;
        if (!name) continue;
        if (!products[name]) products[name] = { total: 0, tt: 0 };
        products[name].total += cost;
        if (channel === 'tiktok') {
          products[name].tt += cost;
        }
      }
    }
  }
  return { products, pwaCost };
}

function fetchAfRegistrations(dates) {
  // Returns { date: { product: count } }
  const db = new Database(AF_DB_PATH, { readonly: true });
  const result = {};
  
  for (const date of dates) {
    result[date] = {};
    // Determine table name from date
    const table = 'records_' + date.replace(/-/g, '').slice(0, 6);
    
    try {
      const rows = db.prepare(`
        SELECT app_id, COUNT(*) as cnt
        FROM ${table}
        WHERE event_name = 'af_complete_registration'
          AND DATE(datetime(event_time, '+8 hours')) = ?
        GROUP BY app_id
      `).all(date);
      
      for (const row of rows) {
        const name = AF_MAP[row.app_id];
        if (name) {
          result[date][name] = (result[date][name] || 0) + row.cnt;
        }
      }
    } catch (e) {
      console.error(`[AF] Error querying ${table} for ${date}: ${e.message}`);
    }
  }
  
  db.close();
  return result;
}

// DAU data from Multi-App Data Center
// ⚠️ API dates are US West time, so Beijing date D → query D-1
// ⚠️ 2026-06-15: 新增认证，需先调 /api/login 获取 cookie
const DAU_BASE = process.env.DAU_BASE || 'http://62.234.39.191:8765';
const DAU_API = DAU_BASE + '/api/cached-data';
const DAU_USER = 'admin';
const DAU_PASS = process.env.DAU_PASS;
let dauAuthCookie = ''; // Set by dauLogin()

// DAU column mapping: R=GraceChat, S=Dora And, T=Dora iOS, U=Doni, V=Romi iOS,
// W=Luma, X=Jovia And, Y=Romi And, Z=Kira iOS, AA=Kira And, AB=Nalo And
const DAU_COLUMNS = [
  { col: 17, name: 'Gracechat', platform: 'ios' },      // R
  { col: 18, name: 'Dora', platform: 'android' },       // S
  { col: 19, name: 'Dora', platform: 'ios' },            // T
  { col: 20, name: 'Doni', platform: 'android' },        // U
  { col: 21, name: 'Romi', platform: 'ios' },            // V
  { col: 22, name: 'Luma', platform: 'ios' },            // W
  { col: 23, name: 'Jovia', platform: 'android' },       // X
  { col: 24, name: 'Romi', platform: 'android' },        // Y
  { col: 25, name: 'Kira', platform: 'ios' },            // Z
  { col: 26, name: 'Kira', platform: 'android' },        // AA
  { col: 27, name: null, platform: null },                // AB = Nalo And, always 0
];

async function dauLogin() {
  // Login to Multi-App Data Center and store auth cookie
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify({ username: DAU_USER, password: DAU_PASS });
    const u = new URL(DAU_BASE + '/api/login');
    const options = {
      method: 'POST', hostname: u.hostname, port: u.port || 80,
      path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    };
    const req = http.request(options, (res) => {
      // Extract set-cookie headers
      const cookies = res.headers['set-cookie'] || [];
      const parts = [];
      for (const c of cookies) {
        const m = c.match(/^([^=]+)=([^;]+)/);
        if (m) parts.push(`${m[1]}=${m[2]}`);
      }
      dauAuthCookie = parts.join('; ');
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.ok) {
            console.log(`[DAU] Login success, cookie: ${dauAuthCookie.slice(0, 30)}...`);
            resolve();
          } else {
            reject(new Error(`DAU login failed: ${data}`));
          }
        } catch { reject(new Error(`DAU login parse error: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function fetchDau(dates) {
  // Returns { date: { col_index: dau_value } }
  // Login first if not already
  if (!dauAuthCookie) await dauLogin();

  const result = {};
  for (const date of dates) {
    result[date] = {};
    // Beijing date → US West date = date - 1 day
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    const apiDate = d.toISOString().slice(0, 10);

    try {
      const resp = await httpPost(DAU_API, { start: apiDate, end: apiDate }, { Cookie: dauAuthCookie });
      if (!resp.data) {
        console.error(`[DAU] No data for ${apiDate}`);
        continue;
      }
      for (const col of DAU_COLUMNS) {
        if (!col.name) {
          result[date][col.col] = 0; // Nalo And
          continue;
        }
        const val = resp.data?.[col.platform]?.overview?.[col.name]?.dau?.all?.value || 0;
        result[date][col.col] = val;
      }
    } catch (e) {
      console.error(`[DAU] Error fetching ${apiDate}: ${e.message}`);
    }
  }
  return result;
}

// ── BytePlus DataFinder: PWA 女生注册人数 ──
// 查 pwa_conv_cash_ready_pop_show 事件的触发人数(event_users), 全体用户, 按天
// 返回 { 'YYYY-MM-DD': number }, 覆盖传入的所有 dates(缺失/查询失败的日期不写入该 key)

function bpSha256HmacHex(key, msg) {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf-8')).update(msg, 'utf-8').digest('hex');
}
function bpBuildAuth(method, uri, queryString, body) {
  const ts = Math.floor(Date.now() / 1000);
  const expire = 1800;
  const signKeyInfo = `ak-v1/${BP_AK}/${ts}/${expire}`;
  const signKey = bpSha256HmacHex(BP_SK, signKeyInfo); // hexdigest 字符串再当 key
  const canonical =
    `HTTPMethod:${method}\n` +
    `CanonicalURI:${uri}\n` +
    `CanonicalQueryString:${queryString}\n` +
    `CanonicalBody:${body}`;
  const signature = bpSha256HmacHex(signKey, canonical);
  return `${signKeyInfo}/${signature}`;
}
function bpPost(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const uri = '/datafinder' + path;
    const body = JSON.stringify(bodyObj);
    const auth = bpBuildAuth('POST', uri, '', body);
    const req = https.request({
      host: BP_HOST, path: uri, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': auth,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let j; try { j = JSON.parse(data); } catch { j = { code: -1, raw: data }; }
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('BytePlus timeout')));
    req.write(body); req.end();
  });
}

// 计算需要覆盖到最早日期所需的天数(last N days), 至少覆盖传入 dates
async function fetchPwaRegistrations(dates) {
  const result = {};
  if (!BP_AK || !BP_SK) {
    console.warn('[BytePlus] 缺 BYTEPLUS_DATAFINDER_AK/SK, PWA 女生注册人数将留空');
    return result;
  }
  // dates 形如 [yesterday, day_before, 3_days_ago]; 找最早日期, 算 last N 天
  const today = new Date(new Date().getTime() + 8 * 3600 * 1000);
  today.setUTCHours(0, 0, 0, 0);
  let maxBack = 1;
  for (const ds of dates) {
    const d = new Date(ds + 'T00:00:00Z');
    const back = Math.round((today - d) / 86400000); // 今天回退几天
    if (back > maxBack) maxBack = back;
  }
  const dsl = {
    version: 3, app_ids: [BP_PWA_APP_ID], use_app_cloud_id: true,
    periods: [{ granularity: 'day', type: 'last', last: { amount: maxBack, unit: 'day' }, timezone: 'Asia/Shanghai' }],
    content: {
      query_type: 'event', profile_groups_v2: [], profile_filters: [],
      queries: [[{
        event_type: 'origin', show_name: 'PWA女生注册人数', event_name: BP_PWA_EVENT,
        groups: [], groups_v2: [], filters: [], show_label: 'pwa_reg', event_indicator: 'event_users',
      }]],
      option: { skip_cache: false },
    },
  };
  const r = await bpPost('/openapi/v1/analysis', dsl);
  if (r.json.code !== 200) {
    console.warn(`[BytePlus] 查询失败 code=${r.json.code} msg=${r.json.message}, PWA 女生注册人数留空`);
    return result;
  }
  const d0 = r.json.data && r.json.data[0];
  const item = d0 && d0.data_item_list && d0.data_item_list[0];
  const dateIdx = (d0 && d0.date_index_list) || []; // ['20260701','20260702',...]
  if (!item || !dateIdx.length) {
    console.warn('[BytePlus] 返回无数据, PWA 女生注册人数留空');
    return result;
  }
  // date_index_list 是 YYYYMMDD, 映射回 YYYY-MM-DD
  dateIdx.forEach((ymd, i) => {
    const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
    result[iso] = item.data[i];
  });
  return result;
}

// ── Feishu Sheet Writer ──

async function getFeishuToken() {
  const res = await httpPost(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    app_id: APP_ID, app_secret: APP_SECRET,
  });
  if (!res.tenant_access_token) throw new Error('Failed to get Feishu token: ' + JSON.stringify(res));
  return res.tenant_access_token;
}

async function writeSheet(token, range, values) {
  const url = `${FEISHU_API}/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values`;
  const body = {
    valueRange: {
      range: `${SHEET_ID}!${range}`,
      values: values,
    },
  };
  const res = await httpPut(url, body, { 'Authorization': `Bearer ${token}` });
  if (res.code !== 0) {
    console.error(`[Sheet] Write error at ${range}: ${JSON.stringify(res)}`);
  }
  return res;
}

// ── Main ──

async function main() {
  const dates = getBeijingDates(); // [yesterday, day_before, 3_days_ago]
  console.log(`[Daily Report] Dates: ${dates.join(', ')}`);

  // 1. Fetch Athena (3 requests, 60 QPM — no issue)
  console.log('[1/5] Fetching Athena data...');
  const athenaData = {};
  for (const date of dates) {
    athenaData[date] = await fetchAthena(date);
  }
  console.log('[1/5] Athena done.');

  // 2. Fetch XMP (3 channels × 3 days = 9 requests, 10 QPM — need spacing)
  console.log('[2/5] Fetching XMP data (with QPM spacing)...');
  const xmpData = {};
  for (let i = 0; i < dates.length; i++) {
    if (i > 0) {
      console.log(`[XMP] Waiting 65s for QPM reset...`);
      await sleep(65000);
    }
    console.log(`[XMP] Fetching ${dates[i]}...`);
    xmpData[dates[i]] = await fetchXmpForDate(dates[i]);
  }
  console.log('[2/5] XMP done.');

  // 3. Fetch AF registrations (local SQLite, instant)
  console.log('[3/5] Fetching AF registrations...');
  const afData = fetchAfRegistrations(dates);
  console.log('[3/5] AF done.');

  // 4. Fetch DAU from Multi-App Data Center
  console.log('[4/5] Fetching DAU data...');
  const dauData = await fetchDau(dates);
  console.log('[4/5] DAU done.');

  // 4b. Fetch PWA 女生注册人数 from BytePlus DataFinder
  console.log('[4b] Fetching PWA registrations from BytePlus...');
  const pwaRegData = await fetchPwaRegistrations(dates);
  console.log('[4b] BytePlus PWA done.', JSON.stringify(pwaRegData));

  // 5. Build rows and write to Feishu sheet
  console.log('[5/5] Writing to Feishu sheet...');
  const feishuToken = await getFeishuToken();

  // Build all rows (28 columns: A-AB)
  const NUM_COLS = 28;
  const allRows = [];
  for (let pi = 0; pi < PRODUCTS.length; pi++) {
    const product = PRODUCTS[pi];
    
    // Product header row: A=product name
    const headerRow = new Array(NUM_COLS).fill('');
    headerRow[0] = product; // A
    allRows.push(headerRow);

    // 3 data rows (yesterday, day before, 3 days ago)
    for (const date of dates) {
      const row = new Array(NUM_COLS).fill('');
      row[0] = formatDateDisplay(date); // A: date
      // B: empty
      row[2] = xmpData[date]?.products?.[product]?.total || ''; // C: XMP total cost
      row[3] = afData[date]?.[product] || ''; // D: AF registrations
      // E: empty
      row[5] = athenaData[date]?.[product]?.totalRevenue || ''; // F: Athena revenue
      // G: empty
      row[7] = xmpData[date]?.products?.[product]?.tt ? 
        Math.round((xmpData[date].products[product].tt * 0.025) * 100) / 100 : ''; // H: TT cost × 0.025
      // I-M: empty
      row[13] = athenaData[date]?.[product]?.totalPayingUsers || ''; // N: total paying users
      row[14] = athenaData[date]?.[product]?.totalPayments || ''; // O: total payments
      // P-R: empty
      row[18] = athenaData[date]?.[product]?.newUserRevenue || ''; // S: new user revenue
      // T: empty
      row[20] = athenaData[date]?.[product]?.newUserPayingUsers || ''; // U: new user paying users
      allRows.push(row);
    }

    // Empty separator row
    allRows.push(new Array(NUM_COLS).fill(''));
  }

  // PWA rows (special product)
  const pwaHeader = new Array(NUM_COLS).fill('');
  pwaHeader[0] = 'PWA';
  allRows.push(pwaHeader);

  for (const date of dates) {
    const row = new Array(NUM_COLS).fill('');
    row[0] = formatDateDisplay(date); // A: date
    row[1] = xmpData[date]?.pwaCost || ''; // B: PWA XMP cost (product=null)
    row[2] = pwaRegData[date] ?? ''; // C: 女生注册人数 (BytePlus pwa_conv_cash_ready_pop_show event_users)
    // R-AB: DAU data
    for (const col of DAU_COLUMNS) {
      row[col.col] = dauData[date]?.[col.col] ?? 0;
    }
    allRows.push(row);
  }

  // Write all at once: A1 to AB{n}
  const range = `A1:AB${allRows.length}`;
  console.log(`[Sheet] Writing ${allRows.length} rows to ${range}`);
  await writeSheet(feishuToken, range, allRows);
  
  console.log(`[Daily Report] Done! ${PRODUCTS.length} products + PWA, ${dates.length} days.`);
  console.log(`[Daily Report] Sheet URL: https://presence.feishu.cn/sheets/${SPREADSHEET_TOKEN}`);
}

main().catch(err => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
