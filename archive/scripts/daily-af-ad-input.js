#!/usr/bin/env node
/**
 * 投放日报模板 - 「新版手动输入数据」sheet 每日自动填写
 *
 * 目标表: https://presence.feishu.cn/wiki/A2sfw2rnIiavmHkStErca2Wentg?sheet=Y64Qk0
 *   spreadsheet_token: N1FcsGvXThXu97t7ZYyccCHDnIg
 *   sheet_id:          Y64Qk0
 *
 * 逻辑(屹恒确认版):
 *   - 每天 08:10 在第3行前插入新行, 填昨天日期 + 各产品渠道付费金额总和
 *   - 数据源: 本地 AF/AD 数据库 (/home/admin/dataserver/data.db)
 *   - 第2行表头判断: 第3行(数据行)读到日期 == 昨天 → 跳过; == 前天 → 插行补昨天; 其它 → 警告不处理
 *
 * 列定义(已用 6/28 已填数据反推确认, 北京时间 event_time 口径):
 *   表头 row1=大类, row2=产品名
 *   A  日期
 *   --- AF FB (af_purchase, source='Facebook Ads') ---
 *   B  GC          C  Dora iOS      D (空)
 *   --- AF 非自然 (af_purchase, source != 'organic') ---
 *   E  GC   F Dora iOS  G Dora And  H Doni  I Romi iOS  J Jovia And  K Romi And  L Kira And  M Nalo And
 *   N (空)
 *   --- AD FB 不含w2a (ad_purchase, source IN FB三项, 排除 Facebook+web) ---
 *   O  Romi iOS    P  Luma          Q (空)
 *   --- AD 非自然 (ad_purchase, source != 'Organic') ---
 *   R  Romi iOS    S  Luma          T  Dora iOS
 *
 * 日期口径: 北京时间当天
 *   AF: date(event_time, '+8 hours')           (event_time = ISO UTC 文本)
 *   AD: date(datetime(event_time,'unixepoch'),'+8 hours')  (event_time = Unix 秒)
 *
 * 用法:
 *   node scripts/daily-af-ad-input.js            # 正常执行
 *   node scripts/daily-af-ad-input.js --dry-run  # 只算不写
 *   node scripts/daily-af-ad-input.js --date 2026-06-28   # 指定日期(调试用)
 */

const https = require('https');
const { execFileSync } = require('child_process');
const Database = require('/home/admin/.openclaw/workspace/dashboard/node_modules/better-sqlite3');

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/home/admin/.openclaw';

// 确保 lark-cli 可达（cron 精简 PATH 不含 .npm-global/bin）
process.env.PATH = `/home/admin/.npm-global/bin:${process.env.PATH || ''}`;

// ── Config ──
const SPREADSHEET_TOKEN = 'N1FcsGvXThXu97t7ZYyccCHDnIg';
const SHEET_ID = 'Y64Qk0';
const DB_PATH = '/home/admin/dataserver/data.db';

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_API = 'https://open.feishu.cn/open-apis';

const NOTIFY_OPEN_ID = 'ou_b2467dac5ff1d686fb48ccf1fbaa0c0d'; // 屹恒

const DRY_RUN = process.argv.includes('--dry-run');
const dateArgIdx = process.argv.indexOf('--date');
const FORCE_DATE = dateArgIdx >= 0 ? process.argv[dateArgIdx + 1] : null;

const NUM_COLS = 20; // A..T

// app_id 映射(同 dashboard server.js)
// AF 用带 id 前缀 / 安卓包名; AD(Adjust) 用纯数字 app_id
const AF_APP = {
  GC: 'id1658972379',
  'Dora iOS': 'id6746109957',
  'Dora And': 'com.doramatch.app',
  Doni: 'com.doni.appa',
  'Romi iOS': 'id6746782904',
  'Jovia And': 'com.qiga.vio',
  'Romi And': 'com.romiandroid.appmatch',
  'Kira And': 'com.meraki.kira',
  'Nalo And': 'com.cavalier.nalo',
};
const AD_APP = {
  'Romi iOS': '6746782904',
  Luma: '6746466099',
  'Dora iOS': '6746109957',
};

// AD FB 渠道(不含 w2a): Facebook+web 是 W2A 已排除
const AD_FB_SOURCES = ['Facebook+Installs', 'Instagram+Installs', 'Off-Facebook+Installs'];

// ── 列字母 <-> 索引 ──
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

// ── Feishu auth ──
async function getToken() {
  const res = await httpRequest('POST', `${FEISHU_API}/auth/v3/tenant_access_token/internal`,
    { app_id: APP_ID, app_secret: APP_SECRET });
  if (!res.tenant_access_token) throw new Error('Feishu token failed: ' + JSON.stringify(res));
  return res.tenant_access_token;
}

async function notify(token, text) {
  try {
    const url = `${FEISHU_API}/im/v1/messages?receive_id_type=open_id`;
    const body = { receive_id: NOTIFY_OPEN_ID, msg_type: 'text', content: JSON.stringify({ text }) };
    const res = await httpRequest('POST', url, body, { Authorization: `Bearer ${token}` });
    if (res.code !== 0) console.error('[notify] failed:', JSON.stringify(res));
  } catch (e) { console.error('[notify] error:', e.message); }
}

// ── Feishu sheet ops（用户身份 via lark-cli；应用对此表只有读权限，写需用户身份）──
function larkSleep(ms) { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); }

// lark-cli 调用 + 重试（飞书并发修订冲突会偶发 server_error）
function larkCli(args, input) {
  const MAX = 4;
  let lastErr;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      return execFileSync('lark-cli', args, {
        input: input != null ? input : undefined,
        env: { ...process.env, OPENCLAW_HOME },
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      });
    } catch (e) {
      lastErr = e;
      const msg = (e.stdout || '') + (e.stderr || '') + e.message;
      const retriable = /recommited|server_error|rev is|timeout|ECONN|429|rate|lock/i.test(msg);
      if (attempt < MAX && retriable) { larkSleep(800 * attempt); continue; }
      throw new Error(msg.trim() || e.message);
    }
  }
  throw lastErr;
}

// 读 A1:<lastCol>3，返回 2D values 数组（与旧 readRange 兼容）
async function readRange(token, range) {
  const out = larkCli([
    'sheets', '+cells-get',
    '--spreadsheet-token', SPREADSHEET_TOKEN,
    '--sheet-id', SHEET_ID,
    '--range', range,
    '--as', 'user',
    '--format', 'json',
  ]);
  const parsed = JSON.parse(out);
  if (!parsed.ok) throw new Error(`readRange ${range} failed: ${out}`);
  const cells = parsed.data.ranges[0].cells; // [[{value?},...],...]
  return cells.map(rowCells => rowCells.map(c => (c && c.value != null ? c.value : '')));
}

// 在 beforeRow 前插入一行，继承其后(原数据行)的货币格式
async function insertRow(token, beforeRow /* 1-based */) {
  const out = larkCli([
    'sheets', '+dim-insert',
    '--spreadsheet-token', SPREADSHEET_TOKEN,
    '--sheet-id', SHEET_ID,
    '--position', String(beforeRow),
    '--count', '1',
    '--inherit-style', 'before', // lark-cli: side=before → 在 position 之前插入(新行成为第3行) + 继承前行(表头 row2 同为 $货币格式)。
    // ⚠ 注意：after 会在 position 之后插入导致数据错位，勿改。
    '--as', 'user',
    '--format', 'json',
  ]);
  const parsed = JSON.parse(out);
  if (!parsed.ok) throw new Error(`insertRow @${beforeRow} failed: ${out}`);
  return parsed;
}

// 写 range（A3:T3），values 是 [[...]]，转成 cells-set 的 [[{value}]] 结构
async function writeRange(token, range, values) {
  const cells = values.map(row => row.map(v => (v === '' ? {} : { value: v })));
  const out = larkCli([
    'sheets', '+cells-set',
    '--spreadsheet-token', SPREADSHEET_TOKEN,
    '--sheet-id', SHEET_ID,
    '--range', range,
    '--as', 'user',
    '--format', 'json',
    '--cells', '-',
  ], JSON.stringify(cells));
  const parsed = JSON.parse(out);
  if (!parsed.ok) throw new Error(`writeRange ${range} failed: ${out}`);
  return parsed;
}

// ── 日期工具 ──
function beijingNow() { return new Date(Date.now() + 8 * 3600 * 1000); }
function fmtISO(d) { // Date(UTC repr of Beijing) → "2026-06-28"
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function fmtDisplay(iso) { // "2026-06-28" → "2026/6/28"
  const [y, m, d] = iso.split('-').map(Number);
  return `${y}/${m}/${d}`;
}
function yesterdayISO() {
  if (FORCE_DATE) return FORCE_DATE;
  const d = beijingNow(); d.setUTCDate(d.getUTCDate() - 1); return fmtISO(d);
}
function dayBeforeISO() {
  const d = FORCE_DATE ? new Date(FORCE_DATE + 'T00:00:00Z') : beijingNow();
  if (!FORCE_DATE) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return fmtISO(d);
}
// 归一化日期字符串: "2026/06/28" / "2026/6/28" / "2026-6-28" / 序列号 → "2026/6/28"
function normDate(s) {
  if (s == null) return '';
  const str = String(s).trim();
  if (/^\d+(\.0+)?$/.test(str)) {
    const n = parseInt(str, 10);
    if (n > 30000 && n < 80000) {
      const ms = (n - 25569) * 86400 * 1000;
      const d = new Date(ms);
      return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    }
  }
  const m = str.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return str;
  return `${parseInt(m[1])}/${parseInt(m[2])}/${parseInt(m[3])}`;
}

// ── DB 查询 ──
function round2(v) { return Math.round((v || 0) * 100) / 100; }

function queryData(dateISO) {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const ym = dateISO.slice(0, 4) + dateISO.slice(5, 7); // 跨月需注意, 但每天查昨天单天, 单表足够
    const TABLE = `records_${ym}`;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
    if (!tables) throw new Error(`表 ${TABLE} 不存在`);

    // AF: 单 app + 单天(北京) + source 条件 的付费金额总和
    const afStmt = (cond) => db.prepare(
      `SELECT COALESCE(SUM(revenue),0) AS rev FROM ${TABLE}
       WHERE event_name='af_purchase' AND app_id=? AND date(event_time,'+8 hours')=? ${cond}`
    );
    const afFB = afStmt("AND source='Facebook Ads'");
    const afNonOrganic = afStmt("AND source!='organic'");

    // AD: event_time 是 Unix 秒
    const adNonOrganic = db.prepare(
      `SELECT COALESCE(SUM(revenue),0) AS rev FROM ${TABLE}
       WHERE event_name='ad_purchase' AND app_id=?
         AND date(datetime(CAST(event_time AS INTEGER),'unixepoch'),'+8 hours')=? AND source!='Organic'`
    );
    const adFBPlaceholders = AD_FB_SOURCES.map(() => '?').join(',');
    const adFB = db.prepare(
      `SELECT COALESCE(SUM(revenue),0) AS rev FROM ${TABLE}
       WHERE event_name='ad_purchase' AND app_id=?
         AND date(datetime(CAST(event_time AS INTEGER),'unixepoch'),'+8 hours')=?
         AND source IN (${adFBPlaceholders})`
    );

    const getAF = (stmt, app) => round2(stmt.get(AF_APP[app], dateISO).rev);
    const getAD_nonorg = (app) => round2(adNonOrganic.get(AD_APP[app], dateISO).rev);
    const getAD_fb = (app) => round2(adFB.get(AD_APP[app], dateISO, ...AD_FB_SOURCES).rev);

    return {
      // AF FB
      afFB_GC: getAF(afFB, 'GC'),
      afFB_DoraiOS: getAF(afFB, 'Dora iOS'),
      // AF 非自然
      afNon_GC: getAF(afNonOrganic, 'GC'),
      afNon_DoraiOS: getAF(afNonOrganic, 'Dora iOS'),
      afNon_DoraAnd: getAF(afNonOrganic, 'Dora And'),
      afNon_Doni: getAF(afNonOrganic, 'Doni'),
      afNon_RomiiOS: getAF(afNonOrganic, 'Romi iOS'),
      afNon_Jovia: getAF(afNonOrganic, 'Jovia And'),
      afNon_RomiAnd: getAF(afNonOrganic, 'Romi And'),
      afNon_KiraAnd: getAF(afNonOrganic, 'Kira And'),
      afNon_Nalo: getAF(afNonOrganic, 'Nalo And'),
      // AD FB 不含 w2a
      adFB_RomiiOS: getAD_fb('Romi iOS'),
      adFB_Luma: getAD_fb('Luma'),
      // AD 非自然
      adNon_RomiiOS: getAD_nonorg('Romi iOS'),
      adNon_Luma: getAD_nonorg('Luma'),
      adNon_DoraiOS: getAD_nonorg('Dora iOS'),
    };
  } finally {
    db.close();
  }
}

// 把数据对象 → 行数组(A..T, 索引 0..19)
function buildRow(dateDisp, d) {
  const row = new Array(NUM_COLS).fill('');
  row[0] = dateDisp;             // A 日期
  // AF FB
  row[1] = d.afFB_GC;           // B GC
  row[2] = d.afFB_DoraiOS;      // C Dora iOS
  // D 空
  // AF 非自然
  row[4] = d.afNon_GC;          // E GC
  row[5] = d.afNon_DoraiOS;     // F Dora iOS
  row[6] = d.afNon_DoraAnd;     // G Dora And
  row[7] = d.afNon_Doni;        // H Doni
  row[8] = d.afNon_RomiiOS;     // I Romi iOS
  row[9] = d.afNon_Jovia;       // J Jovia And
  row[10] = d.afNon_RomiAnd;    // K Romi And
  row[11] = d.afNon_KiraAnd;    // L Kira And
  row[12] = d.afNon_Nalo;       // M Nalo And
  // N 空
  // AD FB 不含 w2a
  row[14] = d.adFB_RomiiOS;     // O Romi iOS
  row[15] = d.adFB_Luma;        // P Luma
  // Q 空
  // AD 非自然
  row[17] = d.adNon_RomiiOS;    // R Romi iOS
  row[18] = d.adNon_Luma;       // S Luma
  row[19] = d.adNon_DoraiOS;    // T Dora iOS
  return row;
}

// ── Main ──
async function main() {
  const Y_ISO = yesterdayISO();
  const DB_ISO = dayBeforeISO();
  const Y_DISP = fmtDisplay(Y_ISO);
  const DB_DISP = fmtDisplay(DB_ISO);
  console.log(`[AF/AD Input] ${DRY_RUN ? '*** DRY-RUN ***' : 'LIVE'} | 昨天=${Y_DISP} 前天=${DB_DISP}`);

  const token = await getToken();
  const lastCol = idxToCol(NUM_COLS - 1); // T

  // 读第3行(数据首行)判断日期
  const head = await readRange(token, `A1:${lastCol}3`);
  const row3 = head[2] || [];
  const date3 = normDate(row3[0]);

  if (date3 === Y_DISP) {
    console.log(`  ✅ 第3行已是昨天(${Y_DISP}),跳过`);
    return;
  }
  if (date3 !== DB_DISP) {
    const msg = `⚠️ AF/AD输入: 第3行日期=${date3 || '(空)'},既不是昨天(${Y_DISP})也不是前天(${DB_DISP}),需手动处理`;
    console.log('  ' + msg);
    if (!DRY_RUN) await notify(token, msg);
    return;
  }

  // 查 DB
  console.log(`  ↪ 第3行=前天(${DB_DISP}),查询 ${Y_ISO} 数据并插入新行`);
  const data = queryData(Y_ISO);
  const row = buildRow(Y_DISP, data);

  // 打印对账
  console.log('  数据明细:');
  console.log(`    [AF FB]      GC=${data.afFB_GC}  DoraiOS=${data.afFB_DoraiOS}`);
  console.log(`    [AF 非自然]  GC=${data.afNon_GC} DoraiOS=${data.afNon_DoraiOS} DoraAnd=${data.afNon_DoraAnd} Doni=${data.afNon_Doni} RomiiOS=${data.afNon_RomiiOS} Jovia=${data.afNon_Jovia} RomiAnd=${data.afNon_RomiAnd} KiraAnd=${data.afNon_KiraAnd} Nalo=${data.afNon_Nalo}`);
  console.log(`    [AD FB]      RomiiOS=${data.adFB_RomiiOS} Luma=${data.adFB_Luma}`);
  console.log(`    [AD 非自然]  RomiiOS=${data.adNon_RomiiOS} Luma=${data.adNon_Luma} DoraiOS=${data.adNon_DoraiOS}`);

  if (DRY_RUN) {
    console.log('  [dry-run] 将 insert 第3行 + 写 A3:' + lastCol + '3');
    return;
  }

  // 插入新行(第3行前) → 旧第3行下移到第4行, 新行继承数据行格式($货币)
  await insertRow(token, 3);
  // 写入新第3行(原始数字, 货币格式自动显示 $)
  await writeRange(token, `A3:${lastCol}3`, [row]);
  console.log(`  ✓ 已写入新第3行 (${Y_DISP})`);
}

main().catch(async (e) => {
  console.error('[AF/AD Input] FATAL:', e.message);
  try {
    const t = await getToken();
    await notify(t, `❌ AF/AD日报输入失败 · ${fmtDisplay(yesterdayISO())}\n错误：${e.message}`);
  } catch (_) {}
  process.exit(1);
});
