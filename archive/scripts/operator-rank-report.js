#!/usr/bin/env node
/**
 * Operator Rank Report
 * Reads rank table (A1:H14) from Feishu wiki sheet, formats each operator's data,
 * and sends to the operator daily report group.
 * @mentions operators who have no data (cost=0, revenue=0, profit=0).
 */
const { execSync } = require('child_process');

const SPREADSHEET_TOKEN = 'QF2UsntX6hCRwwtqTXlc4GQsnFd';
const SHEET_ID = 'dDfdNe';
const CHAT_ID = 'oc_15b383a83d008af776490affcd889b40';

// Name → open_id mapping (all 12 operators)
const NAME_TO_OPEN_ID = {
  '苏屹恒': 'ou_b2467dac5ff1d686fb48ccf1fbaa0c0d',
  '张苗': 'ou_0855b5e9f6635d738079bf2333af09ac',
  '曹永麟': 'ou_e0d4ac89c1e74f098fa131f5da37fc51',
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

function larkCli(args) {
  const cmd = `export PATH=~/.npm-global/bin:$PATH && set +H && lark-cli ${args}`;
  const result = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  return result;
}

function parseAmount(s) {
  if (!s) return 0;
  // Remove $, commas, quotes, whitespace
  const cleaned = s.replace(/[$,"\s]/g, '');
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

function formatAmount(val) {
  if (val === 0) return '$0.00';
  const prefix = val < 0 ? '-$' : '$';
  const abs = Math.abs(val);
  return prefix + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function main() {
  // 1. Read the rank table
  console.log('[RankReport] Reading rank table...');
  const rawOutput = larkCli(
    `sheets +csv-get --spreadsheet-token "${SPREADSHEET_TOKEN}" --sheet-id "${SHEET_ID}" --range "A1:H14" --format json`
  );
  const parsed = JSON.parse(rawOutput);
  if (!parsed.ok) {
    throw new Error(`Failed to read sheet: ${JSON.stringify(parsed.error)}`);
  }

  const csv = parsed.data.annotated_csv;
  const lines = csv.split('\n');

  // Parse the three ranking columns
  // A-B: 姓名 + 昨日消耗
  // D-E: 姓名 + 昨日收入
  // G-H: 姓名 + 昨日利润
  // Skip row 1 (headers)

  const costRank = [];    // { name, value }
  const revenueRank = [];
  const profitRank = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Extract row content after [row=N]
    const match = line.match(/^\[row=\d+\]\s*(.+)$/);
    if (!match) continue;

    // Parse CSV fields (handling quoted values with commas)
    const fields = parseCSVFields(match[1]);
    // fields: [A, B, C, D, E, F, G, H]

    const costName = (fields[0] || '').trim();
    const costVal = parseAmount(fields[1]);
    const revName = (fields[3] || '').trim();
    const revVal = parseAmount(fields[4]);
    const profName = (fields[6] || '').trim();
    const profVal = parseAmount(fields[7]);

    if (costName && costName !== '其他') costRank.push({ name: costName, value: costVal });
    if (revName && revName !== '其他') revenueRank.push({ name: revName, value: revVal });
    if (profName && profName !== '其他') profitRank.push({ name: profName, value: profVal });
  }

  // 2. Merge per-operator data
  const operators = {};
  for (const name of Object.keys(NAME_TO_OPEN_ID)) {
    operators[name] = { cost: 0, revenue: 0, profit: 0 };
  }

  for (const { name, value } of costRank) {
    if (operators[name]) operators[name].cost = value;
  }
  for (const { name, value } of revenueRank) {
    if (operators[name]) operators[name].revenue = value;
  }
  for (const { name, value } of profitRank) {
    if (operators[name]) operators[name].profit = value;
  }

  // 3. Build message
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;

  let msg = `📊 投手排行榜（${dateStr}）\n\n`;

  // Sort operators by revenue descending
  const sortedOps = Object.entries(operators).sort((a, b) => b[1].revenue - a[1].revenue);

  // Active operators (have any data)
  const activeOps = sortedOps.filter(([_, d]) => d.cost !== 0 || d.revenue !== 0 || d.profit !== 0);
  const inactiveOps = sortedOps.filter(([_, d]) => d.cost === 0 && d.revenue === 0 && d.profit === 0);

  // Rankings section
  msg += '🏆 消耗排行\n';
  costRank.forEach((item, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    msg += `${medal} ${item.name}  ${formatAmount(item.value)}\n`;
  });

  msg += '\n💰 收入排行\n';
  revenueRank.forEach((item, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    msg += `${medal} ${item.name}  ${formatAmount(item.value)}\n`;
  });

  msg += '\n📈 利润排行\n';
  profitRank.forEach((item, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    msg += `${medal} ${item.name}  ${formatAmount(item.value)}\n`;
  });

  // Inactive operators - @ them
  if (inactiveOps.length > 0) {
    msg += '\n⚠️ 以下投手昨日无数据，请检查：\n';
    for (const [name] of inactiveOps) {
      const openId = NAME_TO_OPEN_ID[name];
      if (openId) {
        msg += `<at user_id="${openId}">${name}</at> `;
      }
    }
    msg += '\n';
  }

  console.log('[RankReport] Message built:');
  console.log(msg);

  // 4. Send to Feishu group
  console.log('[RankReport] Sending to Feishu group...');

  // Use --text which supports <at> tags in text msg_type
  // Write msg to temp file and cat it in to avoid shell escaping
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpFile = path.join(os.tmpdir(), 'rank-report-msg.txt');
  fs.writeFileSync(tmpFile, msg);

  // Read file content and pass as --text argument by escaping for shell
  // Alternative: use Node spawn to avoid shell escaping entirely
  const { spawnSync } = require('child_process');
  const result = spawnSync(
    path.join(process.env.HOME, '.npm-global/bin/lark-cli'),
    ['im', '+messages-send', '--as', 'bot', '--chat-id', CHAT_ID, '--text', msg],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}` } }
  );

  if (result.status !== 0) {
    console.error('[RankReport] Send failed:', result.stderr || result.stdout);
    throw new Error('Failed to send message');
  }

  console.log('[RankReport] Sent successfully!');
}

/**
 * Parse CSV line handling quoted fields with commas
 */
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

main();
