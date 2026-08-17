#!/usr/bin/env node
/**
 * 把各分表 row2-5（backfill/恢复时粘成文本的 6/28..6/25）C-L 数值列从文本转为数字+格式，
 * 让「苏屹恒汇总」的 SUM 公式（引用分表 C/G/H/I/J/K）能正常求和（文本会导致 #VALUE!）。
 * E/L 可能是 #DIV/0! 文本：能解析成数则转，不能则保留文本（汇总不引用 E/L）。
 */
const { execFileSync } = require('child_process');
const T='V7nysbQd3huZvStpd6Tcv7HUnJc';
const OPENCLAW_HOME=process.env.OPENCLAW_HOME||'/home/admin/.openclaw';
const DRY=process.argv.includes('--dry-run');
function sleep(ms){const s=new SharedArrayBuffer(4);Atomics.wait(new Int32Array(s),0,0,ms);}
function lark(args,input){const MAX=4;let e;for(let a=1;a<=MAX;a++){try{return execFileSync('lark-cli',args,{input:input||undefined,env:{...process.env,OPENCLAW_HOME},encoding:'utf8',maxBuffer:2e7});}catch(err){e=err;const m=(err.stdout||'')+(err.stderr||'')+err.message;if(a<MAX&&/recommited|server_error|rev is|timeout|ECONN|429|rate|lock/i.test(m)){sleep(800*a);continue;}throw err;}}throw e;}
function get(sheet,range){return JSON.parse(lark(['sheets','+cells-get','--spreadsheet-token',T,'--sheet-id',sheet,'--range',range,'--include','value','--as','user','--format','json'])).data.ranges[0];}
function setCells(sheet,range,cells){lark(['sheets','+cells-set','--spreadsheet-token',T,'--sheet-id',sheet,'--range',range,'--as','user','--format','json','--cells','-'],JSON.stringify(cells));}

const SHEETS=['f98d0f','gO3WRL','GZQTnG','JByQYJ','g1dVST','jz1aKf','E20Isf','FE8ft8','5C1jxp','yrhKwG','1Au4nJ','9ol8qU','yAukkS','hIlIGO','Rux3Fa','PrSj8j','AyPIvQ','kHPQCB','qieWLi','AjugVe'];
// 列(C..L)→ number_format
const NF={C:'$#,##0.00',D:'0',E:'$#,##0.00',F:'$#,##0.00',G:'$#,##0.00',H:'$#,##0.00',I:'$#,##0.00',J:'$#,##0.00',K:'$#,##0.00',L:'0%'};
const COLS=['C','D','E','F','G','H','I','J','K','L'];

function parseNum(s){
  if(s==null) return null;
  const t=String(s).trim();
  if(t==='') return null;
  if(/#(DIV\/0|REF|VALUE|N\/A|NAME|NULL|NUM)/i.test(t)) return 'ERR'; // 保留错误文本
  let pct=t.endsWith('%');
  let v=t.replace(/[$,%\s]/g,'');
  const neg=/^-/.test(v) || /^\(.*\)$/.test(t);
  v=v.replace(/[()-]/g,'');
  let n=Number(v);
  if(!isFinite(n)) return 'ERR';
  if(neg) n=-n;
  if(pct) n=n/100;
  return n;
}

let totalFixed=0;
for(const sid of SHEETS){
  const r=get(sid,'C2:L5'); // rows 2..5
  const out=[]; const ranges=[];
  r.cells.forEach((row,i)=>{
    const rn=r.row_indices[i];
    const rowCells=row.map((c,ci)=>{
      const col=COLS[ci];
      const v=c.value;
      const parsed=parseNum(v);
      if(parsed==='ERR'||parsed===null){
        // 保留原文本（错误/空），但确保是文本格式不影响
        return {value: v==null?'':String(v), cell_styles:{number_format:'@'}};
      }
      return {value: parsed, cell_styles:{number_format: NF[col]}};
    });
    out.push(rowCells);
  });
  if(DRY){
    console.log(`[dry] ${sid} row2 C=${JSON.stringify(out[0][0])} L=${JSON.stringify(out[0][9])}`);
    continue;
  }
  setCells(sid,'C2:L5',out);
  sleep(250);
  totalFixed++;
  console.log(`fixed ${sid} (C2:L5 → numeric)`);
}
console.log('done, sheets fixed:',totalFixed);
