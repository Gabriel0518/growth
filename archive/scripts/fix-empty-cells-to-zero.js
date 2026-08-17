#!/usr/bin/env node
/**
 * 修复：把已校准分表 G:L (6/28→6/1, 28行) 里的「文本空串/非数字」单元格改成数字 0。
 * 原因：早期粘回 null 写成 ''（文本），导致汇总公式引用时报「文本不能计算」。
 *
 * 用法: node fix-empty-cells-to-zero.js [--dry-run] [--doc <token>]
 *   不带 --doc 则修全部已处理文档。
 */
const { execFileSync } = require('child_process');
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';
process.env.PATH = '/home/admin/.npm-global/bin:' + (process.env.PATH || '');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY_DOC = (() => { const i = args.indexOf('--doc'); return i >= 0 ? args[i + 1] : null; })();

// 各文档已校准（非跳过）的分表 sheetId 列表
const DOCS = {
  // 苏屹恒
  'V7nysbQd3huZvStpd6Tcv7HUnJc': ['f98d0f','gO3WRL','GZQTnG','JByQYJ','g1dVST','jz1aKf','FE8ft8','5C1jxp','yrhKwG','1Au4nJ','9ol8qU','yAukkS','hIlIGO','Rux3Fa','PrSj8j','AyPIvQ','kHPQCB','qieWLi','AjugVe','DDYumd'],
  // 曹永麟
  'LGHJspBWEhKs38tM5iJc86bPnEe': ['39gMio','xDuXOE','lTrCEC','vaF8se','5gGUGV','U1ISiF','rVfUfI','QNjca7','SJ1ybt','Zw97Dd','vrlZ5Y'],
  // 张苗
  'YKYpsFMrQhaFAAtpw03cspgRnFc': ['AahdJS','39gMio','lTrCEC','cfmX04','5gGUGV','hgy7Sh','fNAwHg','IkbkG3','vTM9vk','3OWcMY','9M4PVs','jF2spU','1N5lhX','PEEv3a','XD2LMi','rxPjXc','RJaOJD','mNUcpI','xDuXOE'],
  // 武春香
  'FrkussvQEhZlMctf9LVck3stnge': ['QRD0ft','yrhKwG','57LuF5','5oX76d','w40wy7','OAmJSi','r7aX7M','7LxBng','5C1jxp','PAN6qu','Yh5KOz','lvkMJc','dxvpjl','gO3WRL'],
  // 张梦凡
  'GjYNsCeKch1FG0t2U2hciYp0nTf': ['5C1jxp','gO3WRL','7bfL5K','WCfq8w','yrhKwG','9j2qtX','pMRlR2','yS2Yzj','JJMPUC','1UShNQ','jRf03Q','tnjDJK','SPLDvh','EtibCA','5s7Da2','8CjiV9','SWL9cl','FWZOXL','GZQTnG','8zQ4yK','CWbcGt'],
  // 刘欢
  'AfF3s1VBOhZMXttnpi3cpSCvnxb': ['JjClhI','E9QONu','wXUP0A','2d0Mn8','qcw5nY','vNNAIm','oEFqEi','pQzuIf','zYL5rP','R52qVe','EDpaUF','QRsLsQ','0N1mRw','f3YP02','jpzGRs','IQGyd9','KcFLQv','G7PNUD'],
  // 马崇岩
  'CV5PsNbc2hSjr6teVUHcU5EpnJb': ['X9eZfh','ahIOI0','4MyiN7','QQTtq7','qwjMfb','SA4nkN','0mjIR4','GsSwjp','JedFwc','dEKgZY','hCLAQ8'],
};

function sleep(ms) { const s = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(s), 0, 0, ms); }
function lark(a, input) {
  const MAX = 4; let e;
  for (let t = 1; t <= MAX; t++) {
    try { return execFileSync('lark-cli', a, { input: input || undefined, env: { ...process.env, OPENCLAW_HOME }, encoding: 'utf8', maxBuffer: 2e7 }); }
    catch (err) { e = err; const m = (err.stdout || '') + (err.stderr || '') + err.message; if (t < MAX && /recommited|server_error|rev is|timeout|ECONN|429|rate|lock/i.test(m)) { sleep(800 * t); continue; } throw new Error(m.trim() || err.message); }
  }
  throw e;
}
function getRange(token, sheet, range, inc) {
  const out = lark(['sheets', '+cells-get', '--spreadsheet-token', token, '--sheet-id', sheet, '--range', range, '--include', inc || 'value', '--as', 'user', '--format', 'json']);
  const p = JSON.parse(out);
  if (!p.ok) throw new Error(`getRange ${sheet}!${range} failed`);
  return p.data.ranges[0].cells;
}
function setCells(token, sheet, range, cells) {
  const out = lark(['sheets', '+cells-set', '--spreadsheet-token', token, '--sheet-id', sheet, '--range', range, '--as', 'user', '--format', 'json', '--cells', '-'], JSON.stringify(cells));
  const p = JSON.parse(out);
  if (!p.ok) throw new Error(`setCells ${sheet}!${range} failed: ${out}`);
}

const isDate = (v, mm, dd) => { const s = String(v || ''); const m = s.match(/(\d+)\/(\d+)$/); return m && +m[1] === mm && +m[2] === dd; };
// 判断单元格值是否为「数字」(纯数字 / $带格式数字 / 百分比 都算数字, 不需改); 空串/null/纯文本算需修复
function isNumericLike(v) {
  if (v == null) return false;          // 空 → 需改 0
  if (typeof v === 'number') return true;
  let s = String(v).trim();
  if (s === '') return false;           // 文本空串 → 需改 0
  if (/^[-+]?\$?[\d,]+(\.\d+)?%?$/.test(s)) return true;  // 数字/货币/百分比
  return false;                          // 其他文本(含 #DIV/0! 等错误) → 视情况, 这里也改0? 不, 错误值不动
}
// 仅把「空(null/空串)」改 0; 错误值(#DIV/0!)等保留不动
function needFixToZero(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return s === '';
}

function fixSheet(doc, sheet) {
  const sub = getRange(doc, sheet, 'A2:L41', 'value');
  const dates = sub.map(r => r[0] && r[0].value);
  let start = -1;
  for (let i = 0; i < dates.length - 27; i++) {
    if (isDate(dates[i], 6, 28) && isDate(dates[i + 27], 6, 1)) { start = i; break; }
  }
  if (start < 0) { console.log(`  - ${sheet}: 跳过(无连续6/28→6/1)`); return 0; }
  const startRow = start + 2, endRow = startRow + 27;
  // 读 G:L 这 28 行
  const gl = getRange(doc, sheet, `G${startRow}:L${endRow}`, 'value');
  let fixCount = 0;
  const out = [];
  for (let r = 0; r < 28; r++) {
    const row = gl[r] || [];
    const newRow = [];
    for (let c = 0; c < 6; c++) {
      const v = row[c] && row[c].value;
      if (needFixToZero(v)) { newRow.push({ value: 0 }); fixCount++; }
      else newRow.push({ value: v });  // 原样回写(数字/货币/百分比/错误值)
    }
    out.push(newRow);
  }
  if (fixCount === 0) { console.log(`  ✓ ${sheet}: 无空单元格(r${startRow}:r${endRow})`); return 0; }
  if (DRY) { console.log(`  [dry] ${sheet}: 将修 ${fixCount} 个空→0 (r${startRow}:r${endRow})`); return fixCount; }
  setCells(doc, sheet, `G${startRow}:L${endRow}`, out); sleep(250);
  console.log(`  ✓ ${sheet}: 修了 ${fixCount} 个空→0 (G${startRow}:L${endRow})`);
  return fixCount;
}

function main() {
  const docs = ONLY_DOC ? { [ONLY_DOC]: DOCS[ONLY_DOC] } : DOCS;
  let total = 0;
  for (const [doc, sheets] of Object.entries(docs)) {
    if (!sheets) { console.log(`未知文档 ${doc}`); continue; }
    console.log(`\n=== 文档 ${doc} (${sheets.length} 个分表) ===`);
    for (const sid of sheets) {
      try { total += fixSheet(doc, sid); } catch (e) { console.log(`  ✗ ${sid}: ${e.message.slice(0,120)}`); }
    }
  }
  console.log(`\n总计修复 ${total} 个空单元格${DRY ? ' (dry-run, 未写入)' : ''}`);
}
main();
