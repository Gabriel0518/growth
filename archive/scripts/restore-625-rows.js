#!/usr/bin/env node
/**
 * 恢复各分表丢失的 2026/6/25 行（因 dim-insert inherit-style 把 row2 清空）。
 * 方法：在模板 TAVpj9 的空白 scratch 区（row 150 起）按每个 block 的公式重算 6/25 的 A:L，
 *       读渲染值后写回各分表的 6/25 行（当前是空白 row5），最后清理 scratch。
 */
const { execFileSync } = require('child_process');
const SRC_TOKEN = 'N1FcsGvXThXu97t7ZYyccCHDnIg';
const SRC_SHEET = 'TAVpj9';
const DST_TOKEN = 'V7nysbQd3huZvStpd6Tcv7HUnJc';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';
const DRY = process.argv.includes('--dry-run');

const blockFormulas = require('/tmp/block_formulas.json');
// dashboard 6/25 数据（product|channel → {cost,installs,rev}）
const D625 = require('/tmp/d625.json');

// 分表 sheet_id → block key（与模板 block_formulas 的 key 对齐）
const MAP = [
  ['f98d0f', 'GraceChat|TT'], ['gO3WRL', 'Dora And|TT'], ['GZQTnG', 'Dora iOS|TT'], ['JByQYJ', 'Doni|TT'],
  ['g1dVST', 'Romi iOS|TT'], ['jz1aKf', 'Jovia And|TT'], ['E20Isf', 'Kira iOS|TT'], ['FE8ft8', 'Kira And|TT'],
  ['5C1jxp', 'Dora And|FB'], ['yrhKwG', 'Dora iOS|FB'], ['1Au4nJ', 'Doni|FB'], ['9ol8qU', 'Jovia And|FB'],
  ['yAukkS', 'Romi And|FB'], ['hIlIGO', 'Romi iOS|FB'], ['Rux3Fa', 'Romi iOS|FB W2A'], ['PrSj8j', 'Luma|FB'],
  ['AyPIvQ', 'Dora And|GG'], ['kHPQCB', 'Doni|GG'], ['qieWLi', 'Jovia And|GG'], ['AjugVe', 'Romi And|GG'],
];

function sleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }
function lark(args, input) {
  const MAX = 4; let lastErr;
  for (let a = 1; a <= MAX; a++) {
    try { return execFileSync('lark-cli', args, { input: input || undefined, env: { ...process.env, OPENCLAW_HOME }, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); }
    catch (e) { lastErr = e; const m = (e.stdout || '') + (e.stderr || '') + e.message; if (a < MAX && /recommited|server_error|rev is|timeout|ECONN|429|rate|lock/i.test(m)) { sleep(800 * a); continue; } throw e; }
  }
  throw lastErr;
}
function getRange(token, sheet, range, include) {
  const out = lark(['sheets', '+cells-get', '--spreadsheet-token', token, '--sheet-id', sheet, '--range', range, '--include', include || 'value', '--as', 'user', '--format', 'json']);
  return JSON.parse(out).data.ranges[0];
}
function setCells(token, sheet, range, cells) {
  lark(['sheets', '+cells-set', '--spreadsheet-token', token, '--sheet-id', sheet, '--range', range, '--as', 'user', '--format', 'json', '--cells', '-'], JSON.stringify(cells));
}

// 把公式从 srcRow 重定向到 dstRow（替换行号引用，如 C92→C150, A92→A150）
function retarget(formula, srcRow, dstRow) {
  if (!formula) return null;
  // 只替换 "字母+srcRow" 形式中针对本行的相对引用：A/B/C/D/E/F/G/H/I/J/K/L + srcRow（非 $ 锁定的行）
  const re = new RegExp(`([A-L])${srcRow}\\b`, 'g');
  return formula.replace(re, (mm, col) => `${col}${dstRow}`);
}

const SCRATCH_START = 150; // 模板空白区

function main() {
  // 1) 在 scratch 区为每个 block 写一行：A=6/25, B=渠道, C/D/F=dashboard, E/G/H/I/J/K/L=公式（retarget）
  const plan = [];
  MAP.forEach((m, idx) => {
    const [dstSheet, key] = m;
    const bf = blockFormulas[key];
    const dd = D625[key] || { cost: 0, installs: 0, rev: 0 };
    const sRow = SCRATCH_START + idx;
    plan.push({ dstSheet, key, sRow, dd, bf });
  });

  if (!DRY) {
    console.log('[restore] 写 scratch 公式行...');
    // 列 → number_format（对齐模板分表展示）
    const NF = { C: '$#,##0.00', D: '0', E: '$#,##0.00', F: '$#,##0.00', G: '$#,##0.00', H: '$#,##0.00', I: '$#,##0.00', J: '$#,##0.00', K: '$#,##0.00', L: '0%' };
    for (const p of plan) {
      const { sRow, dd, bf } = p;
      // 公式列：有公式用 retarget 公式，无公式（静态）则用原值
      function fcell(col, nf) {
        const f = retarget(bf.cells[col].f, bf.dr, sRow);
        if (f) return { formula: f, cell_styles: { number_format: nf } };
        const raw = bf.cells[col].v;
        const num = typeof raw === 'string' ? Number(String(raw).replace(/[$,%\s]/g, '')) : raw;
        return { value: Number.isFinite(num) ? num : 0, cell_styles: { number_format: nf } };
      }
      const cells = [[
        { value: '2026/6/25' },                                   // A 日期
        { value: bf.cells.B.v || '' },                            // B 渠道
        { value: dd.cost, cell_styles: { number_format: NF.C } },  // C 消耗
        { value: dd.installs, cell_styles: { number_format: NF.D } }, // D 男生人数
        fcell('E', NF.E),                                          // E 单价
        { value: dd.rev, cell_styles: { number_format: NF.F } },    // F 原始收入
        fcell('G', NF.G),                                          // G 修正收入
        fcell('H', NF.H),                                          // H 投放利润
        { value: 0, cell_styles: { number_format: NF.I } },        // I 返点
        fcell('J', NF.J),                                          // J 主播/PWA成本
        fcell('K', NF.K),                                          // K 运营净利润
        fcell('L', NF.L),                                          // L 总roas
      ]];
      setCells(SRC_TOKEN, SRC_SHEET, `A${sRow}:L${sRow}`, cells);
      sleep(200);
    }
    sleep(2000); // 等公式计算
  }

  // 2) 读 scratch 渲染值
  console.log('[restore] 读 scratch 渲染值...');
  const r = DRY ? null : getRange(SRC_TOKEN, SRC_SHEET, `A${SCRATCH_START}:L${SCRATCH_START + MAP.length - 1}`, 'value');
  const rendered = {};
  if (!DRY) {
    r.cells.forEach((row, i) => { rendered[SCRATCH_START + i] = row.map((c) => (c && c.value != null ? c.value : '')); });
  }

  // 3) 写回各分表 6/25 行（当前空白 row5）
  console.log('[restore] 写回各分表 row5 (6/25)...');
  for (const p of plan) {
    // 找到该分表中 6/25 应在的行：当前 row2=6/28,3=6/27,4=6/26,5=空(应为6/25)
    const vals = DRY ? ['2026/6/25(dry)'] : rendered[p.sRow];
    if (DRY) { console.log(`  ${p.key} -> 分表 ${p.dstSheet} row5  C=${p.dd.cost} D=${p.dd.installs} F=${p.dd.rev}`); continue; }
    const textRow = [vals.map((v) => ({ value: v == null ? '' : String(v), cell_styles: { number_format: '@' } }))];
    setCells(DST_TOKEN, p.dstSheet, `A5:L5`, textRow);
    sleep(250);
    console.log(`  ${p.key.padEnd(20)} row5 <= ${vals.join(' | ')}`);
  }

  // 4) 清理 scratch
  if (!DRY) {
    console.log('[restore] 清理 scratch...');
    lark(['sheets', '+cells-clear', '--spreadsheet-token', SRC_TOKEN, '--sheet-id', SRC_SHEET, '--range', `A${SCRATCH_START}:L${SCRATCH_START + MAP.length - 1}`, '--scope', 'all', '--as', 'user', '--format', 'json']);
  }
  console.log('[restore] 完成。');
}
main();
