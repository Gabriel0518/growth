#!/usr/bin/env node
/**
 * 自动填写「苏屹恒模版」个人日报数据（消耗 / 男生人数 / 原始收入）
 *
 * 数据源：dashboard 个人面板 /api/postback/personal（按 syh 投手过滤）
 *   - 消耗 (C)      = 该产品×渠道 XMP 消耗
 *   - 男生人数 (D)  = af_complete_registration 事件数（= 算 CPI 用的口径，跨渠道 campaign installs 求和）
 *   - 原始收入 (F)  = 该产品×渠道总收入（未修正）
 *
 * 目标表：投放日报模板 wiki，spreadsheet token N1FcsGvXThXu97t7ZYyccCHDnIg，sheet TAVpj9（苏屹恒模版）
 *   每个产品×渠道一个 block：header 行 + 3 个数据行（B1=TODAY()-1，行 A 列为公式 =$B$1 / =$B$1-1 / =$B$1-2）
 *   只写 C / D / F 三列，绝不动 A(日期公式) / B(渠道) / E(CPI 公式) / G+(其它)
 *
 * 用法：
 *   node fill-personal-daily-report.js            # 正常运行（填 TODAY-1/-2/-3 三天）
 *   node fill-personal-daily-report.js --dry-run  # 只打印将写入的数据，不实际写
 */

const http = require('http');
const { execFileSync } = require('child_process');

const DASH_BASE = 'http://localhost:8081';
const DASH_USER = 'admin';
const DASH_PASS = process.env.DASHBOARD_ADMIN_PASS;
const SS_TOKEN = 'N1FcsGvXThXu97t7ZYyccCHDnIg';
const SHEET_ID = 'TAVpj9';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Block 定义：header 行号 → { product, channel } ──
// product 用 dashboard 数据里的产品名；channel 用数据里的渠道名（FB / TT / GG / FB W2A）
const BLOCKS = [
  { row: 1,  product: 'GraceChat', channel: 'TT' },
  { row: 6,  product: 'Dora And',  channel: 'TT' },
  { row: 11, product: 'Dora iOS',  channel: 'TT' },
  { row: 16, product: 'Doni',      channel: 'TT' },
  { row: 21, product: 'Romi iOS',  channel: 'TT' },
  { row: 26, product: 'Jovia And', channel: 'TT' },
  { row: 31, product: 'Kira iOS',  channel: 'TT' },
  { row: 36, product: 'Kira And',  channel: 'TT' },
  { row: 41, product: 'Dora And',  channel: 'FB' },
  { row: 46, product: 'Dora iOS',  channel: 'FB' },
  { row: 51, product: 'Doni',      channel: 'FB' },
  { row: 56, product: 'Jovia And', channel: 'FB' },
  { row: 61, product: 'Romi And',  channel: 'FB' },
  { row: 66, product: 'Romi iOS',  channel: 'FB' },
  { row: 71, product: 'Romi iOS',  channel: 'FB W2A' },
  { row: 76, product: 'Luma',      channel: 'FB' },
  { row: 81, product: 'Dora And',  channel: 'GG' },
  { row: 86, product: 'Doni',      channel: 'GG' },
  { row: 91, product: 'Jovia And', channel: 'GG' },
  { row: 96, product: 'Romi And',  channel: 'GG' },
  { row: 101, product: 'GraceChat', channel: 'FB' },
  { row: 106, product: 'Kira And',  channel: 'FB' },
];

// ── 日期工具（北京时间）──
function beijingToday() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// ── HTTP helpers ──
function httpRequest(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(DASH_BASE + path);
    const req = http.request({
      method, hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function dashLogin() {
  const form = `username=${encodeURIComponent(DASH_USER)}&password=${encodeURIComponent(DASH_PASS)}`;
  const res = await httpRequest('POST', '/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    body: form,
  });
  const setCookie = res.headers['set-cookie'];
  if (!setCookie || !setCookie.length) throw new Error('Dashboard login: no session cookie returned');
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

async function fetchPersonal(cookie, date) {
  const res = await httpRequest('GET', `/api/postback/personal?date=${date}`, { headers: { Cookie: cookie } });
  if (res.status !== 200) throw new Error(`personal API ${date} -> HTTP ${res.status}`);
  return JSON.parse(res.body);
}

// 把单日 personal 数据归约为 { 'product|channel': {cost, installs, revenue} }（仅 syh）
function reduceSyh(data) {
  const out = {};
  const syh = (data.operators || []).find((o) => o.operator === 'syh');
  if (!syh) return out;
  for (const p of (syh.products || [])) {
    for (const c of (p.channels || [])) {
      const installs = (c.campaigns || []).reduce((s, camp) => s + (camp.installs || 0), 0);
      out[`${p.product}|${c.channel}`] = {
        cost: c.cost || 0,
        installs,
        revenue: c.revenue || 0,
      };
    }
  }
  return out;
}

// ── 飞书写入：用 lark-cli +cells-set 写 C/D/F 单元格对象 ──
function sleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }

function larkCellsSet(range, cells) {
  const args = [
    'sheets', '+cells-set',
    '--spreadsheet-token', SS_TOKEN,
    '--sheet-id', SHEET_ID,
    '--range', range,
    '--as', 'user',
    '--format', 'json',
    '--cells', '-',
  ];
  const payload = JSON.stringify(cells);
  // 飞书并发修订冲突（cs recommited）会偶发 server_error，重试 + 退避
  const MAX = 4;
  let lastErr;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const out = execFileSync('lark-cli', args, {
        input: payload,
        env: { ...process.env, OPENCLAW_HOME },
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
      return out;
    } catch (e) {
      lastErr = e;
      const msg = (e.stdout || '') + (e.stderr || '') + e.message;
      const retriable = /recommited|server_error|rev is|timeout|ECONN|429|rate/i.test(msg);
      if (attempt < MAX && retriable) {
        const backoff = 800 * attempt;
        console.error(`  [retry] ${range} 第${attempt}次失败，${backoff}ms 后重试`);
        sleep(backoff);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function main() {
  const today = beijingToday();
  const dates = [addDays(today, -1), addDays(today, -2), addDays(today, -3)]; // 昨天/前天/大前天，对齐 B1=TODAY()-1
  console.log(`[fill] 北京今天=${today}，填写日期=${dates.join(', ')}  dryRun=${DRY_RUN}`);

  const cookie = await dashLogin();
  const byDate = {};
  for (const d of dates) {
    const data = await fetchPersonal(cookie, d);
    byDate[d] = reduceSyh(data);
    console.log(`[fill] 拉取 ${d}: ${Object.keys(byDate[d]).length} 个产品×渠道有数据`);
  }

  let writeCount = 0;
  for (const blk of BLOCKS) {
    const key = `${blk.product}|${blk.channel}`;
    // 3 个数据行：header+1=昨天(dates[0]), header+2=前天(dates[1]), header+3=大前天(dates[2])
    for (let i = 0; i < 3; i++) {
      const dataRow = blk.row + 1 + i;
      const dd = byDate[dates[i]][key] || { cost: 0, installs: 0, revenue: 0 };
      // C=消耗, D=男生人数, F=原始收入。E 是 CPI 公式不动，所以 C/D 一组、F 单独一组写。
      const cdRange = `C${dataRow}:D${dataRow}`;
      const fRange = `F${dataRow}`;
      const cdCells = [[
        { value: round2(dd.cost), cell_styles: { number_format: '$#,##0.00' } },
        { value: dd.installs, cell_styles: { number_format: '0' } },
      ]];
      const fCells = [[
        { value: round2(dd.revenue), cell_styles: { number_format: '$#,##0.00' } },
      ]];
      if (DRY_RUN) {
        console.log(`  ${key.padEnd(20)} ${dates[i]} row${dataRow}  C=$${round2(dd.cost)} D=${dd.installs} F=$${round2(dd.revenue)}`);
      } else {
        larkCellsSet(cdRange, cdCells);
        sleep(250);
        larkCellsSet(fRange, fCells);
        sleep(250);
        writeCount += 2;
      }
    }
  }

  if (DRY_RUN) {
    console.log('[fill] dry-run 完成，未写入。');
  } else {
    console.log(`[fill] 完成，共写入 ${writeCount} 个区域（${BLOCKS.length} blocks × 3 天 × 2 区域）。`);
  }
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

main().catch((err) => { console.error('[fill] FATAL:', err.message); process.exit(1); });
