#!/usr/bin/env node
/**
 * 把「投放日报模板」(TAVpj9) 的 syh 个人数据补齐到「苏屹恒投放日报」的各产品×渠道分表，
 * 整行（A:L）以「文本/值」形式插入到分表顶部（row 2），补齐到昨天。
 *
 *  - 源表  SRC: spreadsheet N1FcsGvXThXu97t7ZYyccCHDnIg, sheet TAVpj9
 *           每个产品×渠道一个 block：header 行 + 3 个数据行（6/28,6/27,6/26 = 昨天/前天/大前天）
 *           数据行 A:L 已是渲染好的展示值（含 G修正收入/H投放利润/J/K/L 等公式结果）
 *  - 目标 DST: spreadsheet V7nysbQd3huZvStpd6Tcv7HUnJc（苏屹恒投放日报）
 *           各分表 row1=表头，row2 起按日期倒序（新→旧）。当前 row2=2026/6/25。
 *
 * 流程（每个分表）：
 *   1) 读 DST row2 的日期，确认与今天差距 ≤4 天（否则跳过并告警）
 *   2) 算出需要补的日期 = (row2日期, 昨天] 内、且 SRC 有的日期（最多 3 天）
 *   3) 在 DST row2 之前 insert N 行（inherit-style BEFORE：新空行落 row2.. ，老 row2 顺移到下方保留）
 *   4) 把 SRC 对应日期行的 A:L 渲染值写入新插入的行（新日期在上）。
 *      A/B 文本，C-L 数值列写「数字+格式」（不可写文本，否则「苏屹恒汇总」SUM 会 #VALUE!）。
 *
 * 用法：
 *   node backfill-personal-report-subtabs.js --dry-run
 *   node backfill-personal-report-subtabs.js
 */
const { execFileSync } = require('child_process');

const SRC_TOKEN = 'N1FcsGvXThXu97t7ZYyccCHDnIg';
const SRC_SHEET = 'TAVpj9';
const DST_TOKEN = 'V7nysbQd3huZvStpd6Tcv7HUnJc';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';
const DRY_RUN = process.argv.includes('--dry-run');

// DST 分表 sheet_id → SRC 模板 block header 行号（A:L 数据在 +1/+2/+3）
// 跳过 Luma iOS TT（模板无此 block 且分表 row2 日期超期）
const MAP = [
  { dst: 'f98d0f', name: 'GC iOS TT',        srcHeader: 1  }, // GraceChat TT
  { dst: 'gO3WRL', name: 'Dora And TT',      srcHeader: 6  },
  { dst: 'GZQTnG', name: 'Dora iOS TT',      srcHeader: 11 },
  { dst: 'JByQYJ', name: 'Doni And TT',      srcHeader: 16 }, // Doni TT
  { dst: 'g1dVST', name: 'Romi iOS TT',      srcHeader: 21 },
  { dst: 'jz1aKf', name: 'Jovia And TT',     srcHeader: 26 },
  { dst: 'E20Isf', name: 'Kira iOS TT',      srcHeader: 31 },
  { dst: 'FE8ft8', name: 'Kira And TT',      srcHeader: 36 },
  { dst: '5C1jxp', name: 'Dora And FB',      srcHeader: 41 },
  { dst: 'yrhKwG', name: 'Dora iOS FB',      srcHeader: 46 },
  { dst: '1Au4nJ', name: 'Doni And FB',      srcHeader: 51 }, // Doni FB
  { dst: '9ol8qU', name: 'Jovia And FB',     srcHeader: 56 },
  { dst: 'yAukkS', name: 'Romi And FB',      srcHeader: 61 },
  { dst: 'hIlIGO', name: 'Romi iOS FB',      srcHeader: 66 },
  { dst: 'Rux3Fa', name: 'Romi iOS FB（W2A）', srcHeader: 71 }, // Romi iOS FB(W2A)
  { dst: 'PrSj8j', name: 'Luma iOS FB',      srcHeader: 76 },
  { dst: 'AyPIvQ', name: 'Dora And GG',      srcHeader: 81 },
  { dst: 'kHPQCB', name: 'Doni And GG',      srcHeader: 86 }, // Doni GG
  { dst: 'qieWLi', name: 'Jovia And GG',     srcHeader: 91 },
  { dst: 'AjugVe', name: 'Romi And GG',      srcHeader: 96 },
  { dst: 'E8JohB', name: 'GC iOS FB',        srcHeader: 101 }, // GraceChat FB
  { dst: '9RZDYG', name: 'Kira And FB',      srcHeader: 106 },
];

function sleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }

function lark(args, input) {
  const MAX = 4; let lastErr;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      return execFileSync('lark-cli', args, {
        input: input || undefined,
        env: { ...process.env, OPENCLAW_HOME },
        encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
      });
    } catch (e) {
      lastErr = e;
      const msg = (e.stdout || '') + (e.stderr || '') + e.message;
      const retriable = /recommited|server_error|rev is|timeout|ECONN|429|rate|lock/i.test(msg);
      if (attempt < MAX && retriable) { sleep(800 * attempt); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// 读一段范围的渲染展示值（二维数组）
function getValues(token, sheetId, range) {
  const out = lark(['sheets', '+cells-get', '--spreadsheet-token', token, '--sheet-id', sheetId,
    '--range', range, '--include', 'value', '--as', 'user', '--format', 'json']);
  const d = JSON.parse(out);
  const r = d.data.ranges[0];
  return r.cells.map((row) => row.map((c) => (c && c.value != null ? c.value : '')));
}

// 解析 "2026/6/28" → Date(UTC date-only)
function parseSlash(s) {
  const m = String(s).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function fmtSlash(dt) { return `${dt.getUTCFullYear()}/${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`; }
function beijingTodayUTC() {
  const n = new Date(Date.now() + 8 * 3600 * 1000);
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
function daysBetween(a, b) { return Math.round((a - b) / 86400000); }

// 列 C..L 的目标 number_format（A日期/B渠道写文本；C-L 写数字）
const COL_NF = { 2: '$#,##0.00', 3: '0', 4: '$#,##0.00', 5: '$#,##0.00', 6: '$#,##0.00', 7: '$#,##0.00', 8: '$#,##0.00', 9: '$#,##0.00', 10: '$#,##0.00', 11: '0%' };
// 把展示文本解析成数字（$/逗号/%/负号），错误值(#DIV/0! 等)与空保留为文本
function parseNum(s) {
  if (s == null) return { err: true, raw: '' };
  const t = String(s).trim();
  if (t === '') return { err: true, raw: '' };
  if (/#(DIV\/0|REF|VALUE|N\/A|NAME|NULL|NUM)/i.test(t)) return { err: true, raw: t };
  const pct = t.endsWith('%');
  const neg = /^-/.test(t) || /^\(.*\)$/.test(t);
  let v = t.replace(/[$,%\s()-]/g, '');
  let n = Number(v);
  if (!isFinite(n)) return { err: true, raw: t };
  if (neg) n = -n;
  if (pct) n = n / 100;
  return { err: false, num: n };
}

// 写一行 A:L：A/B 文本，C-L 数值列写数字+格式（汇总 SUM 才能用）
function setRowText(sheetId, rowNum, values12) {
  const cells = [values12.map((v, ci) => {
    if (ci < 2) return { value: v == null ? '' : String(v), cell_styles: { number_format: '@' } }; // A日期/B渠道
    const p = parseNum(v);
    if (p.err) return { value: p.raw, cell_styles: { number_format: '@' } }; // #DIV/0! 等保留文本
    return { value: p.num, cell_styles: { number_format: COL_NF[ci] } };
  })];
  lark(['sheets', '+cells-set', '--spreadsheet-token', DST_TOKEN, '--sheet-id', sheetId,
    '--range', `A${rowNum}:L${rowNum}`, '--as', 'user', '--format', 'json', '--cells', '-'], JSON.stringify(cells));
}

function dimInsert(sheetId, position, count) {
  lark(['sheets', '+dim-insert', '--spreadsheet-token', DST_TOKEN, '--sheet-id', sheetId,
    '--position', String(position), '--count', String(count),
    '--inherit-style', 'before', '--as', 'user', '--format', 'json']);
}

function main() {
  const today = beijingTodayUTC();
  const yesterday = new Date(today.getTime() - 86400000);
  console.log(`[backfill] 北京今天=${fmtSlash(today)} 昨天=${fmtSlash(yesterday)} dryRun=${DRY_RUN}`);

  // 预读 SRC 模板全部数据行（A1:L130）一次
  // 注意：范围必须覆盖最后一个 block 的数据行。当前最后是 Kira And FB（header 106，数据到 109）。
  // 新增产品×渠道 block 时若超出此范围，需同步上调。
  const srcAll = getValues(SRC_TOKEN, SRC_SHEET, 'A1:L130'); // 0-based: srcAll[rowNum-1]

  const skipped = [];
  for (const blk of MAP) {
    // 1) 读 DST row2 日期
    const dstHead = getValues(DST_TOKEN, blk.dst, 'A2:B2');
    const row2date = parseSlash(dstHead[0][0]);
    if (!row2date) { skipped.push(`${blk.name}: row2 日期无法解析(${dstHead[0][0]})`); continue; }
    const gap = daysBetween(today, row2date);
    if (gap > 4) { skipped.push(`${blk.name}: row2=${fmtSlash(row2date)} 距今 ${gap} 天 >4，跳过`); continue; }
    if (gap <= 1) { skipped.push(`${blk.name}: row2=${fmtSlash(row2date)} 已是昨天/今天，无需补`); continue; }

    // 2) 需要补的日期：row2date 之后 ~ 昨天（含），且 SRC 有（SRC 只有 昨/前/大前 三天）
    const srcRows = {}; // 'date' -> A:L values
    for (let i = 1; i <= 3; i++) {
      const r = srcAll[blk.srcHeader - 1 + i]; // header+i (1-based) → 0-based idx
      if (!r) continue;
      const dt = parseSlash(r[0]);
      if (dt) srcRows[fmtSlash(dt)] = r.slice(0, 12);
    }
    // 生成待补日期列表：从昨天往回，直到 row2date（不含），最多 3 个
    const need = [];
    let cur = new Date(yesterday.getTime());
    while (daysBetween(cur, row2date) >= 1 && need.length < 3) {
      const key = fmtSlash(cur);
      if (srcRows[key]) need.push(key);
      cur = new Date(cur.getTime() - 86400000);
    }
    if (!need.length) { skipped.push(`${blk.name}: 无可补日期（row2=${fmtSlash(row2date)}）`); continue; }
    // need 现在是 [昨天, 前天, ...]（新→旧），正好对应插入后从 row2 往下
    const n = need.length;
    console.log(`  ${blk.name.padEnd(20)} row2=${fmtSlash(row2date)} → 补 ${n} 天: ${need.join(', ')}`);
    if (DRY_RUN) {
      for (let i = 0; i < n; i++) console.log(`      row${2 + i} <= ${need[i]}  ${srcRows[need[i]].join(' | ')}`);
      continue;
    }
    // 3) 插入 n 行（在 row2 之前）
    dimInsert(blk.dst, 2, n);
    sleep(400);
    // 4) 写入：need[0]（昨天/最新）→ row2，need[1] → row3 ...
    for (let i = 0; i < n; i++) {
      setRowText(blk.dst, 2 + i, srcRows[need[i]]);
      sleep(250);
    }
  }

  console.log('\n[backfill] 跳过/告警：');
  if (skipped.length) skipped.forEach((s) => console.log('  - ' + s));
  else console.log('  （无）');
  console.log('\n[backfill] 注：Luma iOS TT 未在映射内（模板无此 block，分表 row2=2026/3/12 超期），按规则跳过。');
}

main();
