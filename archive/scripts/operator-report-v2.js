#!/usr/bin/env node
/**
 * Operator Daily Report (v2) — Sheet-based data source
 * 
 * Reads all operator data from Feishu sheet "投手排行榜" Data tab,
 * generates:
 *   1. Text summary (yesterday's data per operator)
 *   2. Revenue + Profit margin trend charts (month-to-date)
 *   3. Rankings (cost/revenue/profit)
 *   4. @mention operators with no data yesterday
 *
 * Replaces: operator-daily-report.js + operator-multiday-data.js + operator-rank-report.js
 * Still uses: operator-charts.py (unchanged, reads JSON from stdin)
 */
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 2026 China workday calendar ──
// Holidays (rest days) from State Council notice
const HOLIDAYS_2026 = new Set([
  // 元旦 1/1-1/3
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节 2/15-2/23
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明 4/4-4/6
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节 5/1-5/5
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午 6/19-6/21
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋 9/25-9/27
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆 10/1-10/7
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]);
// Makeup workdays (调休上班)
const MAKEUP_WORKDAYS_2026 = new Set([
  '2026-01-04', // 元旦调休
  '2026-02-14', // 春节调休
  '2026-02-28', // 春节调休
  '2026-05-09', // 劳动节调休
  '2026-09-20', // 国庆调休
  '2026-10-10', // 国庆调休
]);

function isWorkday(dateStr) {
  // Makeup workdays override weekends
  if (MAKEUP_WORKDAYS_2026.has(dateStr)) return true;
  // Holidays override weekdays
  if (HOLIDAYS_2026.has(dateStr)) return false;
  // Normal: Mon-Fri = workday, Sat-Sun = rest
  const d = new Date(dateStr + 'T12:00:00+08:00');
  const dow = d.getDay(); // 0=Sun, 6=Sat
  return dow >= 1 && dow <= 5;
}

const SPREADSHEET_TOKEN = 'QF2UsntX6hCRwwtqTXlc4GQsnFd';
const SHEET_ID_DATA = 'YiWQtE';
const CHAT_ID = 'oc_6518b783dd17e543f84d1636ee380598'; // 投放UG群
const LARK_CLI = path.join(process.env.HOME, '.npm-global/bin/lark-cli');

// Name → open_id mapping (all 12 operators)
const NAME_TO_OPEN_ID = {
  '苏屹恒': 'ou_b2467dac5ff1d686fb48ccf1fbaa0c0d',
  '张苗': 'ou_0855b5e9f6635d738079bf2333af09ac',
  '武春香': 'ou_c86e6a1275e46c0b7d2c6c2bd7c6232b',
  '张梦凡': 'ou_4c5186c6c4654683064f0d430d140363',
  '马崇岩': 'ou_4d441e7d848bd6450d6e3bf1caff9689',
  '刘欢': 'ou_cdc2f5364367be24df897ef99f2c0a06',
  '杨梅亭': 'ou_26ce6364a1f6ecfe7371963c1f5d2468',
  '吴天越': 'ou_7a14f7e1455eee37717799db8f31e253',
  '王维维': 'ou_b2c524e703c2596c78570aa96e3323a9',
  '张嘉铖': 'ou_ec0e0b17767ddeb1291eadecc4ae35e9',
  '陈祎': 'ou_db421b666138f1cc5b85d79ba26bcae9',
};

// Operator layout in the Data sheet (0-indexed column positions)
const SHEET_OPERATORS = [
  { code: 'syh', name: '苏屹恒', startCol: 5 },
  { code: 'lh',  name: '刘欢',   startCol: 23 },
  { code: 'wcx', name: '武春香', startCol: 32 },
  { code: 'zmf', name: '张梦凡', startCol: 41 },
  { code: 'zm1', name: '张苗',   startCol: 50 },
  { code: 'mcy', name: '马崇岩', startCol: 59 },
  { code: 'ymt', name: '杨梅亭', startCol: 68 },
  { code: 'cy1', name: '陈祎',   startCol: 77 },
  { code: 'wvv', name: '王维维', startCol: 86 },
  { code: 'zjc', name: '张嘉铖', startCol: 95 },
  { code: 'wty', name: '吴天越', startCol: 104 },
];

const OPERATOR_NAMES = {};
for (const op of SHEET_OPERATORS) OPERATOR_NAMES[op.code] = op.name;

// ── Utility functions ──

function larkCli(args) {
  const cmd = `export PATH=~/.npm-global/bin:$PATH && set +H && lark-cli ${args}`;
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 60000 });
}

function parseAmount(s) {
  if (!s) return 0;
  const cleaned = s.replace(/[$,"\s]/g, '');
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

function parseCSVFields(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return null;
  return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
}

function formatAmount(val) {
  if (val === 0) return '$0';
  const prefix = val < 0 ? '-$' : '$';
  const abs = Math.abs(val);
  return prefix + abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const SEND_MAX_RETRIES = 2;    // retry up to 2 times after initial failure
const SEND_RETRY_DELAY = 60000; // 1 minute between retries

function sendMessage(text) {
  let lastError;
  for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[Report] sendMessage retry ${attempt}/${SEND_MAX_RETRIES} after ${SEND_RETRY_DELAY / 1000}s...`);
      execSync(`sleep ${SEND_RETRY_DELAY / 1000}`);
    }
    const result = spawnSync(
      LARK_CLI,
      ['im', '+messages-send', '--as', 'bot', '--chat-id', CHAT_ID, '--text', text],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}` } }
    );
    if (result.status === 0) return;
    lastError = result.stderr || result.stdout;
    console.error(`[Report] Send failed (attempt ${attempt + 1}/${SEND_MAX_RETRIES + 1}):`, lastError);
  }
  console.error('[Report] Send failed after all retries');
  throw new Error('Failed to send message after retries');
}

function sendImage(imagePath) {
  const absPath = path.resolve(imagePath);
  const dir = path.dirname(absPath);
  const filename = path.basename(absPath);
  let lastError;
  for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[Report] sendImage retry ${attempt}/${SEND_MAX_RETRIES} after ${SEND_RETRY_DELAY / 1000}s...`);
      execSync(`sleep ${SEND_RETRY_DELAY / 1000}`);
    }
    const result = spawnSync(
      LARK_CLI,
      ['im', '+messages-send', '--as', 'bot', '--chat-id', CHAT_ID, '--image', `./${filename}`],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
        cwd: dir,
        env: { ...process.env, PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}` } }
    );
    if (result.status === 0) return;
    lastError = result.stderr || result.stdout;
    console.error(`[Report] Image send failed (attempt ${attempt + 1}/${SEND_MAX_RETRIES + 1}):`, lastError);
  }
  console.error('[Report] Image send failed after all retries');
  throw new Error('Failed to send image after retries');
}

// ── Main ──

function main() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const todayStr = now.toISOString().slice(0, 10);

  // Skip non-workdays (weekends + holidays, but include makeup workdays)
  if (!isWorkday(todayStr)) {
    console.log(`[Report] Today ${todayStr} is not a workday, skipping.`);
    return;
  }

  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const monthStart = yesterdayStr.slice(0, 8) + '01';
  const dateDisplay = `${yesterdayStr.slice(0, 4)}/${parseInt(yesterdayStr.slice(5, 7))}/${parseInt(yesterdayStr.slice(8, 10))}`;

  console.log(`[Report] Generating for ${yesterdayStr} (month: ${monthStart})`);

  // ── Step 1: Read Data tab (month-to-date) ──
  console.log('[Report] Reading Data tab...');
  const rawData = larkCli(
    `sheets +csv-get --spreadsheet-token "${SPREADSHEET_TOKEN}" --sheet-id "${SHEET_ID_DATA}" --range "A2:DM42" --format json`
  );
  const parsedData = JSON.parse(rawData);
  if (!parsedData.ok) throw new Error(`Sheet read failed: ${JSON.stringify(parsedData.error)}`);

  const dataLines = parsedData.data.annotated_csv.split('\n');
  const dataRows = [];
  for (let i = 1; i < dataLines.length; i++) {
    const match = dataLines[i].match(/^\[row=\d+\]\s*(.+)$/);
    if (!match) continue;
    dataRows.push(parseCSVFields(match[1]));
  }

  // Build per-operator daily data
  const operators = {};
  const allDates = new Set();

  for (const op of SHEET_OPERATORS) {
    operators[op.code] = { name: op.name, daily: {} };
    for (const row of dataRows) {
      const rawDate = (row[op.startCol] || '').trim();
      const date = normalizeDate(rawDate);
      if (!date || date < monthStart || date > yesterdayStr) continue;

      const cost = parseAmount(row[op.startCol + 2]);
      const revenue = parseAmount(row[op.startCol + 3]);
      const opProfit = parseAmount(row[op.startCol + 7]); // 运营净利润
      // 纯利润 = 运营净利润 - 收入 × 7%（其他成本）
      const profit = opProfit - revenue * 0.07;
      const profitMargin = revenue > 0 ? profit / revenue : (cost > 0 ? -1 : 0);

      operators[op.code].daily[date] = { revenue, cost, profit, profitMargin };
      allDates.add(date);
    }
  }

  const dates = Array.from(allDates).sort();
  console.log(`[Report] Data: ${dates.length} days, ${dates[0]} ~ ${dates[dates.length - 1]}`);

  // ── Step 2: Generate charts ──
  console.log('[Report] Generating charts...');
  const chartJson = JSON.stringify({ dates, operators });
  const chartResult = spawnSync(
    'python3', [path.join(__dirname, 'operator-charts.py')],
    { input: chartJson, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  if (chartResult.status !== 0) {
    console.error('[Report] Chart generation failed:', chartResult.stderr);
    throw new Error('Chart generation failed');
  }
  const chartPaths = chartResult.stdout.trim().split('\n').filter(Boolean);
  console.log('[Report] Charts:', chartPaths);

  // ── Step 4: Build text report (yesterday's data) ──
  const yesterdayData = [];
  for (const op of SHEET_OPERATORS) {
    const d = operators[op.code].daily[yesterdayStr] || { cost: 0, revenue: 0, profit: 0, profitMargin: 0 };
    yesterdayData.push({ code: op.code, name: op.name, ...d });
  }
  yesterdayData.sort((a, b) => b.revenue - a.revenue);

  let textMsg = `📊 投手日报 ${dateDisplay}\n`;
  textMsg += `━━━━━━━━━━━━━━━━━━━━\n`;

  let totalCost = 0, totalRevenue = 0, totalProfit = 0;
  for (const d of yesterdayData) {
    totalCost += d.cost;
    totalRevenue += d.revenue;
    totalProfit += d.profit;
    const paddedName = d.name.length === 2 ? d.name + '\u3000\u3000' : d.name + '\u3000';
    const marginStr = d.revenue > 0 ? `${(d.profitMargin * 100).toFixed(1)}%` : '-';
    const profitStr = d.profit >= 0
      ? `+${formatAmount(d.profit)}`
      : formatAmount(d.profit);
    textMsg += `${paddedName}消耗 ${formatAmount(d.cost)} | 收入 ${formatAmount(d.revenue)} | 利润 ${profitStr} | ${marginStr}\n`;
  }
  const totalMargin = totalRevenue > 0 ? ((totalProfit / totalRevenue) * 100).toFixed(1) + '%' : '-';
  const totalProfitStr = totalProfit >= 0 ? `+${formatAmount(totalProfit)}` : formatAmount(totalProfit);
  textMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
  textMsg += `📌 合计: 消耗 ${formatAmount(totalCost)} | 收入 ${formatAmount(totalRevenue)} | 利润 ${totalProfitStr} (${totalMargin})\n`;

  // ── Step 5: @mention inactive operators ──
  const inactiveOps = yesterdayData.filter(d => d.cost === 0 && d.revenue === 0 && d.profit === 0);
  let mentionMsg = '';
  if (inactiveOps.length > 0) {
    mentionMsg = '⚠️ 以下投手昨日无数据，请检查：\n';
    for (const d of inactiveOps) {
      const openId = NAME_TO_OPEN_ID[d.name];
      if (openId) {
        mentionMsg += `<at user_id="${openId}">${d.name}</at> `;
      }
    }
    mentionMsg += '\n';
  }

  // ── Step 6: Send everything ──
  console.log('[Report] Sending text report...');
  sendMessage(textMsg);
  console.log('[Report] Text sent ✓');

  console.log('[Report] Sending revenue chart...');
  sendImage(path.resolve(chartPaths[0]));
  console.log('[Report] Revenue chart sent ✓');

  console.log('[Report] Sending margin chart...');
  sendImage(path.resolve(chartPaths[1]));
  console.log('[Report] Margin chart sent ✓');

  if (mentionMsg) {
    console.log('[Report] Sending @mentions...');
    sendMessage(mentionMsg);
    console.log('[Report] Mentions sent ✓');
  }

  console.log('[Report] All done!');
}

main();
