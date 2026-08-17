#!/usr/bin/env node
/**
 * 一次性修正：「苏屹恒汇总」(jv5kT4) 新渠道 GC iOS FB / Kira And FB 的跨表引用行号错位。
 *
 * 背景：新渠道被追加进汇总求和公式时，行号被写死成 !2（如 'GC iOS FB'!C2），
 *      而原有渠道正确跟随行号（C2/C3/C4...）。导致汇总第 R 行（R≥3）错拉新渠道 row2 的数。
 *
 * 修正：对汇总目标行（默认 row3、row4，对应 7/4、7/3），把这两个新渠道引用里
 *      "!<字母>2" 的行号 2 → 该汇总行号 R，其余引用与公式结构完全不动。
 *
 * 安全：只替换 'GC iOS FB'!XN 和 'Kira And FB'!XN 两个 sheet 名后紧跟的行号；
 *      逐行读→改→写，dry-run 打印 before/after 供核对。
 *
 * 用法：
 *   node fix-summary-newchannel-refs.js --dry-run
 *   node fix-summary-newchannel-refs.js            # 修 row3,row4
 *   node fix-summary-newchannel-refs.js --rows 3,4
 */
const { execFileSync } = require('child_process');
const T = 'V7nysbQd3huZvStpd6Tcv7HUnJc';
const SUM_SHEET = 'jv5kT4';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';
const DRY = process.argv.includes('--dry-run');
const NEW_CHANNELS = ['GC iOS FB', 'Kira And FB'];

const rowsArg = (() => {
  const i = process.argv.indexOf('--rows');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1].split(',').map((n) => parseInt(n, 10));
  return [3, 4];
})();

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

function sleep(ms) { const s = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(s), 0, 0, ms); }
function lark(args, input) {
  const MAX = 4; let e;
  for (let a = 1; a <= MAX; a++) {
    try { return execFileSync('lark-cli', args, { input: input || undefined, env: { ...process.env, OPENCLAW_HOME }, encoding: 'utf8', maxBuffer: 2e7 }); }
    catch (err) { e = err; const m = (err.stdout || '') + (err.stderr || '') + err.message; if (a < MAX && /recommited|server_error|rev is|timeout|ECONN|429|rate|lock/i.test(m)) { sleep(800 * a); continue; } throw err; }
  }
  throw e;
}
function getRow(range) {
  return JSON.parse(lark(['sheets', '+cells-get', '--spreadsheet-token', T, '--sheet-id', SUM_SHEET, '--range', range, '--include', 'value,formula', '--as', 'user', '--format', 'json'])).data.ranges[0];
}
function setRow(range, cells) {
  lark(['sheets', '+cells-set', '--spreadsheet-token', T, '--sheet-id', SUM_SHEET, '--range', range, '--as', 'user', '--format', 'json', '--cells', '-'], JSON.stringify(cells));
}

// 把公式里 'GC iOS FB'!<col><num> 和 'Kira And FB'!<col><num> 的 num → R
function retargetNewChannels(formula, R) {
  if (typeof formula !== 'string' || !formula.startsWith('=')) return { changed: false, out: formula };
  let out = formula; let changed = false;
  for (const ch of NEW_CHANNELS) {
    // 匹配 'CH'!<字母>数字  （字母1+，数字1-3位）
    const re = new RegExp(`('${ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'!)([A-Z]+)(\\d{1,3})`, 'g');
    out = out.replace(re, (m, p1, col, num) => {
      if (num !== String(R)) { changed = true; return `${p1}${col}${R}`; }
      return m;
    });
  }
  return { changed, out };
}

function main() {
  console.log(`[fix-sum-newch] dryRun=${DRY} rows=${rowsArg.join(',')} channels=${NEW_CHANNELS.join(', ')}`);
  for (const R of rowsArg) {
    const range = `A${R}:L${R}`;
    const rr = getRow(range);
    const dateVal = (rr.cells[0][0] || {}).value;
    const newCells = [];
    let anyChange = false;
    rr.cells[0].forEach((c, i) => {
      const col = COLS[i];
      const f = (c && c.formula) || null;
      if (col === 'A') { newCells.push({ value: dateVal }); return; }
      if (col === 'B') { newCells.push({ value: (c && c.value) || 'TT/FB/GG' }); return; }
      if (!f) { newCells.push({ value: (c && c.value != null) ? c.value : '' }); return; }
      const { changed, out } = retargetNewChannels(f, R);
      if (changed) { anyChange = true; console.log(`  row${R} ${col}: retarget new-channel refs -> !${R}`); }
      newCells.push({ formula: out });
    });
    if (!anyChange) { console.log(`  row${R} (${dateVal}): 新渠道引用已对齐，无需改`); continue; }
    if (DRY) { console.log(`  row${R} (${dateVal}): [dry-run] 将写回修正公式`); continue; }
    setRow(range, [newCells]);
    console.log(`  row${R} (${dateVal}): 已写回`);
    sleep(400);
  }
  console.log('[fix-sum-newch] done');
}
main();
