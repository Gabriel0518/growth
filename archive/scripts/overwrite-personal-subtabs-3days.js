#!/usr/bin/env node
/**
 * 一次性修正工具：原地覆盖「苏屹恒投放日报」20 个产品×渠道分表最近三天（row2/3/4）的值。
 *
 * 背景：backfill-personal-report-subtabs.js 是 insert-only（日期在就跳过），
 *      无法修正「日期已在、但值是过时/错误」的情况。
 *      本脚本从模板 SRC（已由 fill-personal-daily-report.js 刷新为最新）读三天，
 *      按日期严格匹配后原地 cells-set 覆盖分表 row2/3/4，不插行、不改行数。
 *
 * 安全校验：分表 row2/3/4 的日期(A列)必须与模板对应 block 的三行日期逐一相等，
 *          否则该分表跳过并告警（不写）。
 *
 * 复用 backfill 脚本的 MAP / getValues / setRowText / parseSlash / fmtSlash 写法。
 *
 * 用法：
 *   node overwrite-personal-subtabs-3days.js --dry-run
 *   node overwrite-personal-subtabs-3days.js
 */
const { execFileSync } = require('child_process');

const SRC_TOKEN = 'N1FcsGvXThXu97t7ZYyccCHDnIg';
const SRC_SHEET = 'TAVpj9';
const DST_TOKEN = 'V7nysbQd3huZvStpd6Tcv7HUnJc';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';
const DRY_RUN = process.argv.includes('--dry-run');

const MAP = [
  { dst: 'f98d0f', name: 'GC iOS TT',        srcHeader: 1  },
  { dst: 'gO3WRL', name: 'Dora And TT',      srcHeader: 6  },
  { dst: 'GZQTnG', name: 'Dora iOS TT',      srcHeader: 11 },
  { dst: 'JByQYJ', name: 'Doni And TT',      srcHeader: 16 },
  { dst: 'g1dVST', name: 'Romi iOS TT',      srcHeader: 21 },
  { dst: 'jz1aKf', name: 'Jovia And TT',     srcHeader: 26 },
  { dst: 'E20Isf', name: 'Kira iOS TT',      srcHeader: 31 },
  { dst: 'FE8ft8', name: 'Kira And TT',      srcHeader: 36 },
  { dst: '5C1jxp', name: 'Dora And FB',      srcHeader: 41 },
  { dst: 'yrhKwG', name: 'Dora iOS FB',      srcHeader: 46 },
  { dst: '1Au4nJ', name: 'Doni And FB',      srcHeader: 51 },
  { dst: '9ol8qU', name: 'Jovia And FB',     srcHeader: 56 },
  { dst: 'yAukkS', name: 'Romi And FB',      srcHeader: 61 },
  { dst: 'hIlIGO', name: 'Romi iOS FB',      srcHeader: 66 },
  { dst: 'Rux3Fa', name: 'Romi iOS FB（W2A）', srcHeader: 71 },
  { dst: 'PrSj8j', name: 'Luma iOS FB',      srcHeader: 76 },
  { dst: 'AyPIvQ', name: 'Dora And GG',      srcHeader: 81 },
  { dst: 'kHPQCB', name: 'Doni And GG',      srcHeader: 86 },
  { dst: 'qieWLi', name: 'Jovia And GG',     srcHeader: 91 },
  { dst: 'AjugVe', name: 'Romi And GG',      srcHeader: 96 },
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

function getValues(token, sheetId, range) {
  const out = lark(['sheets', '+cells-get', '--spreadsheet-token', token, '--sheet-id', sheetId,
    '--range', range, '--include', 'value', '--as', 'user', '--format', 'json']);
  const d = JSON.parse(out);
  const r = d.data.ranges[0];
  return r.cells.map((row) => row.map((c) => (c && c.value != null ? c.value : '')));
}

function parseSlash(s) {
  const m = String(s).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function fmtSlash(dt) { return `${dt.getUTCFullYear()}/${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`; }

const COL_NF = { 2: '$#,##0.00', 3: '0', 4: '$#,##0.00', 5: '$#,##0.00', 6: '$#,##0.00', 7: '$#,##0.00', 8: '$#,##0.00', 9: '$#,##0.00', 10: '$#,##0.00', 11: '0%' };
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

function setRowText(sheetId, rowNum, values12) {
  const cells = [values12.map((v, ci) => {
    if (ci < 2) return { value: v == null ? '' : String(v), cell_styles: { number_format: '@' } };
    const p = parseNum(v);
    if (p.err) return { value: p.raw, cell_styles: { number_format: '@' } };
    return { value: p.num, cell_styles: { number_format: COL_NF[ci] } };
  })];
  lark(['sheets', '+cells-set', '--spreadsheet-token', DST_TOKEN, '--sheet-id', sheetId,
    '--range', `A${rowNum}:L${rowNum}`, '--as', 'user', '--format', 'json', '--cells', '-'], JSON.stringify(cells));
}

function main() {
  console.log(`[overwrite-3d] dryRun=${DRY_RUN}`);
  const srcAll = getValues(SRC_TOKEN, SRC_SHEET, 'A1:L99'); // 0-based: srcAll[rowNum-1]

  const skipped = [];
  let wroteRows = 0, wroteTabs = 0;
  for (const blk of MAP) {
    // 模板三行（header+1/+2/+3）
    const srcRows = [];
    for (let i = 1; i <= 3; i++) {
      const r = srcAll[blk.srcHeader - 1 + i];
      srcRows.push(r ? r.slice(0, 12) : null);
    }
    if (srcRows.some((r) => !r || !parseSlash(r[0]))) {
      skipped.push(`${blk.name}: 模板三行日期不全，跳过`);
      continue;
    }
    // 分表 row2:4
    const dst = getValues(DST_TOKEN, blk.dst, 'A2:L4');
    if (dst.length < 3) { skipped.push(`${blk.name}: 分表读不到 row2:4，跳过`); continue; }

    // 日期逐行严格校验
    let mismatch = null;
    for (let i = 0; i < 3; i++) {
      const sd = parseSlash(srcRows[i][0]);
      const dd = parseSlash(dst[i][0]);
      if (!dd || fmtSlash(sd) !== fmtSlash(dd)) {
        mismatch = `row${2 + i} 模板=${fmtSlash(sd)} 分表=${dd ? fmtSlash(dd) : dst[i][0]}`;
        break;
      }
    }
    if (mismatch) { skipped.push(`${blk.name}: 日期不一致(${mismatch})，跳过不写`); continue; }

    // 计算 diff（仅日志用，C=消耗 F=原始收入 G=修正收入）
    const diffs = [];
    for (let i = 0; i < 3; i++) {
      const changed = [];
      for (let c = 2; c < 12; c++) {
        if (String(srcRows[i][c]) !== String(dst[i][c])) changed.push(c);
      }
      if (changed.length) diffs.push(`${fmtSlash(parseSlash(srcRows[i][0]))}:列[${changed.join(',')}]`);
    }
    console.log(`  ${blk.name.padEnd(20)} ${diffs.length ? '变更 ' + diffs.join('  ') : '无变更'}`);
    if (DRY_RUN) {
      for (let i = 0; i < 3; i++) {
        console.log(`      row${2 + i} <= ${srcRows[i].slice(0, 7).join(' | ')}`);
      }
      continue;
    }

    // 原地覆盖 row2/3/4
    for (let i = 0; i < 3; i++) {
      setRowText(blk.dst, 2 + i, srcRows[i]);
      sleep(250);
      wroteRows++;
    }
    wroteTabs++;
  }

  console.log(`\n[overwrite-3d] ${DRY_RUN ? '(dry-run) ' : ''}写入分表=${wroteTabs} 行=${wroteRows}`);
  console.log('[overwrite-3d] 跳过/告警：');
  if (skipped.length) skipped.forEach((s) => console.log('  - ' + s));
  else console.log('  （无）');
}

main();
