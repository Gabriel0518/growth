#!/usr/bin/env node
/**
 * Operator Daily Report — 5 PM Double-Check
 *
 * Re-checks which operators still have NO data for yesterday (cost=0 & revenue=0 & profit=0).
 * - If some are still missing: @mention them again in the group.
 * - If all are filled in: send "投手日报全部完成 [撒花][撒花]".
 *
 * Reuses the same data source + inactive-detection logic as operator-report-v2.js,
 * but does NOT regenerate the text report or charts.
 *
 * Schedule: 17:00 on workdays (cron). Skips non-workdays just like the main report.
 */
const { execSync, spawnSync } = require('child_process');
const path = require('path');

// ── 2026 China workday calendar (kept in sync with operator-report-v2.js) ──
const HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]);
const MAKEUP_WORKDAYS_2026 = new Set([
  '2026-01-04', '2026-02-14', '2026-02-28',
  '2026-05-09', '2026-09-20', '2026-10-10',
]);

function isWorkday(dateStr) {
  if (MAKEUP_WORKDAYS_2026.has(dateStr)) return true;
  if (HOLIDAYS_2026.has(dateStr)) return false;
  const d = new Date(dateStr + 'T12:00:00+08:00');
  const dow = d.getDay();
  return dow >= 1 && dow <= 5;
}

const SPREADSHEET_TOKEN = 'QF2UsntX6hCRwwtqTXlc4GQsnFd';
const SHEET_ID_DATA = 'YiWQtE';
const CHAT_ID = 'oc_6518b783dd17e543f84d1636ee380598'; // 投放UG群
const LARK_CLI = path.join(process.env.HOME, '.npm-global/bin/lark-cli');

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

const SEND_MAX_RETRIES = 2;     // retry up to 2 times after initial failure
const SEND_RETRY_DELAY = 60000; // 1 minute between retries

function sendMessage(text) {
  let lastError;
  for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[Check] sendMessage retry ${attempt}/${SEND_MAX_RETRIES} after ${SEND_RETRY_DELAY / 1000}s...`);
      execSync(`sleep ${SEND_RETRY_DELAY / 1000}`);
    }
    const result = spawnSync(
      LARK_CLI,
      ['im', '+messages-send', '--as', 'bot', '--chat-id', CHAT_ID, '--text', text],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}` } }
    );
    if (result.status === 0) return;
    lastError = result.stderr || result.stdout;
    console.error(`[Check] Send failed (attempt ${attempt + 1}/${SEND_MAX_RETRIES + 1}):`, lastError);
  }
  console.error('[Check] Send failed after all retries');
  throw new Error('Failed to send message after retries');
}

// ── Main ──

function main() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const todayStr = now.toISOString().slice(0, 10);

  // Skip non-workdays (same rule as the 14:30 report)
  if (!isWorkday(todayStr)) {
    console.log(`[Check] Today ${todayStr} is not a workday, skipping.`);
    return;
  }

  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const dateDisplay = `${yesterdayStr.slice(0, 4)}/${parseInt(yesterdayStr.slice(5, 7))}/${parseInt(yesterdayStr.slice(8, 10))}`;

  console.log(`[Check] Double-checking operator data for ${yesterdayStr}`);

  // ── Read Data tab (only need yesterday's row per operator) ──
  console.log('[Check] Reading Data tab...');
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

  // For each operator, find yesterday's cost/revenue/opProfit
  const inactiveOps = [];
  for (const op of SHEET_OPERATORS) {
    let cost = 0, revenue = 0, opProfit = 0, found = false;
    for (const row of dataRows) {
      const date = normalizeDate((row[op.startCol] || '').trim());
      if (date !== yesterdayStr) continue;
      cost = parseAmount(row[op.startCol + 2]);
      revenue = parseAmount(row[op.startCol + 3]);
      opProfit = parseAmount(row[op.startCol + 7]);
      found = true;
      break;
    }
    const profit = opProfit - revenue * 0.07;
    // Same "no data" rule as the main report
    if (cost === 0 && revenue === 0 && profit === 0) {
      inactiveOps.push(op);
    }
  }

  if (inactiveOps.length > 0) {
    console.log(`[Check] Still missing: ${inactiveOps.map(o => o.name).join(', ')}`);
    let mentionMsg = `⏰ 投手日报二次检查（${dateDisplay}）\n以下投手仍未填写数据，请尽快补充：\n`;
    for (const op of inactiveOps) {
      const openId = NAME_TO_OPEN_ID[op.name];
      if (openId) {
        mentionMsg += `<at user_id="${openId}">${op.name}</at> `;
      }
    }
    mentionMsg += '\n';
    sendMessage(mentionMsg);
    console.log('[Check] Re-mention sent ✓');
  } else {
    console.log('[Check] All operators have data — sending completion message.');
    sendMessage('🎉 投手日报全部完成 [撒花][撒花]');
    console.log('[Check] Completion message sent ✓');
  }

  console.log('[Check] Done!');
}

main();
