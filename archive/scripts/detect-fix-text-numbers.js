#!/usr/bin/env node
/**
 * 用「乘1」公式批量检测已校准分表 G:L (6/28→6/1) 里的文本型单元格。
 * 文本型数字（如手输 -$34.1）乘1会得 #VALUE!，数字则得原值。
 * 检测到的文本单元格 → 用 parseNum 转成纯数字写回修复。
 *
 * 在分表远处空列区 N:S（对应G:L 6列）写 =G{r}*1 公式，读回，定位 #VALUE!，
 * 然后对原 G:L 对应单元格写纯数字，最后清除 N:S。
 *
 * 用法: node detect-fix-text-numbers.js [--doc <token>] [--dry-run]
 */
const { execFileSync } = require('child_process');
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';
process.env.PATH = '/home/admin/.npm-global/bin:' + (process.env.PATH || '');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY_DOC = (() => { const i = args.indexOf('--doc'); return i >= 0 ? args[i + 1] : null; })();

const DOCS = {
  'V7nysbQd3huZvStpd6Tcv7HUnJc': ['f98d0f','gO3WRL','GZQTnG','JByQYJ','g1dVST','jz1aKf','FE8ft8','5C1jxp','yrhKwG','1Au4nJ','9ol8qU','yAukkS','hIlIGO','Rux3Fa','PrSj8j','AyPIvQ','kHPQCB','qieWLi','AjugVe'],
  'LGHJspBWEhKs38tM5iJc86bPnEe': ['5gGUGV','U1ISiF','rVfUfI','QNjca7','SJ1ybt','Zw97Dd','vrlZ5Y'],
  'YKYpsFMrQhaFAAtpw03cspgRnFc': ['AahdJS','lTrCEC','cfmX04','5gGUGV','hgy7Sh','fNAwHg','IkbkG3','vTM9vk','9M4PVs','1N5lhX','PEEv3a'],
  'FrkussvQEhZlMctf9LVck3stnge': ['QRD0ft','yrhKwG','57LuF5','5oX76d','w40wy7','OAmJSi','r7aX7M','7LxBng','5C1jxp'],
  'GjYNsCeKch1FG0t2U2hciYp0nTf': ['5C1jxp','gO3WRL','7bfL5K','WCfq8w','yrhKwG','9j2qtX','pMRlR2','yS2Yzj','JJMPUC','1UShNQ','jRf03Q','tnjDJK','SPLDvh','5s7Da2'],
  'AfF3s1VBOhZMXttnpi3cpSCvnxb': ['JjClhI','E9QONu','wXUP0A','2d0Mn8','qcw5nY','vNNAIm','oEFqEi','pQzuIf','zYL5rP','EDpaUF','QRsLsQ','0N1mRw','f3YP02','IQGyd9','KcFLQv','G7PNUD'],
  // 马崇岩
  'CV5PsNbc2hSjr6teVUHcU5EpnJb': ['X9eZfh','ahIOI0','4MyiN7','QQTtq7','qwjMfb','SA4nkN','0mjIR4','GsSwjp','JedFwc','dEKgZY','hCLAQ8'],
};

function sleep(ms) { const s = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(s), 0, 0, ms); }
function lark(a, input) {
  const MAX = 4; let e;
  for (let t = 1; t <= MAX; t++) {
    try { return execFileSync('lark-cli', a, { input: input || undefined, env: { ...process.env, OPENCLAW_HOME }, encoding: 'utf8', maxBuffer: 2e7 }); }
    catch (err) { e = err; const m = (err.stdout||'')+(err.stderr||'')+err.message; if (t<MAX && /recommited|server_error|rev is|timeout|ECONN|429|rate|lock/i.test(m)) { sleep(800*t); continue; } throw new Error(m.trim()||err.message); }
  }
  throw e;
}
function getRange(token, sheet, range, inc) {
  const out = lark(['sheets','+cells-get','--spreadsheet-token',token,'--sheet-id',sheet,'--range',range,'--include',inc||'value','--as','user','--format','json']);
  const p = JSON.parse(out); if (!p.ok) throw new Error(`getRange ${sheet}!${range}`); return p.data.ranges[0].cells;
}
function setCells(token, sheet, range, cells) {
  const out = lark(['sheets','+cells-set','--spreadsheet-token',token,'--sheet-id',sheet,'--range',range,'--as','user','--format','json','--cells','-'], JSON.stringify(cells));
  const p = JSON.parse(out); if (!p.ok) throw new Error(`setCells ${sheet}!${range}: ${out}`);
}
const isDate = (v, mm, dd) => { const s = String(v||''); const m = s.match(/(\d+)\/(\d+)$/); return m && +m[1]===mm && +m[2]===dd; };
function parseNum(v) {
  if (v == null) return null; let s = String(v).trim();
  if (/DIV|REF|VALUE|N\/A|#/.test(s)) return null;
  const pct = /%\s*$/.test(s); s = s.replace(/[$,\s%¥￥]/g,''); if (s==='') return null;
  let n = parseFloat(s); if (isNaN(n)) return null; if (pct) n/=100; return n;
}

const GLCOLS = ['G','H','I','J','K','L'];
const TESTCOLS = ['N','O','P','Q','R','S'];  // 对应 G:L 的测试列

function detectFix(doc, sheet) {
  const sub = getRange(doc, sheet, 'A2:L41', 'value');
  const dates = sub.map(r => r[0] && r[0].value);
  let start = -1;
  for (let i=0;i<dates.length-27;i++){ if (isDate(dates[i],6,28)&&isDate(dates[i+27],6,1)){start=i;break;} }
  if (start<0){ console.log(`  - ${sheet}: 跳过(无6/28→6/1)`); return 0; }
  const sr = start+2, er = sr+27;
  // 写测试公式 N{r}:S{r} = G{r}*1 ... L{r}*1
  const testRows = [];
  for (let r=sr;r<=er;r++){
    testRows.push(GLCOLS.map(col => ({ formula: `=${col}${r}*1` })));
  }
  setCells(doc, sheet, `N${sr}:S${er}`, testRows); sleep(400);
  const res = getRange(doc, sheet, `N${sr}:S${er}`, 'value'); sleep(100);
  // 找 #VALUE! 的位置
  const fixes = []; // {col,row}
  for (let r=0;r<28;r++){
    for (let c=0;c<6;c++){
      const v = res[r] && res[r][c] && res[r][c].value;
      if (typeof v==='string' && /#VALUE|#REF|#NAME/.test(v)) {
        fixes.push({ col: GLCOLS[c], row: sr+r, rowIdx: start+r, colIdx: 6+c });
      }
    }
  }
  // 清除测试列
  const blank = []; for(let r=sr;r<=er;r++) blank.push(TESTCOLS.map(()=>({value:''})));
  setCells(doc, sheet, `N${sr}:S${er}`, blank); sleep(200);

  if (fixes.length===0){ console.log(`  ✓ ${sheet}: 无文本型数字 (r${sr}:r${er})`); return 0; }
  // 报告 + 修复
  for (const f of fixes){
    const orig = sub[f.rowIdx] && sub[f.rowIdx][f.colIdx] && sub[f.rowIdx][f.colIdx].value;
    const num = parseNum(orig);
    console.log(`  ⚠ ${sheet} ${f.col}${f.row}: 文本 ${JSON.stringify(orig)} → 数字 ${num}`);
    if (!DRY && num!=null){ setCells(doc, sheet, `${f.col}${f.row}:${f.col}${f.row}`, [[{value:num}]]); sleep(200); }
    else if (!DRY && num==null){ console.log(`     (无法解析成数字，跳过不动)`); }
  }
  return fixes.length;
}

function main(){
  const docs = ONLY_DOC ? { [ONLY_DOC]: DOCS[ONLY_DOC] } : DOCS;
  let total=0;
  for (const [doc,sheets] of Object.entries(docs)){
    if(!sheets){console.log(`未知文档 ${doc}`);continue;}
    console.log(`\n=== ${doc} (${sheets.length}) ===`);
    for (const s of sheets){ try{ total+=detectFix(doc,s); }catch(e){ console.log(`  ✗ ${s}: ${e.message.slice(0,120)}`);} }
  }
  console.log(`\n总计检测出并修复 ${total} 个文本型数字${DRY?' (dry-run)':''}`);
}
main();
