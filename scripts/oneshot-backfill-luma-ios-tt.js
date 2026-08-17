#!/usr/bin/env node
/**
 * 【一次性脚本】把 Luma iOS TT 从 7/11 追溯补齐到昨天。
 *
 * 背景：Luma iOS TT 是新增产品×渠道，7/11 起有消耗和收入。模板 TAVpj9 已手工建好
 *       block（header 行 116，数据行 117..122 = 7/16..7/11），但 C/D/F 是占位值；
 *       分表 DDYumd 空（仅表头 row1）；汇总 jv5kT4 求和公式未含 'Luma iOS TT'。
 *       日常脚本已改造识别（fill 加 block 116、backfill 加 DDYumd 映射），但对历史无能为力。
 *
 * 本脚本做三件事（与日常 cron 无冲突：只处理 7/11~昨天历史；日常脚本从今日之后接手）：
 *   1) 拉 dashboard 个人面板 Luma|TT 各天真实 cost/installs/revenue，写入模板 block
 *      C/D/F（行 116+i，i=1..6 对应 7/16..7/11），让 G-L 公式按真实数重算。
 *   2) 回读模板 block A:L 渲染值（逐行单格寻址），写入分表 DDYumd（row2 起，新→旧）。
 *   3) 给汇总 jv5kT4 中「日期 >= FROM(7/11)」的数据行的 C/D/E/F/G/H 公式追加
 *      +'Luma iOS TT'!<col>N（C→C,D→G,E→H,F→I,G→J,H→K）。早于 7/11 的行不动
 *      （那时 Luma iOS TT 无消耗）。日常 sync 用 row2 为模板，含 Luma 项后自动向后传。
 *
 * 用法：
 *   node oneshot-backfill-luma-ios-tt.js --dry-run
 *   node oneshot-backfill-luma-ios-tt.js
 *   node oneshot-backfill-luma-ios-tt.js --from=2026-07-11   # 覆盖起始日期
 */
const http = require('http');
const { execFileSync } = require('child_process');

const DASH_BASE = 'http://localhost:8081';
const DASH_USER = 'admin';
const DASH_PASS = 'd3dkJdSXvkuuYZoqg_5O4Q';

const SRC_TOKEN = 'N1FcsGvXThXu97t7ZYyccCHDnIg'; // 投放日报模板
const SRC_SHEET = 'TAVpj9';                       // 苏屹恒模版
const DST_TOKEN = 'V7nysbQd3huZvStpd6Tcv7HUnJc'; // 苏屹恒投放日报
const DST_SUBTAB = 'DDYumd';                      // Luma iOS TT 分表
const SUM_SHEET = 'jv5kT4';                        // 苏屹恒汇总

const BLOCK_HEADER = 116; // 模板 Luma iOS TT block header 行（单格实测=A116）；数据行 116+i (i>=1)，即 117=7/16..122=7/11
const PRODUCT = 'Luma';
const CHANNEL = 'TT';
const SUBTAB_NAME = 'Luma iOS TT'; // 汇总公式里要追加的分表名

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';
const DRY_RUN = process.argv.includes('--dry-run');
const fromArg = (process.argv.find((a) => a.startsWith('--from=')) || '').split('=')[1];
const FROM = fromArg || '2026-07-11';

// 汇总列 -> 分表列 映射
const SUM_TO_SUB = { C: 'C', D: 'G', E: 'H', F: 'I', G: 'J', H: 'K' };

function sleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }

// ── 日期工具（北京时间，date-only UTC）──
function beijingTodayStr() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function addDaysStr(s, n) { const dt = parseYmd(s); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); }
function daysBetweenStr(a, b) { return Math.round((parseYmd(a) - parseYmd(b)) / 86400000); }
function ymdToSlash(s) { const [y, m, d] = s.split('-').map(Number); return `${y}/${m}/${d}`; }
function slashToYmd(s) { const m = String(s).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : null; }

// ── HTTP（dashboard）──
function httpRequest(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(DASH_BASE + path);
    const req = http.request({ method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers },
      (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') })); });
    req.on('error', reject); req.setTimeout(60000, () => { req.destroy(new Error('dashboard request timeout')); });
    if (body) req.write(body); req.end();
  });
}
async function dashLogin() {
  const form = `username=${encodeURIComponent(DASH_USER)}&password=${encodeURIComponent(DASH_PASS)}`;
  const res = await httpRequest('POST', '/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, body: form });
  const setCookie = res.headers['set-cookie'];
  if (!setCookie || !setCookie.length) throw new Error('Dashboard login: no session cookie');
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}
async function fetchLumaTt(cookie, date) {
  const res = await httpRequest('GET', `/api/postback/personal?date=${date}`, { headers: { Cookie: cookie } });
  if (res.status !== 200) throw new Error(`personal API ${date} -> HTTP ${res.status}`);
  const data = JSON.parse(res.body);
  const syh = (data.operators || []).find((o) => o.operator === 'syh');
  if (!syh) return { cost: 0, installs: 0, revenue: 0 };
  for (const p of (syh.products || [])) {
    if (p.product !== PRODUCT) continue;
    for (const c of (p.channels || [])) {
      if (c.channel !== CHANNEL) continue;
      const installs = (c.campaigns || []).reduce((s, camp) => s + (camp.installs || 0), 0);
      return { cost: c.cost || 0, installs, revenue: c.revenue || 0 };
    }
  }
  return { cost: 0, installs: 0, revenue: 0 };
}

// ── lark-cli helpers ──
function lark(args, input) {
  const MAX = 4; let lastErr;
  for (let a = 1; a <= MAX; a++) {
    try { return execFileSync('lark-cli', args, { input: input || undefined, env: { ...process.env, OPENCLAW_HOME }, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); }
    catch (e) { lastErr = e; const m = (e.stdout || '') + (e.stderr || '') + e.message; if (a < MAX && /recommited|server_error|rev is|timeout|ECONN|429|rate|lock/i.test(m)) { sleep(800 * a); continue; } throw e; }
  }
  throw lastErr;
}
function getValues(token, sheetId, range, include) {
  const out = lark(['sheets', '+cells-get', '--spreadsheet-token', token, '--sheet-id', sheetId, '--range', range, '--include', include || 'value', '--as', 'user', '--format', 'json']);
  return JSON.parse(out).data.ranges[0];
}
function setCells(token, sheetId, range, cells) {
  lark(['sheets', '+cells-set', '--spreadsheet-token', token, '--sheet-id', sheetId, '--range', range, '--as', 'user', '--format', 'json', '--cells', '-'], JSON.stringify(cells));
}
function dimInsertBefore(token, sheetId, pos, count) {
  lark(['sheets', '+dim-insert', '--spreadsheet-token', token, '--sheet-id', sheetId, '--position', String(pos), '--count', String(count), '--inherit-style', 'before', '--as', 'user', '--format', 'json']);
}
function round2(n) { return Math.round((n || 0) * 100) / 100; }

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
function rowCellsFromRendered(values12) {
  return values12.map((v, ci) => {
    if (ci < 2) return { value: v == null ? '' : String(v), cell_styles: { number_format: '@' } };
    const p = parseNum(v);
    if (p.err) return { value: p.raw, cell_styles: { number_format: '@' } };
    return { value: p.num, cell_styles: { number_format: COL_NF[ci] } };
  });
}

async function main() {
  const today = beijingTodayStr();
  const yesterday = addDaysStr(today, -1);
  const daysAsc = [];
  for (let d = FROM; daysBetweenStr(yesterday, d) >= 0; d = addDaysStr(d, 1)) daysAsc.push(d);
  const daysDesc = [...daysAsc].reverse(); // 新→旧：yesterday .. FROM
  const n = daysDesc.length;
  console.log(`[oneshot] 北京今天=${today} 昨天=${yesterday}  补 ${n} 天: ${daysDesc.join(', ')}  dryRun=${DRY_RUN}`);
  if (n < 1) { console.log('[oneshot] 无待补日期，退出。'); return; }
  if (BLOCK_HEADER + n > 130) throw new Error(`模板 block 数据行 ${BLOCK_HEADER + n} 超出安全上限 130`);

  // ── 拉 dashboard 数据 ──
  const cookie = await dashLogin();
  const data = {};
  for (const d of daysDesc) { data[d] = await fetchLumaTt(cookie, d); console.log(`  拉 ${d}: cost=$${round2(data[d].cost)} installs=${data[d].installs} rev=$${round2(data[d].revenue)}`); }

  // ── 步骤1：写模板 block C/D/F（行 116+1+i 对应 daysDesc[i]）──
  console.log(`\n[step1] 写模板 ${SRC_SHEET} block(header ${BLOCK_HEADER}) C/D/F，${n} 天`);
  for (let i = 0; i < n; i++) {
    const row = BLOCK_HEADER + 1 + i; // 117,118,...
    const dd = data[daysDesc[i]];
    const cd = [[
      { value: round2(dd.cost), cell_styles: { number_format: '$#,##0.00' } },
      { value: dd.installs, cell_styles: { number_format: '0' } },
    ]];
    const f = [[{ value: round2(dd.revenue), cell_styles: { number_format: '$#,##0.00' } }]];
    if (DRY_RUN) { console.log(`   row${row} ${daysDesc[i]}  C=$${round2(dd.cost)} D=${dd.installs} F=$${round2(dd.revenue)}`); continue; }
    setCells(SRC_TOKEN, SRC_SHEET, `C${row}:D${row}`, cd); sleep(250);
    setCells(SRC_TOKEN, SRC_SHEET, `F${row}`, f); sleep(300);
  }
  if (!DRY_RUN) { console.log('[step1] 等待模板公式重算 4s...'); sleep(4000); }

  // ── 步骤2：逐行回读模板渲染值（单格寻址），写分表 DDYumd（新→旧）──
  console.log(`\n[step2] 逐行回读模板 A${BLOCK_HEADER + 1}:L${BLOCK_HEADER + n} → 分表 ${DST_SUBTAB}`);
  const rendered = [];
  for (let i = 0; i < n; i++) {
    const rr = BLOCK_HEADER + 1 + i; // 117..
    const rng = getValues(SRC_TOKEN, SRC_SHEET, `A${rr}:L${rr}`, 'value');
    const vals = rng.cells[0].map((c) => (c && c.value != null ? c.value : '')).slice(0, 12);
    rendered.push(vals);
    const gotSlash = String(vals[0] || '').replace(/^(\d{4})\/0?(\d+)\/0?(\d+)$/, '$1/$2/$3');
    const wantSlash = ymdToSlash(daysDesc[i]);
    if (gotSlash !== wantSlash) {
      throw new Error(`[step2] 模板行日期不符：A${rr} 得 "${vals[0]}" 期望 "${wantSlash}"（请确认模板 B1=TODAY()-1 与台历一致），中止`);
    }
    console.log(`   模板 A${rr} = ${vals.join(' | ')}`);
  }

  // 分表现状：row1=表头(日期)，数据从 row2 起。空分表 row2 应为空/非日期。
  const dstR1 = getValues(DST_TOKEN, DST_SUBTAB, 'A1:A1', 'value');
  const dstR2 = getValues(DST_TOKEN, DST_SUBTAB, 'A2:A2', 'value');
  const r1a = dstR1.cells[0] && dstR1.cells[0][0] && dstR1.cells[0][0].value;
  const r2a = dstR2.cells[0] && dstR2.cells[0][0] && dstR2.cells[0][0].value;
  console.log(`   分表现状 A1=${JSON.stringify(r1a)} A2=${JSON.stringify(r2a)}`);
  if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(String(r2a || ''))) {
    throw new Error(`[step2] 分表 A2 已是日期(${r2a})，疑似已填过，为避免重复中止。请人工核查。`);
  }
  if (DRY_RUN) { console.log(`   [dry] 将在分表 row2 前插 ${n} 行并写入上述 ${n} 天（新→旧）`); }
  else {
    dimInsertBefore(DST_TOKEN, DST_SUBTAB, 2, n); sleep(500);
    for (let i = 0; i < n; i++) { setCells(DST_TOKEN, DST_SUBTAB, `A${2 + i}:L${2 + i}`, [rowCellsFromRendered(rendered[i])]); sleep(250); }
    console.log(`[step2] 已写入分表 ${n} 行。`);
  }

  // ── 步骤3：汇总 jv5kT4「日期 >= FROM」的数据行 C-H 公式追加 'Luma iOS TT' 项 ──
  console.log(`\n[step3] 汇总 ${SUM_SHEET} 追加 '${SUBTAB_NAME}' 求和项（仅日期 >= ${ymdToSlash(FROM)} 的行）`);
  const aCol = getValues(DST_TOKEN, SUM_SHEET, 'A2:A400', 'value');
  const sumRows = []; // { R, ymd }
  aCol.cells.forEach((r, idx) => {
    const v = r[0] && r[0].value;
    const ymd = slashToYmd(v);
    if (!ymd) return;
    const R = (aCol.row_indices && aCol.row_indices[idx] != null) ? aCol.row_indices[idx] : (2 + idx);
    if (daysBetweenStr(ymd, FROM) >= 0) sumRows.push({ R, ymd }); // 仅 ymd >= FROM
  });
  console.log(`   汇总待处理行（日期>=${ymdToSlash(FROM)}）：${sumRows.length} 行：${sumRows.map((x) => `row${x.R}(${x.ymd})`).join(', ')}`);
  const cols = Object.keys(SUM_TO_SUB); // C,D,E,F,G,H
  let touched = 0, skipped = 0;
  for (const { R } of sumRows) {
    const cur = getValues(DST_TOKEN, SUM_SHEET, `C${R}:H${R}`, 'formula');
    const cells = cur.cells[0];
    const newRow = cols.map((col, ci) => {
      const cell = cells[ci];
      const f = cell && cell.formula;
      if (!f || !f.startsWith('=')) return { skip: true, col };
      if (f.includes(`'${SUBTAB_NAME}'!`)) return { skip: true, col, already: true };
      return { formula: `${f}+'${SUBTAB_NAME}'!${SUM_TO_SUB[col]}${R}`, col };
    });
    if (!newRow.some((x) => x.formula)) { skipped++; continue; }
    if (DRY_RUN) {
      console.log(`   row${R}: ` + newRow.map((x) => x.formula ? `${x.col}+='${SUBTAB_NAME}'!${SUM_TO_SUB[x.col]}${R}` : `${x.col}(skip${x.already ? ':已含' : ''})`).join('  '));
      touched++; continue;
    }
    for (const x of newRow) {
      if (!x.formula) continue;
      setCells(DST_TOKEN, SUM_SHEET, `${x.col}${R}:${x.col}${R}`, [[{ formula: x.formula }]]);
      sleep(200);
    }
    touched++;
  }
  console.log(`[step3] ${DRY_RUN ? '将' : '已'}修改 ${touched} 行，跳过 ${skipped} 行。`);

  console.log(`\n[oneshot] ${DRY_RUN ? 'dry-run 完成，未写入。' : '全部完成。'}`);
}

main().catch((e) => { console.error('[oneshot] FATAL:', e.message); process.exit(1); });
