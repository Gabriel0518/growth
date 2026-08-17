#!/usr/bin/env node
/**
 * Operator Sheet Data — reads operator data from Feishu sheet (Data tab)
 * Replaces operator-multiday-data.js (which read from XMP cache + AF DB)
 *
 * Data source: Feishu wiki sheet "投手排行榜"
 *   - Wiki token: U8okwa43Yi9EoMkRRS3cmA5Dn6f
 *   - Spreadsheet token: QF2UsntX6hCRwwtqTXlc4GQsnFd
 *   - Sheet: Data (sheet_id: YiWQtE)
 *
 * Each operator has 9 columns (8 data + 1 separator):
 *   col1: 日期, col2: 渠道, col3: 消耗, col4: 总收入, col5: 投放利润,
 *   col6: 返点, col7: 主播/PWA成本, col8: 运营净利润, col9: (empty separator)
 *
 * "其他" block has 4 data columns: 日期, 消耗, 总收入, 运营净利润
 *
 * Outputs JSON to stdout in the same format as operator-multiday-data.js:
 * {
 *   dates: ["YYYY-MM-DD", ...],
 *   operators: {
 *     code: {
 *       name: "中文名",
 *       daily: { "YYYY-MM-DD": { revenue, cost, profit, profitMargin } }
 *     }
 *   }
 * }
 *
 * Also outputs a separate JSON for the text report to stderr:
 *   ---TEXTDATA---
 *   { yesterday data per operator for text report }
 *   ---END---
 */
const { execSync } = require('child_process');
const path = require('path');

const SPREADSHEET_TOKEN = 'QF2UsntX6hCRwwtqTXlc4GQsnFd';
const SHEET_ID = 'YiWQtE';

// Operator layout in the sheet (row 1 names, starting from column F)
// Each operator occupies 9 columns (8 data + 1 separator)
// Order in sheet: 苏屹恒, 曹永麟, 刘欢, 武春香, 张梦凡, 张苗, 马崇岩, 杨梅亭, 陈祎, 王维维, 张嘉铖, 吴天越
const SHEET_OPERATORS = [
  { code: 'syh', name: '苏屹恒', startCol: 5 },   // F (0-indexed: 5)
  { code: 'cyl', name: '曹永麟', startCol: 14 },   // O
  { code: 'lh',  name: '刘欢',   startCol: 23 },   // X
  { code: 'wcx', name: '武春香', startCol: 32 },   // AG
  { code: 'zmf', name: '张梦凡', startCol: 41 },   // AP
  { code: 'zm1', name: '张苗',   startCol: 50 },   // AY
  { code: 'mcy', name: '马崇岩', startCol: 59 },   // BH
  { code: 'ymt', name: '杨梅亭', startCol: 68 },   // BQ
  { code: 'cy1', name: '陈祎',   startCol: 77 },   // BZ
  { code: 'wvv', name: '王维维', startCol: 86 },   // CI
  { code: 'zjc', name: '张嘉铖', startCol: 95 },   // CR
  { code: 'wty', name: '吴天越', startCol: 104 },  // DA
];

function colLetter(idx) {
  // Convert 0-based column index to Excel-style letter(s)
  let s = '';
  let n = idx;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

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
  // Convert "2026/6/8" to "2026-06-08"
  if (!dateStr) return null;
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return null;
  return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
}

function main() {
  // Determine date range: 1st of current month to yesterday
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const monthStart = yesterdayStr.slice(0, 8) + '01';

  console.error(`[SheetData] Reading data for ${monthStart} ~ ${yesterdayStr}`);

  // Read a large enough range to cover all operators + all dates this month
  // Operators span columns F to DM (113 columns), data starts at row 3
  // We need up to ~40 rows (row 2 is header, row 3 onwards is data)
  const range = 'A2:DM42';

  console.error('[SheetData] Fetching sheet data...');
  const rawOutput = larkCli(
    `sheets +csv-get --spreadsheet-token "${SPREADSHEET_TOKEN}" --sheet-id "${SHEET_ID}" --range "${range}" --format json`
  );
  const parsed = JSON.parse(rawOutput);
  if (!parsed.ok) {
    throw new Error(`Failed to read sheet: ${JSON.stringify(parsed.error)}`);
  }

  const csv = parsed.data.annotated_csv;
  const lines = csv.split('\n');

  // Parse all lines into fields array (skip header row which is line 0)
  const dataRows = [];
  for (let i = 1; i < lines.length; i++) {
    const match = lines[i].match(/^\[row=\d+\]\s*(.+)$/);
    if (!match) continue;
    dataRows.push(parseCSVFields(match[1]));
  }

  console.error(`[SheetData] Parsed ${dataRows.length} data rows`);

  // Build per-operator daily data
  const operators = {};
  const allDates = new Set();

  for (const op of SHEET_OPERATORS) {
    operators[op.code] = { name: op.name, daily: {} };

    for (const row of dataRows) {
      const dateCol = op.startCol;     // col 1: date
      const costCol = op.startCol + 2; // col 3: 消耗
      const revCol = op.startCol + 3;  // col 4: 总收入
      const profitCol = op.startCol + 7; // col 8: 运营净利润

      const rawDate = (row[dateCol] || '').trim();
      const date = normalizeDate(rawDate);
      if (!date) continue;

      // Filter to current month range
      if (date < monthStart || date > yesterdayStr) continue;

      const cost = parseAmount(row[costCol]);
      const revenue = parseAmount(row[revCol]);
      const opProfit = parseAmount(row[profitCol]); // 运营净利润
      // 纯利润 = 运营净利润 - 收入 × 7%（其他成本）
      const profit = opProfit - revenue * 0.07;
      const profitMargin = revenue > 0 ? profit / revenue : (cost > 0 ? -1 : 0);

      operators[op.code].daily[date] = { revenue, cost, profit, profitMargin };
      allDates.add(date);
    }
  }

  // Sort dates ascending
  const dates = Array.from(allDates).sort();

  console.error(`[SheetData] Date range: ${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length} days)`);

  // Output JSON for charts (to stdout)
  const output = { dates, operators };
  process.stdout.write(JSON.stringify(output));

  console.error('[SheetData] Done');
}

main();
