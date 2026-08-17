#!/usr/bin/env node
/**
 * 每日同步「苏屹恒汇总」(jv5kT4) 顶部到昨天：
 *   分表 backfill 后，汇总顶部行的跨表引用仍指向旧 row 号（飞书 insert 不平移跨表引用），
 *   需要在汇总顶部 insert N 行(side:before) 并重写新行公式，使 汇总 row R ↔ 分表 row R。
 *
 * 逻辑（幂等）：
 *   1) 读汇总 row2 日期 d0、分表(AjugVe)权威日期序列
 *   2) 若 d0 == 昨天 → 跳过（已最新）
 *   3) 否则 在汇总 row2 前 insert n 行(=昨天距 d0 的天数, ≤4)，重写 row2..row(1+n) 为新日期
 *      （汇总 row R → 分表 row R，复用 row2 模板公式 retarget 行号，mask W2A）
 *   4) 重写紧随的旧首行(现 row 2+n)？——不需要：旧行下移后跨表引用未平移，仍指原 row，
 *      但因分表也插了等量行、日期对齐关系保持，旧行日期仍 MATCH（已验证）。
 *      仅需确保新写的 row2..1+n 指向 分表 r2..r(1+n)。
 *
 * 依赖：/tmp/sum_tmpl.json（汇总 row2 模板公式快照）。若不存在则自动从当前 row 重新生成模板？
 *   —— 为稳妥，本脚本启动时实时读取“某个结构完好的汇总行”的公式做模板，避免依赖 /tmp。
 */
const { execFileSync } = require('child_process');
const T = 'V7nysbQd3huZvStpd6Tcv7HUnJc';
const SUM_SHEET = 'jv5kT4';
const REF_SUB = 'AjugVe'; // 权威日期序列(Romi And GG)
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';
const DRY = process.argv.includes('--dry-run');

function sleep(ms){const s=new SharedArrayBuffer(4);Atomics.wait(new Int32Array(s),0,0,ms);}
function lark(args,input){const MAX=4;let e;for(let a=1;a<=MAX;a++){try{return execFileSync('lark-cli',args,{input:input||undefined,env:{...process.env,OPENCLAW_HOME},encoding:'utf8',maxBuffer:2e7});}catch(err){e=err;const m=(err.stdout||'')+(err.stderr||'')+err.message;if(a<MAX&&/recommited|server_error|rev is|timeout|ECONN|429|rate|lock/i.test(m)){sleep(800*a);continue;}throw err;}}throw e;}
function getRange(sheet,range,inc){return JSON.parse(lark(['sheets','+cells-get','--spreadsheet-token',T,'--sheet-id',sheet,'--range',range,'--include',inc||'value','--as','user','--format','json'])).data.ranges[0];}
function setCells(sheet,range,cells){lark(['sheets','+cells-set','--spreadsheet-token',T,'--sheet-id',sheet,'--range',range,'--as','user','--format','json','--cells','-'],JSON.stringify(cells));}
function dimInsertBefore(sheet,pos,count){lark(['sheets','+dim-insert','--spreadsheet-token',T,'--sheet-id',sheet,'--position',String(pos),'--count',String(count),'--inherit-style','before','--as','user','--format','json']);}

function parseSlash(s){const m=String(s||'').match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);return m?new Date(Date.UTC(+m[1],+m[2]-1,+m[3])):null;}
function fmtSlash(dt){return `${dt.getUTCFullYear()}/${dt.getUTCMonth()+1}/${dt.getUTCDate()}`;}
function beijingTodayUTC(){const n=new Date(Date.now()+8*3600*1000);return new Date(Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate()));}
function daysBetween(a,b){return Math.round((a-b)/86400000);}

// retarget：mask W2A → 把所有跨表引用的行号(字母后的数字)统一替换为 R → unmask
// 注意：不假设模板基准行号为 2（昨天的 bug 曾让模板 row2 引用 !3，导致旧版只替换"字母后的2"时漏改）。
// 现在替换"字母后的 1~3 位数字"，对求和型纯跨表引用公式安全（公式内除行引用外无其他"字母+数字"模式）。
function retarget(f,R){
  if(typeof f!=='string'||!f.startsWith('='))return null;
  const MASK='\u0001WXA\u0001';
  let s=f.split('W2A').join(MASK);
  s=s.replace(/(?<=[A-Z])\d{1,3}(?![0-9])/g,String(R));
  return s.split(MASK).join('W2A');
}

function main(){
  const today=beijingTodayUTC();
  const yesterday=new Date(today.getTime()-86400000);
  console.log(`[sync-sum] 北京今天=${fmtSlash(today)} 昨天=${fmtSlash(yesterday)} dryRun=${DRY}`);

  // 模板：从汇总 row2 取公式（结构完好）。先确认 row2 无 #REF。
  const r2=getRange(SUM_SHEET,'A2:L2','value,formula');
  const tmpl={};const cols=['A','B','C','D','E','F','G','H','I','J','K','L'];
  let r2broken=false;
  r2.cells[0].forEach((c,i)=>{tmpl[cols[i]]=c.formula||c.value; if(String(c.value||'').includes('#REF'))r2broken=true;});
  if(r2broken){console.error('[sync-sum] 警告：汇总 row2 含 #REF，模板不可靠，中止。请先人工修复。');process.exit(2);}

  const d0=parseSlash(r2.cells[0][0].value);
  if(!d0){console.error('[sync-sum] 无法解析汇总 row2 日期，中止。');process.exit(2);}
  const gap=daysBetween(yesterday,d0); // 需要新增的天数
  if(gap<=0){console.log(`[sync-sum] 汇总 row2=${fmtSlash(d0)} 已是昨天/更新，跳过。`);return;}
  if(gap>4){console.error(`[sync-sum] 汇总 row2=${fmtSlash(d0)} 距昨天 ${gap} 天 >4，超出安全范围，中止并需人工介入。`);process.exit(2);}

  // 分表权威日期：确认 分表 row2..row(1+gap) 即为 昨天..(d0+1)
  const sub=getRange(REF_SUB,'A2:A8','value');
  const subDate={};sub.cells.forEach((row,i)=>{subDate[sub.row_indices[i]]=row[0].value;});
  // 期望 分表 row2=昨天
  if(parseSlash(subDate[2])&&fmtSlash(parseSlash(subDate[2]))!==fmtSlash(yesterday)){
    console.error(`[sync-sum] 分表 ${REF_SUB} row2=${subDate[2]} ≠ 昨天 ${fmtSlash(yesterday)}，分表可能未先 backfill，中止。`);
    process.exit(2);
  }

  console.log(`[sync-sum] 汇总 row2=${fmtSlash(d0)} → 顶部补 ${gap} 行(昨天..)`);
  if(DRY){
    for(let i=0;i<gap;i++){const d=new Date(yesterday.getTime()-i*86400000);console.log(`   将写 汇总 row${2+i}=${fmtSlash(d)} -> 分表 r${2+i}`);}
    return;
  }

  // insert gap 行(before row2)；老 row2(d0)→ row(2+gap)，跨表引用不平移仍指原行，日期保持 MATCH
  dimInsertBefore(SUM_SHEET,2,gap);
  sleep(500);
  // 写 row2..row(1+gap)：汇总 row R → 分表 r R
  for(let R=2;R<=1+gap;R++){
    const dlabel=subDate[R];
    const rowCells=cols.map((col)=>{
      if(col==='A')return {value:dlabel};
      if(col==='B')return {value:tmpl.B||'TT/FB/GG'};
      return {formula:retarget(tmpl[col],R)};
    });
    setCells(SUM_SHEET,`A${R}:L${R}`,[rowCells]);
    sleep(220);
    console.log(`   wrote 汇总 row${R}=${dlabel} -> 分表 r${R}`);
  }
  console.log('[sync-sum] 完成。');
}
main();
