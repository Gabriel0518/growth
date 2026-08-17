#!/usr/bin/env node
/**
 * Sync 日报数据 (源表 KlXHsPavJhpcbOtiZYecbOYun3b / Sheet1)
 *   →  日报数据汇总 (wiki 表 LPn7shI4Kh0jeOtvyP0cd6ffnmf, 一产品一 sheet)
 *
 * 逻辑(屹恒确认版):
 *   - 从 PWA 开始,再各产品分表。PWA 必须先建行(产品分表有跨表引用 PWA!...)。
 *   - 每个目标 sheet:读第2行日期。
 *       · == 昨天        → 已是最新,跳过
 *       · == 前天        → 在第1、2行之间插入1行,写昨天数据
 *       · 其它(漏跑多天)→ 报警告,不自动处理
 *   - 新行:值列从源表取昨天的值,源表无数据 → 留空(不照抄业务数值)。
 *           公式列 = "和前一天完全相同的相对引用结构"。
 *   - 飞书 insert 行为(实测):本表相对引用自动平移;跨表引用行号【不】平移。
 *           → 插入后必须把下移的旧行的跨表引用行号 +1 修复,
 *             新第2行的跨表引用指向第2行(与 PWA 同一天对齐)。
 *
 * 用法:
 *   node scripts/sync-daily-report-to-wiki.js            # 正常执行
 *   node scripts/sync-daily-report-to-wiki.js --dry-run  # 只分析不写
 */

const crypto = require('crypto');
const https = require('https');

// ── Config ──
const SRC_TOKEN = 'KlXHsPavJhpcbOtiZYecbOYun3b';
const SRC_SHEET = '2c762a';
const DST_TOKEN = 'LPn7shI4Kh0jeOtvyP0cd6ffnmf';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const FEISHU_API = 'https://open.feishu.cn/open-apis';

const DRY_RUN = process.argv.includes('--dry-run');
const FIRST_RUN = process.argv.includes('--first-run'); // 首跑:无论成败都发报告

// 通知接收人(屹恒)
const NOTIFY_OPEN_ID = 'ou_b2467dac5ff1d686fb48ccf1fbaa0c0d';

// 产品名 → 目标 sheet(前缀匹配;这里直接给定 sheet_id 避免重名歧义)
// 顺序:PWA 先,再各产品分表
const PWA_SHEET = { product: 'PWA', name: 'PWA', sheetId: 'gFdKrM' };

// 目标产品分表(只处理可见的,隐藏的不管)。product = 源表里的产品块名(A 列标题)
const PRODUCT_SHEETS = [
  { product: 'GraceChat', name: 'GraceChat FB TT',    sheetId: 'xZK5eJ' },
  { product: 'Dora iOS',  name: 'Dora iOS FB TT',     sheetId: 'qIOYoD' },
  { product: 'Dora And',  name: 'Dora And FB TT GG',  sheetId: '42neNp' },
  { product: 'Doni',      name: 'Doni And FB TT GG',  sheetId: 'ywWoQO' },
  { product: 'Romi iOS',  name: 'Romi iOS FB TT',     sheetId: 'BImkny' },
  { product: 'Luma',      name: 'Luma iOS FB TT',     sheetId: 'H6GyXn' },
  { product: 'Jovia And', name: 'Jovia And FB TT GG', sheetId: 'qBO1d8' },
  { product: 'Romi And',  name: 'Romi And FB TT',     sheetId: 'Y3ZxII' },
  { product: 'Nalo And',  name: 'Nalo And FB TT',     sheetId: 'PbF8db' },
  { product: 'Kira And',  name: 'Kira And FB TT',     sheetId: 'VojrKa' },
  { product: 'Kira iOS',  name: 'Kira iOS FB TT',     sheetId: 'QEtdgv' },
];

// 全产品汇总表(全公式,无源表值列)
const SUMMARY_SHEET = { name: '全产品汇总', sheetId: 'IpeVKX', maxCol: 23 };

// 普通产品分表:目标列 → 源表 Sheet1 列(值列映射)
// 目标 sheet 中其它列若为公式 → 复制前一天公式结构(不在此映射里)
// 目标 B 列(渠道名) 源表没有 → 若是值则照抄前一天该格(属于"标签/结构",非业务数值)
const PROD_VALUE_MAP = {
  A: 'A', // 日期
  C: 'C', // 花费
  D: 'D', // 男生人数 / 注册数
  F: 'F', // 收益
  H: 'H', // 返点
  N: 'N', // 总付费人数
  O: 'O', // 总付费单数
  S: 'S', // 新用户首日收益
  U: 'U', // 新用户付费人数
};
// B 列(渠道名) 是"结构标签",照抄前一天的值
const PROD_LABEL_COLS = ['B'];

// PWA 分表:目标列 → 源表 PWA 块列(值列映射)
const PWA_VALUE_MAP = {
  A: 'A', // 日期
  B: 'B', // 花费
  C: 'C', // 女生注册人数
  R: 'R', S: 'S', T: 'T', U: 'U', V: 'V', W: 'W',
  X: 'X', Y: 'Y', Z: 'Z', AA: 'AA', AB: 'AB', // 各产品日活
};
// PWA 的 E/F(主播成本/PWA提现成本) 源表无 → 留空(屹恒确认)

// ── 列字母 <-> 索引 ──
function colToIdx(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function idxToCol(i) {
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ── HTTP ──
function httpRequest(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : '';
    const options = {
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
function httpGet(url, headers = {}) { return httpRequest('GET', url, null, headers); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Feishu auth ──
async function getToken() {
  const res = await httpRequest('POST', `${FEISHU_API}/auth/v3/tenant_access_token/internal`,
    { app_id: APP_ID, app_secret: APP_SECRET });
  if (!res.tenant_access_token) throw new Error('Feishu token failed: ' + JSON.stringify(res));
  return res.tenant_access_token;
}

// 发飞书私信给屹恒
async function notify(token, text) {
  try {
    const url = `${FEISHU_API}/im/v1/messages?receive_id_type=open_id`;
    const body = {
      receive_id: NOTIFY_OPEN_ID,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    };
    const res = await httpRequest('POST', url, body, { Authorization: `Bearer ${token}` });
    if (res.code !== 0) console.error('[notify] failed:', JSON.stringify(res));
  } catch (e) { console.error('[notify] error:', e.message); }
}

// ── 读取区域(带公式)──
// valueRenderOption=FormulaValue → 公式格返回 "=..." 字符串,值格返回原值
async function readRange(token, sheetId, range) {
  const url = `${FEISHU_API}/sheets/v2/spreadsheets/${DST_TOKEN}/values/${sheetId}!${range}?valueRenderOption=Formula`;
  const res = await httpGet(url, { Authorization: `Bearer ${token}` });
  if (res.code !== 0) throw new Error(`readRange ${sheetId}!${range} failed: ${JSON.stringify(res)}`);
  return res.data.valueRange.values; // 二维数组
}
async function readSrcRange(token, range) {
  const url = `${FEISHU_API}/sheets/v2/spreadsheets/${SRC_TOKEN}/values/${SRC_SHEET}!${range}?valueRenderOption=ToString`;
  const res = await httpGet(url, { Authorization: `Bearer ${token}` });
  if (res.code !== 0) throw new Error(`readSrcRange ${range} failed: ${JSON.stringify(res)}`);
  return res.data.valueRange.values;
}

// ── 插入行 ──
async function insertRow(token, sheetId, beforeRow /* 1-based, 在此行前插 */) {
  const url = `${FEISHU_API}/sheets/v2/spreadsheets/${DST_TOKEN}/insert_dimension_range`;
  const body = {
    dimension: {
      sheetId, majorDimension: 'ROWS',
      startIndex: beforeRow - 1,  // 0-based 起点 = beforeRow-1
      endIndex: beforeRow,        // 插 1 行
    },
    inheritStyle: 'AFTER',  // 继承插入点之后那一行(原第2行=数据行)的格式,而非之前的表头行
  };
  const res = await httpRequest('POST', url, body, { Authorization: `Bearer ${token}` });
  if (res.code !== 0) throw new Error(`insertRow ${sheetId}@${beforeRow} failed: ${JSON.stringify(res)}`);
  return res;
}

// ── 写区域 ──
async function writeRange(token, sheetId, range, values) {
  const url = `${FEISHU_API}/sheets/v2/spreadsheets/${DST_TOKEN}/values`;
  const body = { valueRange: { range: `${sheetId}!${range}`, values } };
  const res = await httpRequest('PUT', url, body, { Authorization: `Bearer ${token}` });
  if (res.code !== 0) throw new Error(`writeRange ${sheetId}!${range} failed: ${JSON.stringify(res)}`);
  return res;
}

// ── 日期工具 ──
function beijingNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function fmtDisplay(d) { // Date → "2026/6/22"
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
function yesterdayDisp() { const d = beijingNow(); d.setUTCDate(d.getUTCDate() - 1); return fmtDisplay(d); }
function dayBeforeDisp() { const d = beijingNow(); d.setUTCDate(d.getUTCDate() - 2); return fmtDisplay(d); }
// 归一化日期字符串:"2026/06/22" / "2026/6/22" / "2026-6-22" → "2026/6/22"
// 也支持飞书日期序列号(Formula 模式下日期格返回数值,如 46194 = 2026/6/21)
function normDate(s) {
  if (s == null) return '';
  const str = String(s).trim();
  // 纯数字 → 视为飞书/Excel 日期序列号(1899-12-30 起算)
  if (/^\d+(\.0+)?$/.test(str)) {
    const n = parseInt(str, 10);
    if (n > 30000 && n < 80000) { // 合理日期范围(约1982~2089)
      const ms = (n - 25569) * 86400 * 1000;
      const d = new Date(ms);
      return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    }
  }
  const m = str.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return str;
  return `${parseInt(m[1])}/${parseInt(m[2])}/${parseInt(m[3])}`;
}

// 日期字符串 "2026/6/28" → 飞书/Excel 日期序列号(1899-12-30 起算)
function dateToSerial(dateStr) {
  const m = dateStr.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return '';
  const d = new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
  const epoch = new Date(Date.UTC(1899, 11, 30));
  return Math.floor((d - epoch) / 86400000);
}

// 单元格转写入格式:公式格用字符串 "=...",值格用原值,空 → ""
function cellOut(v) {
  if (v === null || v === undefined) return '';
  return v;
}

// 公式行号平移:把公式里【本表】行引用整体 +delta;【跨表引用】不动(飞书 insert 已经/将由我们单独处理)
// 但我们这里反过来用:生成"新第2行公式" = 取旧行公式(现第3行)做行号归一。
// 实际算法见 buildNewRowFormula。

// 解析公式,找出跨表引用片段('Sheet Name'!REF 或 SheetName!REF)。返回 {hasCross}
function isCrossSheetRef(formula) {
  return /!/.test(formula) && /'[^']+'!|[A-Za-z0-9_]+!/.test(formula);
}

// 把公式中所有【本表】单元格行号 设为目标行号 targetRow;【跨表引用】的行号设为 crossRow。
// 本表引用:形如 A2, $C12, B$3(前面没有 ! )
// 跨表引用:'Name'!A2  或  Name!A2
function retargetFormula(formula, targetRow, crossRow) {
  // 先保护跨表引用,临时替换占位
  const crossPlaceholders = [];
  // 匹配 'xxx'!REF 或 word!REF(REF 可能是 A2 / $A$2 / A2:B3 等,逐个 token 处理行号)
  let f = formula.replace(/('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_ ]*)!(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)/g,
    (full, sheetPart, ref) => {
      // 替换 ref 内的行号为 crossRow(保留 $ 前缀)
      const newRef = ref.replace(/(\$?[A-Z]+)(\$?)(\d+)/g, (mm, colp, dollar, _row) => `${colp}${dollar}${crossRow}`);
      const ph = `\u0001${crossPlaceholders.length}\u0001`;
      crossPlaceholders.push(`${sheetPart}!${newRef}`);
      return ph;
    });
  // 处理剩下的本表行引用:把每个 A2 / $C12 的行号设为 targetRow(保留 $)
  f = f.replace(/(\$?[A-Z]+)(\$?)(\d+)/g, (mm, colp, dollar, _row) => `${colp}${dollar}${targetRow}`);
  // 还原跨表占位
  f = f.replace(/\u0001(\d+)\u0001/g, (mm, i) => crossPlaceholders[parseInt(i)]);
  return f;
}

// 只平移公式中【跨表引用】的行号 +delta,本表引用不动(用于修复下移后的旧行)
function shiftCrossRefRows(formula, delta) {
  return formula.replace(/('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_ ]*)!(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)/g,
    (full, sheetPart, ref) => {
      const newRef = ref.replace(/(\$?[A-Z]+)(\$?)(\d+)/g, (mm, colp, dollar, row) => `${colp}${dollar}${parseInt(row) + delta}`);
      return `${sheetPart}!${newRef}`;
    });
}

function isFormula(v) { return typeof v === 'string' && v.startsWith('='); }

// 解析源表,按产品块定位某产品某天的整行(返回 {col->value}),无则 null
async function loadSourceBlocks(token) {
  // 读源表 A1:AB80(覆盖所有产品块 + PWA)
  const rows = await readSrcRange(token, 'A1:AB80');
  // 找产品块:A 列是产品名(非日期、非空)的行 = 块标题
  const blocks = {}; // product -> [ {date, cols:{A..AB}} ]
  let cur = null;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const a = (row[0] == null ? '' : String(row[0]).trim());
    if (!a) { continue; }
    const isDate = /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/.test(a);
    if (!isDate) {
      // 块标题
      cur = a; blocks[cur] = [];
    } else if (cur) {
      const cols = {};
      for (let c = 0; c < row.length; c++) {
        cols[idxToCol(c)] = (row[c] == null ? '' : row[c]);
      }
      blocks[cur].push({ date: normDate(a), cols });
    }
  }
  return blocks;
}

// 在源块里找指定日期的行
function findSrcRow(blocks, productKey, dateDisp) {
  // 前缀匹配:源块名 == productKey(这里 product 就是源块名)
  const arr = blocks[productKey];
  if (!arr) return null;
  return arr.find(x => x.date === normDate(dateDisp)) || null;
}

// 处理单个目标 sheet
async function processSheet(token, cfg, valueMap, labelCols, srcBlocks, maxCol, warnings, report, fillZero = false) {
  const Y = yesterdayDisp();
  const DB = dayBeforeDisp();
  const lastColLetter = idxToCol(maxCol - 1);

  // 读第1、2、3行(带公式)
  const head = await readRange(token, cfg.sheetId, `A1:${lastColLetter}3`);
  const row2 = head[1] || [];
  const date2 = normDate(row2[0]);

  if (date2 === normDate(Y)) {
    report.push(`  ✅ ${cfg.name}: 第2行已是昨天(${Y}),跳过`);
    return;
  }
  if (date2 !== normDate(DB)) {
    const w = `⚠️ ${cfg.name}: 第2行日期=${date2 || '(空)'},既不是昨天(${Y})也不是前天(${DB}),需手动处理`;
    warnings.push(w); report.push('  ' + w);
    return;
  }

  // 命中:第2行=前天,需要插行补昨天
  report.push(`  ↪ ${cfg.name}: 第2行=前天(${DB}),插入昨天(${Y})行`);
  if (DRY_RUN) { report.push(`     [dry-run] 将 insert 第2行 + 写值/公式`); return; }

  // 取源表昨天数据
  const srcRow = findSrcRow(srcBlocks, cfg.product, Y); // 可能为 null

  // 1) 插入空行(在第2行前)→ 旧第2行变第3行,旧第3行变第4行
  //    飞书会自动平移本表相对引用。
  //    跨表引用(如 PWA!)的修复不在这里做:
  //    因为 PWA 分表先 insert 时,飞书已经自动把所有产品表对 PWA 的
  //    跨表引用行号 +1(旧行全部正确指向 PWA 新行号)。
  //    实测证实:不需要手动 fixCrossRefsBelow,否则会重复 +1 造成错位。
  await insertRow(token, cfg.sheetId, 2);

  // 3) 写新第2行:逐列判断旧行(现第3行)是值还是公式
  const newHead = await readRange(token, cfg.sheetId, `A3:${lastColLetter}3`); // 旧第2行(现第3行)
  const oldRow = newHead[0] || [];
  const out = [];
  for (let c = 0; c < maxCol; c++) {
    const col = idxToCol(c);
    const oldVal = oldRow[c];
    if (isFormula(oldVal)) {
      // 公式列:新第2行公式 = 本表引用→2,跨表引用→2(与 PWA 同一天对齐)
      // ⚠飞书 v2 /values 会把 "=..." 字符串当成纯文本存(需手动点击才生效)。
      // 必须用单元格对象 {type:'formula', text:'=...'} 写入,才是真公式。
      out.push({ type: 'formula', text: retargetFormula(oldVal, 2, 2) });
    } else if (valueMap[col]) {
      // 值列:从源表取昨天该列值;无 → 留空
      const v = srcRow ? srcRow.cols[valueMap[col]] : '';
      out.push(cellOut(v === '' || v == null ? '' : v));
    } else if (labelCols && labelCols.includes(col)) {
      // 结构标签列(如渠道名):照抄前一天
      out.push(cellOut(oldVal == null ? '' : oldVal));
    } else {
      // 其它非公式非映射列:留空
      out.push('');
    }
  }
  // fillZero: 产品分表的空白格用0填充(避免公式 #VALUE! 错误)
  if (fillZero) {
    let lastUsed = -1;
    for (let c = maxCol - 1; c >= 0; c--) {
      if (oldRow[c] != null && oldRow[c] !== '') { lastUsed = c; break; }
    }
    for (let c = 0; c <= lastUsed; c++) {
      if (out[c] === '') out[c] = 0;
    }
  }
  await writeRange(token, cfg.sheetId, `A2:${lastColLetter}2`, [out]);
  const fillNote = fillZero
    ? (srcRow ? '源表有数据,空白填0' : '源表无数据,空白填0')
    : (srcRow ? '源表有数据' : '源表无数据,值列留空');
  report.push(`     ✓ 已写入新第2行 (${fillNote})`);
}

// (已移除 fixCrossRefsBelow:实测飞书在 PWA insert 时会自动平移所有产品表对 PWA 的
//  跨表引用行号,手动再修会重复 +1 导致错位。务必保持 PWA 先 insert、产品表后处理的顺序。)

// ── 全产品汇总表处理 ──
// 全产品汇总是全公式表(无源表值列),所有非日期列都是跨表公式(汇总各产品分表)。
// 处理逻辑:
//   1. 读第2行日期,同产品分表判断逻辑(==昨天跳过 / ==前天插行)
//   2. 保存原始第2行公式(这些指向其他分表的 row2 = 昨天数据)
//   3. 插入空行 → 旧第2行变第3行
//   4. 修复第3行: 飞书自动平移本表引用(✓), 但跨表引用行号不动 → 需手动 +1
//      (因为各产品分表已经先 insert 了,它们的旧 row2 变成了 row3, 而全产品汇总旧行仍指 row2 = 昨天)
//   5. 新第2行: 使用原始公式(本表引用→row2 ✓, 跨表引用→其他分表row2=昨天 ✓), 日期列更新
async function processSummarySheet(token, cfg, maxCol, warnings, report) {
  const Y = yesterdayDisp();
  const DB = dayBeforeDisp();
  const lastColLetter = idxToCol(maxCol - 1);

  // 读第2行(带公式)
  const head = await readRange(token, cfg.sheetId, `A1:${lastColLetter}2`);
  const row2 = head[1] || []; // [A2, B2, C2, ...]
  const date2 = normDate(row2[0]);

  if (date2 === normDate(Y)) {
    report.push(`  ✅ ${cfg.name}: 第2行已是昨天(${Y}),跳过`);
    return;
  }
  if (date2 !== normDate(DB)) {
    const w = `⚠️ ${cfg.name}: 第2行日期=${date2 || '(空)'},既不是昨天(${Y})也不是前天(${DB}),需手动处理`;
    warnings.push(w); report.push('  ' + w);
    return;
  }

  report.push(`  ↪ ${cfg.name}: 第2行=前天(${DB}),插入昨天(${Y})行`);
  if (DRY_RUN) { report.push(`     [dry-run] 将 insert 第2行 + 写公式`); return; }

  // 保存原始第2行公式(插入前读取,这些公式指向各产品分表 row2 = 昨天)
  const origRow2 = row2.slice();

  // 插入空行(第2行前) → 旧第2行变第3行
  await insertRow(token, cfg.sheetId, 2);

  // 修复第3行(旧行): 飞书已自动平移本表引用(D2→D3等), 跨表引用不动需手动+1
  const row3Data = await readRange(token, cfg.sheetId, `A3:${lastColLetter}3`);
  const row3 = row3Data[0] || []; // Feishu 已自动平移本表引用
  const fixedRow3 = [];
  for (let c = 0; c < maxCol; c++) {
    const val = row3[c];
    if (isFormula(val)) {
      if (isCrossSheetRef(val)) {
        // 跨表引用 +1: 旧行现在应指向各产品分表的 row3(前天数据)
        fixedRow3.push({ type: 'formula', text: shiftCrossRefRows(val, 1) });
      } else {
        // 本表公式, 飞书已自动平移, 直接写入
        fixedRow3.push({ type: 'formula', text: val });
      }
    } else {
      // 非公式值(日期序列号等), 保持原样
      fixedRow3.push(val == null ? '' : val);
    }
  }
  await writeRange(token, cfg.sheetId, `A3:${lastColLetter}3`, [fixedRow3]);

  // 新第2行: 使用原始公式 + 更新日期列
  const yesterdaySerial = dateToSerial(Y);
  const newRow2 = [];
  for (let c = 0; c < maxCol; c++) {
    const origVal = origRow2[c];
    if (c === 0 || c === 20) {
      // A列(日期) 和 U列(日期序列号): 更新为昨天
      newRow2.push(yesterdaySerial);
    } else if (isFormula(origVal)) {
      // 公式: 原始公式已指向各产品分表 row2 = 昨天数据, 直接使用
      newRow2.push({ type: 'formula', text: origVal });
    } else {
      // 非公式非日期列(F=推理成本, H=备注等): 新行留空
      newRow2.push('');
    }
  }
  await writeRange(token, cfg.sheetId, `A2:${lastColLetter}2`, [newRow2]);
  report.push(`     ✓ 已写入新第2行 (全公式, 昨天=${Y})`);
}

// ── Main ──
async function main() {
  console.log(`[Sync] ${DRY_RUN ? '*** DRY-RUN ***' : 'LIVE'} | 昨天=${yesterdayDisp()} 前天=${dayBeforeDisp()}`);
  const token = await getToken();
  const srcBlocks = await loadSourceBlocks(token);
  console.log(`[Sync] 源表产品块: ${Object.keys(srcBlocks).join(', ')}`);

  const warnings = [];
  const report = [];

  // 1) PWA 先(28 列)
  report.push('【PWA】');
  await processSheet(token, PWA_SHEET, PWA_VALUE_MAP, [], srcBlocks, 28, warnings, report);

  // 2) 各产品分表(35 列, 空白填0)
  report.push('【产品分表】');
  for (const cfg of PRODUCT_SHEETS) {
    await processSheet(token, cfg, PROD_VALUE_MAP, PROD_LABEL_COLS, srcBlocks, 35, warnings, report, true);
    await sleep(300); // 轻微限速
  }

  // 3) 全产品汇总(23 列, 全公式, 必须在所有分表之后处理)
  report.push('【全产品汇总】');
  await processSummarySheet(token, SUMMARY_SHEET, SUMMARY_SHEET.maxCol, warnings, report);

  console.log('\n==== 同步报告 ====');
  console.log(report.join('\n'));
  if (warnings.length) {
    console.log('\n==== ⚠️ 警告（需手动处理）====');
    console.log(warnings.join('\n'));
  }
  console.log(`\n[Sync] 完成。表: https://presence.feishu.cn/wiki/OsnMwjQnaiAoIXkGvrBcgN8CnUg`);
  // 输出机器可读结果（供调度脚本判断是否要 @ 提醒屹恒）
  console.log('\n[RESULT_JSON] ' + JSON.stringify({ warnings, dryRun: DRY_RUN }));

  // 飞书通知策略：首跑无论成败都发；之后只在有警告时发
  if (!DRY_RUN) {
    const head = `📊 日报汇总同步 · ${yesterdayDisp()}`;
    const body = report.join('\n');
    if (FIRST_RUN) {
      let msg = `${head}\uff08首次运行）\n\n${body}`;
      if (warnings.length) msg += `\n\n⚠️ 警告：\n${warnings.join('\n')}`;
      await notify(token, msg);
    } else if (warnings.length) {
      await notify(token, `${head}\n⚠️ 有 ${warnings.length} 个 sheet 需手动处理：\n${warnings.join('\n')}`);
    }
  }
}

main().catch(async e => {
  console.error('[Sync] FATAL:', e.message);
  // 失败总是通知
  try {
    const t = await getToken();
    await notify(t, `❌ 日报汇总同步失败 · ${yesterdayDisp()}\n错误：${e.message}`);
  } catch (_) {}
  process.exit(1);
});
