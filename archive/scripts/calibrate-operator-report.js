#!/usr/bin/env node
/**
 * 投手日报修正收入校准
 *
 * 对投手文档的每个产品分表：
 *   1) 读分表 6/1-6/28 的 C(消耗)/D(男生人数)/F(原始收入)  —— 分表 r3:r30
 *   2) 写入主表「日报核查」(U7xN0P) 的 C/D/F  —— A2:A29 = 6/28→6/1
 *   3) 把该产品在「新版汇总」(bqKVkz) 的 G:L 公式（retarget 行号）填满日报核查 28 行
 *   4) 读回日报核查算出的 G:L 值（toString 渲染）
 *   5) 把 G:L 值（纯数字）粘回分表 r3:r30
 *
 * 用法:
 *   node calibrate-operator-report.js --doc <投手spreadsheet_token> --sheet <分表sheetId> --product "<新版汇总产品块名>" [--dry-run]
 *   node calibrate-operator-report.js --doc <token> --map  # 打印该文档分表→产品映射(不执行)
 */
const { execFileSync } = require('child_process');

const MAIN = 'N1FcsGvXThXu97t7ZYyccCHDnIg';   // 主表（含日报核查/新版汇总/新版手动输入数据/自动更新数据）
const CHECK_SHEET = 'U7xN0P';                  // 日报核查
const SUMMARY_SHEET = 'bqKVkz';                // 新版汇总
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';
process.env.PATH = '/home/admin/.npm-global/bin:' + (process.env.PATH || '');

const args = process.argv.slice(2);
const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const DOC = getArg('--doc');
const SHEET = getArg('--sheet');
const PRODUCT = getArg('--product');
const DRY = args.includes('--dry-run');
const ALL = args.includes('--all');

// 苏屹恒文档：分表 sheetId → [分表显示名, 新版汇总产品块名]；null=跳过
const SUYIHENG_MAP = [
  ['f98d0f', 'GC iOS TT', 'GraceChat TT'],
  ['gO3WRL', 'Dora And TT', 'Dora And TT'],
  ['GZQTnG', 'Dora iOS TT', 'Dora iOS TT'],
  ['JByQYJ', 'Doni And TT', 'Doni TT'],
  ['g1dVST', 'Romi iOS TT', 'Romi iOS TT'],
  ['jz1aKf', 'Jovia And TT', 'Jovia And TT'],
  ['E20Isf', 'Kira iOS TT', null],          // Kira 只有安卓，跳过
  ['FE8ft8', 'Kira And TT', 'Kira And TT'],
  ['5C1jxp', 'Dora And FB', 'Dora And FB'],
  ['yrhKwG', 'Dora iOS FB', 'Dora iOS FB'],
  ['1Au4nJ', 'Doni And FB', 'Doni FB'],
  ['9ol8qU', 'Jovia And FB', 'Jovia And FB'],
  ['yAukkS', 'Romi And FB', 'Romi And FB'],
  ['hIlIGO', 'Romi iOS FB', 'Romi iOS FB'],
  ['Rux3Fa', 'Romi iOS FB（W2A）', 'Romi iOS FB(W2A)'],
  ['PrSj8j', 'Luma iOS FB', 'Luma iOS FB'],
  ['AyPIvQ', 'Dora And GG', 'Dora And GG'],
  ['kHPQCB', 'Doni And GG', 'Doni GG'],
  ['qieWLi', 'Jovia And GG', 'Jovia And GG'],
  ['AjugVe', 'Romi And GG', 'Romi And GG'],
  ['DDYumd', 'Luma iOS TT', 'Luma iOS TT'],
];

// 曹永麟文档：sheetId → [分表显示名, 新版汇总产品块名]；null=跳过
const CAOYONGLIN_MAP = [
  ['39gMio', '曹永麟GC TT', 'GraceChat TT'],
  ['xDuXOE', '曹永麟Dora And TT', 'Dora And TT'],
  ['lTrCEC', '曹永麟Dora iOS TT', 'Dora iOS TT'],
  ['vaF8se', '曹永麟Doni And TT', 'Doni TT'],
  ['5gGUGV', '曹永麟Dora And FB', 'Dora And FB'],
  ['U1ISiF', '曹永麟Dora iOS FB', 'Dora iOS FB'],
  ['rVfUfI', '曹永麟Doni And FB', 'Doni FB'],
  ['JenUEP', 'YSN Dora iOS TT', null],   // YSN 忽略
  ['lNSZNW', 'YSN Dora And TT', null],   // YSN 忽略
  ['QNjca7', '曹永麟Kira And FB', 'Kira And FB'],
  ['SJ1ybt', '曹永麟Romi iOS FB', 'Romi iOS FB'],
  ['Zw97Dd', '曹永麟Romi And FB', 'Romi And FB'],
  ['vrlZ5Y', '曹永麟Jovia And FB', 'Jovia And FB'],
];

// 张苗文档：sheetId → [分表显示名, 新版汇总产品块名]；null=跳过
const ZHANGMIAO_MAP = [
  ['AahdJS', 'GC iOS FB', 'GraceChat FB'],
  ['39gMio', 'GC iOS TT', 'GraceChat TT'],
  ['lTrCEC', 'Dora And FB', 'Dora And FB'],
  ['cfmX04', 'Dora iOS FB', 'Dora iOS FB'],
  ['5gGUGV', 'Doni And FB', 'Doni FB'],
  ['hgy7Sh', 'Doni And TT', 'Doni TT'],
  ['fNAwHg', 'Doni And GG', 'Doni GG'],
  ['IkbkG3', 'Romi iOS FB', 'Romi iOS FB'],
  ['vTM9vk', 'Luma iOS FB', 'Luma iOS FB'],
  ['3OWcMY', 'Luma iOS TT', 'Luma iOS TT'],
  ['9M4PVs', 'Jovia And FB', 'Jovia And FB'],
  ['jF2spU', 'Jovia And TT', 'Jovia And TT'],
  ['1N5lhX', 'Romi And FB', 'Romi And FB'],
  ['PEEv3a', 'Kira And FB', 'Kira And FB'],
  ['XD2LMi', 'Kira And TT', 'Kira And TT'],
  ['rxPjXc', 'Nalo And FB', 'Nalo And FB'],
  ['RJaOJD', '张苗Dora And GG', 'Dora And GG'],
  ['mNUcpI', '张苗Romi iOS FB W2A', 'Romi iOS FB(W2A)'],
  ['mE98Y3', '张苗Elara iOS TT', null],   // Elara 新版汇总无对应，跳过
  ['xDuXOE', '张苗Dora And TT', 'Dora And TT'],
];

// 武春香文档：sheetId → [分表显示名, 新版汇总产品块名]；null=跳过
const WUCHUNXIANG_MAP = [
  ['QRD0ft', 'Dora And GG', 'Dora And GG'],
  ['o76Ynz', 'Dora iOS FB（廖）', null],   // 去年12月数据+结构异常，跳过
  ['yrhKwG', 'Dora iOS FB', 'Dora iOS FB'],
  ['57LuF5', 'Doni And GG', 'Doni GG'],
  ['5oX76d', 'Romi iOS FB', 'Romi iOS FB'],
  ['w40wy7', 'Romi iOS TT', 'Romi iOS TT'],
  ['OAmJSi', 'Luma IOS TT', 'Luma iOS TT'],
  ['r7aX7M', 'Luma iOS FB', 'Luma iOS FB'],
  ['rZOLLJ', 'PWA', null],                  // 非标准多产品堆叠，跳过
  ['7LxBng', 'Doni And FB', 'Doni FB'],
  ['5C1jxp', 'Dora And FB', 'Dora And FB'],
  ['PAN6qu', 'Doni And TT', 'Doni TT'],
  ['Yh5KOz', 'Kira  Ios FB', 'Kira And FB'],
  ['lvkMJc', 'Romi And FB', 'Romi And FB'],
  ['dxvpjl', 'Jovia And TT', 'Jovia And TT'],
  ['gO3WRL', 'Dora And TT', 'Dora And TT'],
];

// 张梦凡文档：sheetId → [分表显示名, 新版汇总产品块名]；null=跳过
const ZHANGMENGFAN_MAP = [
  ['5C1jxp', 'Dora And FB', 'Dora And FB'],
  ['gO3WRL', 'Dora And TT', 'Dora And TT'],
  ['7bfL5K', 'Dora And GG', 'Dora And GG'],
  ['WCfq8w', 'Romi And GG', 'Romi And GG'],
  ['yrhKwG', 'Dora iOS FB', 'Dora iOS FB'],
  ['9j2qtX', 'Doni And TT', 'Doni TT'],
  ['pMRlR2', 'Doni And FB', 'Doni FB'],
  ['yS2Yzj', 'Doni And GG', 'Doni GG'],
  ['JJMPUC', 'Romi iOS FB', 'Romi iOS FB'],
  ['1UShNQ', 'Romi iOS TT', 'Romi iOS TT'],
  ['jRf03Q', 'Luma iOS FB', 'Luma iOS FB'],
  ['tnjDJK', 'Luma iOS TT', 'Luma iOS TT'],
  ['SPLDvh', 'Kira And FB', 'Kira And FB'],
  ['EtibCA', 'Kira And TT', 'Kira And TT'],
  ['5s7Da2', 'Luma iOS FB（W2A）', 'Luma iOS FB(W2A)'],
  ['8CjiV9', 'Romi iOS FB（W2A）', 'Romi iOS FB(W2A)'],
  ['SWL9cl', 'Romi And FB', 'Romi And FB'],
  ['FWZOXL', 'Jovia And FB', 'Jovia And FB'],
  ['GZQTnG', 'Dora iOS TT', 'Dora iOS TT'],
  ['8zQ4yK', 'Jovia And TT', 'Jovia And TT'],
  ['CWbcGt', 'Romi and TT', 'Romi And TT'],
  ['T314P0', 'PWA TT', null],              // PWA指标表，非标准，跳过
  ['Lw4r6B', 'PWA主播成本', null],         // 多产品堆叠+PWA专用列，跳过
  ['I0xivu', 'Dora and Unity', null],      // Unity渠道1月数据+汇总无Unity，跳过
  ['h4WU2l', 'Kira iOS FB（下架）', null],  // 已下架4月数据，跳过
];

// 刘欢文档：sheetId → [分表显示名, 新版汇总产品块名]；null=跳过
const LIUHUAN_MAP = [
  ['JjClhI', 'Doni And FB', 'Doni FB'],
  ['E9QONu', 'GC ios-FB', 'GraceChat  FB'],
  ['wXUP0A', 'Romi ios-w2a', 'Romi iOS FB(W2A)'],
  ['2d0Mn8', 'Luma ios-w2a', 'Luma iOS FB(W2A)'],
  ['qcw5nY', 'Kira and FB', 'Kira And FB'],
  ['vNNAIm', 'Nalo and FB', 'Nalo And FB'],
  ['oEFqEi', 'Jovia and FB', 'Jovia And FB'],
  ['pQzuIf', 'Dora And FB', 'Dora And FB'],
  ['zYL5rP', 'Dora ios FB', 'Dora iOS FB'],
  ['R52qVe', 'Romi and-FB', 'Romi And FB'],
  ['b1zC47', 'Kira ios FB', null],          // 汇总无 Kira iOS 块（只有 Kira And），跳过
  ['EDpaUF', 'Doni And TT', 'Doni TT'],
  ['QRsLsQ', 'Romi ios TT', 'Romi iOS TT'],
  ['0N1mRw', 'Luma ios TT', 'Luma iOS TT'],
  ['f3YP02', 'Jovia And TT', 'Jovia And TT'],
  ['jpzGRs', 'Nalo and TT', 'Nalo And TT'],
  ['IQGyd9', 'Dora  IOS TT', 'Dora iOS TT'],
  ['KcFLQv', 'GG-Doni And', 'Doni GG'],
  ['G7PNUD', 'GG-Dora And', 'Dora And GG'],
];

// 马崇岩文档：sheetId → [分表显示名, 新版汇总产品块名]；null=跳过
const MACHONGYAN_MAP = [
  ['X9eZfh', 'Dora and GG', 'Dora And GG'],
  ['ahIOI0', 'Dora And FB', 'Dora And FB'],
  ['4MyiN7', 'Dora iOS FB', 'Dora iOS FB'],
  ['QQTtq7', 'Doni And TT', 'Doni TT'],
  ['qwjMfb', 'Doni And FB', 'Doni FB'],
  ['SA4nkN', 'Luma IOS TT', 'Luma iOS TT'],
  ['0mjIR4', 'Luma IOS FB', 'Luma iOS FB'],
  ['GsSwjp', 'Romi IOS FB', 'Romi iOS FB'],
  ['JedFwc', 'Romi IOS TT', 'Romi iOS TT'],
  ['dEKgZY', 'Kira and FB', 'Kira And FB'],
  ['hCLAQ8', 'Dora iOS TT', 'Dora iOS TT'],
];

// 王维维文档：sheetId → [分表显示名, 新版汇总产品块名]；null=跳过
const WANGWEIWEI_MAP = [
  ['qwjMfb', 'Doni And FB', 'Doni FB'],
  ['7wgtVr', 'Kira And FB', 'Kira And FB'],
  ['d4qKV6', 'Kira And TT', 'Kira And TT'],
  ['hCLAQ8', 'Romi iOS TT', 'Romi iOS TT'],
  ['2xNPo3', 'Romi iOS FB', 'Romi iOS FB'],
  ['8YGTso', 'Luma iOS FB', 'Luma iOS FB'],
  ['jqlp7f', 'GraceChat  FB', 'GraceChat  FB'],
  ['39sT8Q', 'Kira And GG', null],          // 汇总无 Kira And GG 块，跳过
  ['9Km97Q', 'Jovia And GG', 'Jovia And GG'],
  ['6eJgnC', 'Dora And GG', 'Dora And GG'],
  ['P6KSJ1', 'Luma iOS TT', 'Luma iOS TT'],
  ['ahIOI0', 'Dora And FB', 'Dora And FB'],
  ['haYopC', 'Nalo And FB', 'Nalo And FB'],
  ['qakAFv', 'Dora iOS FB', 'Dora iOS FB'],
  ['ok43B4', 'Kira iOS FB', null],          // 汇总无 Kira iOS 块，跳过
  ['msvghU', 'Luma iOS FB(W2A)', 'Luma iOS FB(W2A)'],
  ['8rZ9qy', 'Romi iOS FB(W2A)', 'Romi iOS FB(W2A)'],  // 6月无数据，会自动跳过
  ['SZNznQ', 'Romi W2A FB', null],          // 4月老数据无月数据，跳过
  ['HL8Us2', 'Jovia And FB', 'Jovia And FB'],
  ['QQTtq7', 'Doni And TT', 'Doni TT'],
];

// 杨梅亭文档：sheetId → [分表显示名, 新版汇总产品块名]；null=跳过
const YANGMEITING_MAP = [
  ['a07be7', 'Dora And FB', 'Dora And FB'],
  ['d6QGlR', 'Kira And FB', 'Kira And FB'],
  ['xoNT1K', 'Kira And GG', null],          // 汇总无 Kira And GG 块
  ['hEaszE', 'Nalo And FB', 'Nalo And FB'],
  ['gh0TrD', 'Romi And FB', 'Romi And FB'],
  ['97e8nO', 'Doni And FB', 'Doni FB'],
  ['Uh22PF', 'Romi ios FB', 'Romi iOS FB'],
  ['jTzYrk', 'Dora And GG', 'Dora And GG'],
  ['Ex6WV8', 'Romi ios TT', 'Romi iOS TT'],
  ['kcplHq', 'GC ios FB', 'GraceChat  FB'],
  ['Dh8BP1', 'Luma ios FB', 'Luma iOS FB'],
  ['R4bUvi', 'Jovia And GG', 'Jovia And GG'],
  ['9FNDh5', 'Doni And GG', 'Doni GG'],
];

// 张嘉铖文档：sheetId → [分表显示名, 新版汇总产品块名]；null=跳过
const ZHANGJIACHENG_MAP = [
  ['xyFlAV', 'Luma IOS FB', 'Luma iOS FB'],
  ['M602is', 'Kira And FB', 'Kira And FB'],
  ['Ob7o2f', 'Doni And FB', 'Doni FB'],
  ['Abvwd2', 'Doni And GG', 'Doni GG'],
  ['2bK6mk', 'Jovia And FB', 'Jovia And FB'],
  ['J8Gse6', 'GraceChat IOS FB', 'GraceChat  FB'],
  ['K5Z7Fg', 'Romi IOS FB', 'Romi iOS FB'],
  ['DoLJGV', 'Romi IOS TT', 'Romi iOS TT'],
  ['NNeOhI', 'Luma IOS TT', 'Luma iOS TT'],
  ['6AfYGz', 'Kira And TT', 'Kira And TT'],
  ['5C1jxp', 'Dora And FB', 'Dora And FB'],
  ['N8LRu8', 'Kira IOS FB', null],          // 汇总无 Kira iOS 块
];

// 文档 token → 映射表
const DOC_MAPS = {
  'V7nysbQd3huZvStpd6Tcv7HUnJc': SUYIHENG_MAP,
  'LGHJspBWEhKs38tM5iJc86bPnEe': CAOYONGLIN_MAP,
  'YKYpsFMrQhaFAAtpw03cspgRnFc': ZHANGMIAO_MAP,
  'FrkussvQEhZlMctf9LVck3stnge': WUCHUNXIANG_MAP,
  'GjYNsCeKch1FG0t2U2hciYp0nTf': ZHANGMENGFAN_MAP,
  'AfF3s1VBOhZMXttnpi3cpSCvnxb': LIUHUAN_MAP,
  'CV5PsNbc2hSjr6teVUHcU5EpnJb': MACHONGYAN_MAP,
  'CLEzsnKnkhU3JlthFSqctRa9n1b': WANGWEIWEI_MAP,
  'PBoxsyZJ5hdBjNtRp7bcN9cfnsh': YANGMEITING_MAP,
  'RJ1ys66ZbhG3dLtAgd4cZTnWnee': ZHANGJIACHENG_MAP,
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
  if (!p.ok) throw new Error(`getRange ${sheet}!${range} failed: ${out}`);
  return p.data.ranges[0].cells;
}
function setCells(token, sheet, range, cells) {
  const out = lark(['sheets', '+cells-set', '--spreadsheet-token', token, '--sheet-id', sheet, '--range', range, '--as', 'user', '--format', 'json', '--cells', '-'], JSON.stringify(cells));
  const p = JSON.parse(out);
  if (!p.ok) throw new Error(`setCells ${sheet}!${range} failed: ${out}`);
}

// "$1,144.83" / "234" / "100%" / "#DIV/0!" / "" → number | null
function parseNum(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (/DIV|REF|VALUE|N\/A|#/.test(s)) return null;
  const isPct = /%\s*$/.test(s);
  s = s.replace(/[$,\s%]/g, '');
  if (s === '') return null;
  let n = parseFloat(s);
  if (isNaN(n)) return null;
  if (isPct) n = n / 100; // 百分比 → 小数底值（粘回分表同为百分比格式会正确渲染）
  return n;
}

// retarget：只替换「相对引用」的行号（字母直接跟数字，不带 $）→ R
// 保留绝对引用 $213(自动更新数据产品区间、固定不动)；mask W2A 防误伤
function retarget(f, R) {
  if (typeof f !== 'string' || !f.startsWith('=')) return f;
  const MASK = '\u0001WXA\u0001';
  let s = f.split('W2A').join(MASK).split('w2a').join(MASK);
  // (?<![\$\d]) 前面不是 $ 或数字；(?<=[A-Z]) 紧跟在字母后；(?![0-9]) 后面不是数字
  s = s.replace(/(?<![\$\d])(?<=[A-Z])\d{1,3}(?![0-9])/g, String(R));
  return s.split(MASK).join('W2A');
}

// 取新版汇总某产品块首数据行的 G:L 公式模板
function getProductFormulas(product) {
  const cells = getRange(MAIN, SUMMARY_SHEET, 'A4:L145', 'value,formula');
  const reDate = /^\d{4}\//;
  for (let i = 0; i < cells.length; i++) {
    const row = cells[i];
    const a = row[0] && (row[0].value);
    const b = row[1] && (row[1].value);
    if (a && !String(a).startsWith('=') && !reDate.test(String(a)) && a !== '日期' && (b == null || b === '')) {
      if (normTitle(a) === normTitle(product)) {
        const data = cells[i + 1]; // 首数据行
        const cols = ['G', 'H', 'I', 'J', 'K', 'L'];
        const out = {};
        cols.forEach((c, ci) => { const cell = data[6 + ci]; out[c] = cell.formula || cell.value; });
        return out;
      }
    }
  }
  return null;
}
function normTitle(s) {
  return String(s).toLowerCase().replace(/[（）()【】\[\]]/g, '').replace(/\s+/g, '').replace('gracechat', 'gc').replace('w2a', 'w2a');
}

// 返回：{ product, sheet, rows: [{date,K_old,K_new,diff}], sumKold, sumKnew, sumDiff } | {skipped}
function calibrateOne(doc, sheet, subName, product) {
  console.log(`\n=== 校准 [${subName}] sheet=${sheet} → 公式"${product}" dry=${DRY} ===`);

  // 1) 读分表 r2:r31（含 A=日期, C/D/F, K=原运营净利润）
  const sub = getRange(doc, sheet, 'A2:L41', 'value');  // 读更大范围以动态定位
  const subDates = sub.map(r => r[0] && r[0].value);
  const isDate = (v, mm, dd) => { const s = String(v || ''); const m = s.match(/(\d+)\/(\d+)$/); return m && +m[1] === mm && +m[2] === dd; };
  // 定位 6月数据段：找第一个 6月日期作为起点（可能是 6/28，也可能 6/7 等月初），
  // 从该起点严格连续递减往下走到 6/1（或更早停）。支持「起步晚」「月末未投只有月初」两种情况。
  const parseMD = (v) => { const m = String(v || '').match(/(\d+)\/(\d+)$/); return m ? { mm: +m[1], dd: +m[2] } : null; };
  let startIdx = -1, startDD = -1;
  for (let i = 0; i < subDates.length; i++) {
    const p = parseMD(subDates[i]);
    if (p && p.mm === 6 && p.dd <= 28) { startIdx = i; startDD = p.dd; break; }   // 第一个 6/28 及之前的日期（跳过 6/29、6/30 占位行）
  }
  if (startIdx < 0) {
    console.log(`  ⚠ 跳过：无任何 6月数据（r2=${subDates[0]} r3=${subDates[1]}）`);
    return { product, subName, sheet, skippedNoDate: true };
  }
  // 从起点 6/startDD 起严格连续递减：遇空/非日期/越过6/1 → 段结束（前面/后面没投，正常）；遇6月日期但不连续 → 中间断裂跳过
  let N = 0; let brokenAt = null;
  { let curDD = startDD;
    for (let k = 0; startIdx + k < subDates.length; k++) {
      const p = parseMD(subDates[startIdx + k]);
      if (!p) break;                       // 空行/非日期 → 段结束
      if (p.mm !== 6) break;               // 进入5月等 → 6月段结束
      if (p.dd === curDD) {
        N++; curDD--;
        if (curDD < 1) break;              // 到 6/1 之后停
      } else {
        brokenAt = { expect: `6/${curDD}`, got: `${p.mm}/${p.dd}`, row: startIdx + k + 2 };
        break;
      }
    }
  }
  if (brokenAt) {
    console.log(`  ⚠ 跳过：6月日期中间断裂 r${brokenAt.row} 应为${brokenAt.expect}实为${brokenAt.got}（缺天/重复），数据不可靠`);
    return { product, subName, sheet, skippedNoDate: true };
  }
  if (N < 1) {
    console.log(`  ⚠ 跳过：6月起点无有效连续数据`);
    return { product, subName, sheet, skippedNoDate: true };
  }
  const startRow = startIdx + 2;          // 表行号（段起点 6/startDD）
  const endRow = startRow + N - 1;        // 表行号（段末天）
  const lastDate = subDates[startIdx + N - 1];
  // 日报核查 A2=6/28 起递减，6/d 对应核查行 = 2 + (28 - d)。段起点 6/startDD 的核查行偏移：
  const checkStartRow = 2 + (28 - startDD);
  const note = startDD < 28 ? `（起点6/${startDD}<6/28，月末未投/起步晚，正常）` : (N < 28 ? '（月初未投，正常）' : '');
  console.log(`  对齐: 表 r${startRow}(6/${startDD}) → r${endRow}(${lastDate})，连续${N}天；核查行 ${checkStartRow}..${checkStartRow + N - 1}${note}`);

  // 提取 C/D/F (2/3/5) 与原 K(10)，从 startIdx 起 N 行
  const cdf = [], kOld = [];
  for (let k = 0; k < N; k++) {
    const row = sub[startIdx + k];
    cdf.push({ C: parseNum(row[2] && row[2].value), D: parseNum(row[3] && row[3].value), F: parseNum(row[5] && row[5].value) });
    kOld.push(parseNum(row[10] && row[10].value));
  }

  // 2) 写日报核查 C/D/F（C/D 空值当 0 处理，避免依赖 C 的 H/K 公式报空；F 保留空为空）
  const cCells = cdf.map(x => [{ value: x.C == null ? 0 : x.C }]);
  const dCells = cdf.map(x => [{ value: x.D == null ? 0 : x.D }]);
  const fCells = cdf.map(x => [{ value: x.F == null ? '' : x.F }]);
  const checkEndRow = checkStartRow + N - 1;  // 日报核查写入末行
  if (!DRY) {
    setCells(MAIN, CHECK_SHEET, `C${checkStartRow}:C${checkEndRow}`, cCells); sleep(180);
    setCells(MAIN, CHECK_SHEET, `D${checkStartRow}:D${checkEndRow}`, dCells); sleep(180);
    setCells(MAIN, CHECK_SHEET, `F${checkStartRow}:F${checkEndRow}`, fCells); sleep(180);
  }

  // 3) 取产品公式模板，retarget R=2..29，填 G:L
  const tmpl = getProductFormulas(product);
  if (!tmpl) throw new Error(`新版汇总未找到产品块 "${product}"`);
  const cols = ['G', 'H', 'I', 'J', 'K', 'L'];
  if (!DRY) {
    const glCells = [];
    for (let R = checkStartRow; R <= checkEndRow; R++) {
      glCells.push(cols.map(c => {
        const f = retarget(tmpl[c], R);
        return (typeof f === 'string' && f.startsWith('=')) ? { formula: f } : { value: f };
      }));
    }
    setCells(MAIN, CHECK_SHEET, `G${checkStartRow}:L${checkEndRow}`, glCells); sleep(400);
  }

  // 4) 读回计算值
  sleep(800);
  const res = getRange(MAIN, CHECK_SHEET, `G${checkStartRow}:L${checkEndRow}`, 'value');
  const glVals = res.map(row => row.map(c => parseNum(c && c.value)));

  // 5) 粘回分表 G{startRow}:L{endRow}
  if (!DRY) {
    const back = glVals.map(row => row.map(v => ({ value: v == null ? 0 : v })));  // null 写 0（不写文本空串，避免汇总公式报错）
    const backRange = `G${startRow}:L${endRow}`;
    setCells(doc, sheet, backRange, back); sleep(300);
    console.log(`  ✓ 已粘回分表 ${backRange}`);
  }

  // 计算 K 差额（K = index 4 于 G:L）
  const rows = [];
  let sKold = 0, sKnew = 0;
  for (let k = 0; k < N; k++) {
    const knew = glVals[k][4];
    const kold = kOld[k];
    rows.push({ date: subDates[startIdx + k], K_old: kold, K_new: knew, diff: (knew == null || kold == null) ? null : (knew - kold) });
    if (typeof kold === 'number') sKold += kold;
    if (typeof knew === 'number') sKnew += knew;
  }
  return { product, subName, sheet, rows, sumKold: sKold, sumKnew: sKnew, sumDiff: sKnew - sKold };
}

function fmt(n) { return n == null ? 'NA' : (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function main() {
  if (ALL) {
    if (!DOC) { console.error('--all 需 --doc'); process.exit(2); }
    const MAP = DOC_MAPS[DOC];
    if (!MAP) { console.error(`未知文档 ${DOC}，请在 DOC_MAPS 里加映射`); process.exit(2); }
    const summary = [];
    for (const [sid, subName, product] of MAP) {
      if (product == null) { console.log(`\n=== 跳过 [${subName}] (无对应产品块/忽略) ===`); summary.push({ subName, skipped: true }); continue; }
      try {
        const r = calibrateOne(DOC, sid, subName, product);
        summary.push(r);
        if (r.skippedNoDate) { console.log(`  (无完整月数据，已忽略)`); }
        else console.log(`  K 总计: 原=${fmt(r.sumKold)} 新=${fmt(r.sumKnew)} 差=${fmt(r.sumDiff)}`);
      } catch (e) {
        console.error(`  ❌ [${subName}] 失败: ${e.message}`);
        summary.push({ subName, product, error: e.message });
      }
      sleep(500);
    }
    // 输出汇总
    console.log('\n\n########## K列(运营净利润) 差额汇总 ##########');
    console.log('产品渠道 | 原K总计 | 新K总计 | 差额(新-原)');
    let grand = 0;
    for (const s of summary) {
      if (s.skipped) { console.log(`${s.subName} | 跳过(忽略)`); continue; }
      if (s.skippedNoDate) { console.log(`${s.subName} | 跳过(无完整月数据)`); continue; }
      if (s.error) { console.log(`${s.subName} | 错误: ${s.error}`); continue; }
      console.log(`${s.subName} | ${fmt(s.sumKold)} | ${fmt(s.sumKnew)} | ${fmt(s.sumDiff)}`);
      grand += s.sumDiff;
    }
    console.log(`\n全部产品 K 差额总和（新-原）= ${fmt(grand)}`);
    // 写 JSON 供后续
    require('fs').writeFileSync('/tmp/calibrate-summary.json', JSON.stringify(summary, null, 1));
    console.log('明细已写 /tmp/calibrate-summary.json');
    return;
  }
  // 单产品
  if (!DOC || !SHEET || !PRODUCT) { console.error('用法: --doc <token> --sheet <sheetId> --product "<产品块名>"  或  --doc <token> --all'); process.exit(2); }
  const r = calibrateOne(DOC, SHEET, SHEET, PRODUCT);
  console.log(`  K 总计: 原=${fmt(r.sumKold)} 新=${fmt(r.sumKnew)} 差=${fmt(r.sumDiff)}`);
}
main();
