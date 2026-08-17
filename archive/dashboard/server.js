const express = require('express');
const compression = require('compression');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const https = require('https');
const sqlite3 = require('better-sqlite3');
const fetcher = require('./fetcher');
const creativeModule = require('./fetch-creative-data');
const { apiGuard } = require('./api-guard');
const config = require('./config');
const dbPg = require('./db');

// ── XMP Open API ──────────────────────────────────────────────
// 敏感信息一律从环境变量读取（见 config.js），禁止硬编码。
const XMP_CLIENT_ID = config.xmp.clientId;
const XMP_CLIENT_SECRET = config.xmp.clientSecret;
const XMP_API_HOST = config.xmp.apiHost;

const XMP_PRODUCT_MAP = {
  'Romi: Make Friends, Have Fun': 'Romi iOS',
  'Dora: Create and connect': 'Dora iOS',
  'Dora: Find Real Companionship': 'Dora And',
  'Doni: Easy Connection': 'Doni',
  'Luma: Make Friends, Have Fun': 'Luma',
  'Jovia: Find Real Love': 'Jovia And',
  'Romi: Swipe, Chat & Connect': 'Romi And',
  'GraceChat': 'GraceChat',
  'Kira: Creative Community': 'Kira iOS',
  'Kira: Find Your Romance': 'Kira And',
  'Nalo: Meet, Swipe & Chat': 'Nalo And',
};

const XMP_CHANNEL_SHORT = { facebook: 'FB', google: 'GG', tiktok: 'TT' };
const XMP_CHANNELS = ['facebook', 'google', 'tiktok'];

function xmpSign() {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash('md5').update(XMP_CLIENT_SECRET + timestamp).digest('hex');
  return { timestamp, sign };
}

function xmpApiRequest(body) {
  return xmpApiRequestPath('/v2/media/account/report', body);
}

// Generic XMP Open API POST helper — arbitrary endpoint path, body, optional headers.
// Powers the /api/ext/xmp-* passthrough endpoints so the full XMP surface is reachable.
const XMP_REQ_TIMEOUT = 30 * 1000; // 30s hard timeout — prevents a hung upstream response from permanently blocking the event loop
function xmpApiRequestPath(apiPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, extraHeaders || {});
    let settled = false;
    const req = https.request({ hostname: XMP_API_HOST, path: apiPath, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { if (settled) return; settled = true; try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('XMP non-JSON response: ' + data.slice(0,200))); } });
    });
    req.on('error', (e) => { if (settled) return; settled = true; reject(e); });
    // Guard against a connected-but-silent upstream (no response / half-open socket):
    // without this the Promise never settles and blocks every awaiting handler.
    req.setTimeout(XMP_REQ_TIMEOUT, () => {
      req.destroy(new Error('XMP request timeout after ' + XMP_REQ_TIMEOUT + 'ms: ' + apiPath));
    });
    req.write(payload);
    req.end();
  });
}

// XMP campaign data cache: { key: { data, fetchedAt, complete } }
// Persisted to disk so restarts don't lose cache
const XMP_CACHE_TTL = 30 * 60 * 1000; // 30 min (complete)
const XMP_CACHE_TTL_SHORT = 5 * 60 * 1000; // 5 min (incomplete)
const XMP_CACHE_DIR = path.join(__dirname, 'data', 'xmp-cache');
if (!fs.existsSync(XMP_CACHE_DIR)) fs.mkdirSync(XMP_CACHE_DIR, { recursive: true });

function xmpCachePath(cacheKey) {
  return path.join(XMP_CACHE_DIR, cacheKey + '.json');
}

function loadXmpCache(cacheKey) {
  try {
    const data = JSON.parse(fs.readFileSync(xmpCachePath(cacheKey), 'utf8'));
    return data;
  } catch (e) { return null; }
}

function saveXmpCache(cacheKey, entry) {
  fs.writeFileSync(xmpCachePath(cacheKey), JSON.stringify(entry));
}

// Clean up old XMP cache files (keep only last 3 days)
function cleanXmpCache() {
  try {
    const files = fs.readdirSync(XMP_CACHE_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(XMP_CACHE_DIR, f);
      try {
        const stat = fs.statSync(fp);
        // Remove files older than 3 days
        if (now - stat.mtimeMs > 3 * 24 * 3600 * 1000) {
          fs.unlinkSync(fp);
        }
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}
// Clean on startup and every 6 hours
cleanXmpCache();
setInterval(cleanXmpCache, 6 * 3600 * 1000);

// In-memory mirror (avoids repeated disk reads within same process)
const xmpCacheMem = {};

function getXmpCacheEntry(cacheKey) {
  // Check memory first
  if (xmpCacheMem[cacheKey]) return xmpCacheMem[cacheKey];
  // Then disk
  const disk = loadXmpCache(cacheKey);
  if (disk) { xmpCacheMem[cacheKey] = disk; return disk; }
  return null;
}

function setXmpCacheEntry(cacheKey, entry) {
  xmpCacheMem[cacheKey] = entry;
  saveXmpCache(cacheKey, entry);
}

// ── Multi-day aggregation result cache ─────────────────────────
// Caches the fully-computed response for a date RANGE (af-summary / channel-
// summary / data multi-day) so repeated dashboard loads of the same range don't
// re-run the heavy SQLite scans over the large monthly tables. Those synchronous
// scans block the single Node thread; on parallel/repeated loads they pile up →
// upstream proxy 502. The cached value is byte-identical to the uncached path
// (we cache the exact computed object); the only new property is bounded
// staleness:
//   • fully-historical ranges (endDate < today, settled data): long TTL
//   • ranges that include today (live data): short TTL, just long enough to
//     absorb the burst of parallel/refresh requests a single page load fires.
// In-memory only — resets on restart (desirable: a fresh restart after an XMP
// backfill or snapshot rebuild starts from clean, correct data).
const RANGE_CACHE_TTL_LIVE = 60 * 1000;        // ranges including today
const RANGE_CACHE_TTL_HIST = 6 * 3600 * 1000;  // settled historical ranges
const _rangeResultCache = new Map(); // key -> { value, fp, expiresAt }

// Fingerprint of the XMP disk cache over a range — busts channel-summary cache
// when XMP data for any date in the range is (re)fetched/backfilled.
function xmpRangeFingerprint(startDate, endDate) {
  let fp = '';
  for (const d of getDateRange(startDate, endDate)) {
    try {
      const st = fs.statSync(xmpCachePath(`xmp-campaigns-${d}`));
      fp += st.mtimeMs + ',';
    } catch (e) { fp += '0,'; }
  }
  return fp;
}

// TTL for a range: short if it includes today (live), long if fully historical.
function rangeCacheTtl(endDate) {
  return endDate < todayBeijing() ? RANGE_CACHE_TTL_HIST : RANGE_CACHE_TTL_LIVE;
}

function getRangeCache(key, fp) {
  const e = _rangeResultCache.get(key);
  if (e && e.expiresAt > Date.now() && e.fp === fp) return e.value;
  return null;
}

function setRangeCache(key, value, fp, ttl) {
  _rangeResultCache.set(key, { value, fp, expiresAt: Date.now() + ttl });
  if (_rangeResultCache.size > 300) {
    // Evict oldest inserted entry to bound memory.
    const first = _rangeResultCache.keys().next().value;
    if (first !== undefined) _rangeResultCache.delete(first);
  }
}

async function fetchXmpCampaigns(date, { staleOk = false, needAdset = false } = {}) {
  // XMP API data timezone is Beijing (UTC+8), pass Beijing date directly
  // If 00:00-08:00 Beijing time, the API may reject (date > UTC today) — that's OK, will return empty
  const cacheKey = `xmp-campaigns-${date}`;
  const cached = getXmpCacheEntry(cacheKey);
  // Schema guard (personal panel only, via needAdset): caches written before the
  // `adset` dimension was added lack the `adset` field on every row. Such data can
  // never join onto adset nodes (every row falls to the campaign's '(unknown)'
  // adset → 100% unmatched), so treat it as a miss and fall through to a fresh
  // fetch that includes adset_name. Without this, a stale in-memory/disk cache
  // silently pins adset matching at 0%. Channel-summary and other cost-only callers
  // leave needAdset=false and keep using adset-less caches unchanged.
  const cachedHasAdset = cached && Array.isArray(cached.data) &&
    (cached.data.length === 0 || cached.data.some(r => r && 'adset' in r));
  const forceRefetch = needAdset && cached && !cachedHasAdset;
  if (forceRefetch) {
    console.log(`[XMP API] Cached ${date} predates adset dimension — forcing refetch`);
  } else {
    if (cached && cached.complete && (Date.now() - cached.fetchedAt) < XMP_CACHE_TTL) {
      return cached.data;
    }
    // Incomplete cache: only use for 5 minutes
    if (cached && !cached.complete && (Date.now() - cached.fetchedAt) < XMP_CACHE_TTL_SHORT) {
      return cached.data;
    }
    // If staleOk and we have ANY cached data, return it immediately
    // (avoids blocking the request for minutes when XMP API is slow/rate-limited)
    if (staleOk && cached && cached.data && cached.data.length > 0) {
      console.log(`[XMP API] Returning stale cache for ${date} (age ${Math.round((Date.now() - cached.fetchedAt) / 60000)} min)`);
      return cached.data;
    }
  }

  const allRows = [];
  let allChannelsOk = true;
  for (const channel of XMP_CHANNELS) {
    let page = 1;
    let channelOk = false;
    while (true) {
      const { timestamp, sign } = xmpSign();
      let resp;
      try {
        resp = await xmpApiRequest({
          client_id: XMP_CLIENT_ID, timestamp, sign,
          start_date: date, end_date: date,
          dimension: ['campaign_name', 'adset_name', 'product_name'],
          module: channel,
          metrics: ['cost', 'impression', 'click'],
          currency: 'USD',
          page, page_size: 1000,
        });
      } catch (err) {
        console.error(`[XMP API] ${channel} request error: ${err.message}`);
        allChannelsOk = false;
        break;
      }
      if (resp.code !== 0) {
        console.error(`[XMP API] ${channel} error: ${resp.msg}`);
        allChannelsOk = false;
        break;
      }
      if (!resp.data || !resp.data.list || resp.data.list.length === 0) {
        channelOk = true;
        break;
      }
      channelOk = true;
      for (const row of resp.data.list) {
        if (row.cost > 0 && row.product_name) {
          allRows.push({
            product: XMP_PRODUCT_MAP[row.product_name] || row.product_name,
            campaign: (row.campaign_name || '').trim(),
            adset: (row.adset_name || '').trim(),
            channel: XMP_CHANNEL_SHORT[channel] || channel,
            cost: row.cost,
            impressions: row.impression || 0,
            clicks: row.click || 0,
          });
        }
      }
      page++;
      if (page > 50) break;
    }
    if (!channelOk) allChannelsOk = false;
  }

  // Only cache if all three channels (FB/GG/TT) have actual spend data
  const channelsWithCost = new Set(allRows.map(r => r.channel));
  const allChannelsHaveData = ['FB', 'GG', 'TT'].every(ch => channelsWithCost.has(ch));
  if (allChannelsOk && allChannelsHaveData) {
    setXmpCacheEntry(cacheKey, { data: allRows, fetchedAt: Date.now(), complete: true });
  } else if (allRows.length > 0 && !allChannelsHaveData) {
    // Cache partial data briefly (5 min) so we don't hammer the API
    setXmpCacheEntry(cacheKey, { data: allRows, fetchedAt: Date.now(), complete: false });
  }
  // Adset-schema forced refetch that came back empty (e.g. the XMP API no longer
  // serves this far-back date): fall back to the adset-less cached data so we keep
  // correct campaign-level cost rather than dropping it. Adset stays unmatched, but
  // conservation and campaign totals are preserved.
  if (forceRefetch && allRows.length === 0 && cached && cached.data && cached.data.length > 0) {
    console.log(`[XMP API] Forced refetch for ${date} returned no rows — falling back to cached (adset-less) cost`);
    return cached.data;
  }
  console.log(`[XMP API] Fetched ${allRows.length} campaigns for ${date} (complete: ${allChannelsOk})`);
  return allRows;
}

const app = express();
const PORT = config.port;

// ── Postback DB (dataserver) ──────────────────────────────────
// 生产已切换到 PostgreSQL（见 db.js / config.js）。此路径仅在设置了
// POSTBACK_DB_PATH 时用于本地 SQLite 兼容读取；不再硬编码线上绝对路径。
const POSTBACK_DB_PATH = process.env.POSTBACK_DB_PATH
  ? path.resolve(process.env.POSTBACK_DB_PATH)
  : '';

const APP_ID_MAP = {
  'com.doramatch.app': 'Dora And',
  'id6746109957': 'Dora iOS',
  'id6746782904': 'Romi iOS',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  'id1658972379': 'GraceChat',
  'id6759697686': 'Kira iOS',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
  // Adjust uses numeric app_id without 'id' prefix
  '6746109957': 'Dora iOS',
  '6746782904': 'Romi iOS',
  '1658972379': 'GraceChat',
  '6759697686': 'Kira iOS',
  '6746466099': 'Luma',
  'com.circleconnect.dora': 'Dora iOS',
  'com.chatsbridgeconnect.romi': 'Romi iOS',
  'com.odyssey.luma': 'Luma',
  'id6746466099': 'Luma',
};

// Test/unknown app_ids to exclude from postback display
const EXCLUDED_APP_IDS = new Set(['id123']);

const MEDIA_SOURCE_MAP = {
  // FB
  'Facebook Ads': 'FB',
  'Facebook+Installs': 'FB',
  'Facebook Installs': 'FB',
  'Instagram+Installs': 'FB',
  'Instagram Installs': 'FB',
  'Off-Facebook+Installs': 'FB',
  'Social_facebook': 'FB',
  'facebook': 'FB',
  // FB W2A (含 W2A 或 web/Web 字样)
  'Facebook+web': 'FB W2A',
  'Facebook web': 'FB W2A',
  // GG
  'googleadwords_int': 'GG',
  'Google Ads ACI': 'GG',
  'Google+Ads+ACI': 'GG',
  // TT
  'tiktokglobal_int': 'TT',
  'TikTok+SAN': 'TT',
  'TikTok SAN': 'TT',
  // 自然量
  'organic': 'Organic',
  'Organic': 'Organic',
  'restricted': 'Organic',
  'Unattributed': 'Organic',
  'Untrusted Devices': 'Organic',
};

// 动态判断：名字含 W2A 或 Web/web 的归为 FB W2A
function mapMediaSource(src) {
  if (!src) return 'Unknown';
  if (MEDIA_SOURCE_MAP[src]) return MEDIA_SOURCE_MAP[src];
  const s = src.toLowerCase();
  if (s.includes('w2a') || s.includes('web')) return 'FB W2A';
  return src;
}

function getPostbackDb() {
  const db = new sqlite3(POSTBACK_DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  // Performance PRAGMAs: multi-day/cross-month aggregation scans large monthly
  // tables (records_YYYYMM, ~1M rows). mmap + a large page cache keep repeated
  // scans within a request memory-bound instead of disk-bound; temp_store=MEMORY
  // keeps GROUP BY sorts off disk. Read-only, so these never affect results.
  db.pragma('busy_timeout = 5000');
  db.pragma('mmap_size = 3221225472'); // 3 GiB
  db.pragma('cache_size = -262144');   // 256 MiB page cache (per connection)
  db.pragma('temp_store = MEMORY');
  return db;
}

function getPostbackTables() {
  const db = getPostbackDb();
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' ORDER BY name").all();
    return rows.map(r => r.name);
  } finally {
    db.close();
  }
}

// Ensure every monthly table has the composite indexes the aggregation queries
// rely on. New months are created by the dataserver without these indexes, which
// silently makes multi-day/cross-month queries fall back to full scans. We add
// them here at dashboard startup (idempotent via IF NOT EXISTS) so a new month
// never re-introduces the "missing index" performance cliff. Best-effort: a
// brief writable connection, fully guarded — any failure just logs and is
// skipped (read-only queries keep working regardless).
function ensureMonthlyIndexes() {
  // (suffix, columns) for the 7 core composite indexes — matches the DDL
  // template already applied to the existing monthly tables.
  const INDEX_SPECS = [
    ['evt_time_range', '(event_name, event_time)'],
    ['evt_inst_range', '(event_name, install_time)'],
    ['evt_app_time', '(event_name, app_id, event_time)'],
    ['evt_app_camp', '(event_name, app_id, campaign)'],
    ['evt_app_ms', '(event_name, app_id, media_source)'],
    ['camp_evt_time', '(campaign, event_time)'],
    ['campaign', '(campaign)'],
  ];
  let db;
  try {
    db = new sqlite3(POSTBACK_DB_PATH, { readonly: false, fileMustExist: true });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%'").all().map(r => r.name);
    let created = 0;
    for (const tbl of tables) {
      const ym = tbl.replace('records_', '');
      for (const [suffix, cols] of INDEX_SPECS) {
        const idxName = `idx_records_${ym}_${suffix}`;
        try {
          const before = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(idxName);
          if (before) continue;
          db.exec(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${tbl}${cols}`);
          created++;
          console.log(`[Index] Created ${idxName}`);
        } catch (e) {
          console.error(`[Index] Failed ${idxName}: ${e.message}`);
        }
      }
    }
    if (created === 0) console.log(`[Index] All monthly tables already indexed (${tables.length} tables checked)`);
  } catch (e) {
    console.error('[Index] ensureMonthlyIndexes skipped:', e.message);
  } finally {
    if (db) { try { db.close(); } catch (_) {} }
  }
}

function tableForMonth(dateStr) {
  // dateStr: YYYY-MM-DD → records_YYYYMM
  return 'records_' + dateStr.slice(0, 4) + dateStr.slice(5, 7);
}

// Sargable Beijing-calendar-day bounds for a YYYY-MM-DD date.
// Replaces the non-sargable `date(event_time, '+8 hours') = ?` predicate — that
// wraps the column in a function so SQLite can only narrow by event_name and then
// scans every row. Range predicates on the raw column instead hit the composite
// (event_name, event_time) / (event_name, install_time) indexes as a range scan.
// af_* rows store timestamps as UTC datetime strings ('YYYY-MM-DD HH:MM:SS.sss');
// that format compares lexicographically == chronologically, so string bounds are
// an exact range. ad_* rows store them as unix epoch seconds → numeric bounds.
// A Beijing day [00:00,24:00) is [midnight-8h, midnight+16h) in UTC.
function beijingDayBounds(dateStr) {
  const loMs = Date.parse(dateStr + 'T00:00:00+08:00'); // ms epoch of Beijing 00:00
  const hiMs = loMs + 86400000;
  const fmt = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return {
    strLo: fmt(loMs), strHi: fmt(hiMs),                          // af_* UTC-string bounds
    epLo: Math.floor(loMs / 1000), epHi: Math.floor(hiMs / 1000), // ad_* epoch-second bounds
  };
}

const ADMIN_USER = config.adminUser;
const ADMIN_PASS = config.adminPass;

app.use(compression());
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Extract the API password from a request, supporting either:
//   - query param  ?key=<password>   (simplest: paste a full URL and it works)
//   - header        Authorization: Bearer <password>   (more conventional)
// Returns the provided secret string, or null if none present.
function extApiSecret(req) {
  if (req.query && typeof req.query.key === 'string' && req.query.key) return req.query.key;
  const auth = req.headers && req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

// Constant-time-ish equality to avoid trivial timing leaks on the shared password.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (e) { return false; }
}

function authCheck(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  // Machine-to-machine access: accept the shared dashboard password via
  // ?key= or Authorization: Bearer. Same password as the login form, so anyone
  // holding it already has full dashboard access. Enables external agents to
  // fetch data by URL/token without a browser session.
  const secret = extApiSecret(req);
  if (secret && safeEqual(secret, ADMIN_PASS)) {
    // 【总闸】对外机器取数 API 已临时关闭：即使 key 正确，M2M（?key=/Bearer）一律 503。
    // 只保留网页端 session 认证访问。背景：8081 裸奔公网被外部 agent 代理池刷爆，
    // 且 /api/ext/* 走本 authCheck 会绕过 apiGuard 的 M2M 闸，故在认证源头统一拦截。
    // 重新开放：设 GUARD_BLOCK_M2M=0 并重启。
    if ((process.env.GUARD_BLOCK_M2M || '1') === '1') {
      console.warn(`[Auth] M2M API disabled: reject ${req.method} ${req.originalUrl.split('?')[0]} from ${req.ip}`);
      res.set('Retry-After', '86400');
      return res.status(503).json({
        ok: false,
        error: 'External machine data-pull API is temporarily disabled. Only the web dashboard is available right now.',
        hint: 'Contact the dashboard owner if you need programmatic access.',
      });
    }
    if (req.path && (req.path.startsWith('/api/ext/') || req.query.key || (req.headers && req.headers['authorization']))) {
      console.log(`[Ext] ${req.method} ${req.originalUrl.split('?')[0]} from ${req.ip}`);
    }
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>登录 - Sitin 仪表板</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a1a; color: #e0e0f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .login-box { background: #12122a; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 40px; width: 360px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    h1 { font-size: 1.4rem; margin-bottom: 24px; text-align: center; color: #8888cc; }
    label { display: block; font-size: 0.85rem; color: #8888aa; margin-bottom: 6px; }
    input { width: 100%; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; background: #0a0a1a; color: #e0e0f0; font-size: 0.95rem; margin-bottom: 16px; outline: none; }
    input:focus { border-color: #00d4ff; }
    button { width: 100%; padding: 10px; border: none; border-radius: 6px; background: #00d4ff; color: #0a0a1a; font-size: 1rem; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
    button:hover { opacity: 0.85; }
    .error { color: #ff4444; font-size: 0.85rem; text-align: center; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>📊 Sitin 仪表板</h1>
    ${req.query.error ? '<div class="error">用户名或密码错误</div>' : ''}
    <form method="POST" action="/login">
      <label for="username">用户名</label>
      <input type="text" id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">密码</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      <button type="submit">登录</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Panel access verification (secondary menu unlock)
app.post('/api/panel-access', authCheck, (req, res) => {
  const { code } = req.body;
  if (code === '47251') {
    req.session.panelAccess = true;
    return res.json({ ok: true });
  }
  return res.status(403).json({ ok: false, error: '密码错误' });
});

app.get('/api/panel-access', authCheck, (req, res) => {
  res.json({ unlocked: !!(req.session && req.session.panelAccess) });
});

app.use((req, res, next) => {
  if (req.path.match(/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|skill)$/)) return next();
  return authCheck(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

// API 保护中间件：对重接口施加 日期跨度护栏 + 每IP限频 + 全局并发闸，
// 防止外部 agent 用大范围/高并发请求打爆单线程事件循环。挂在鉴权之后。
app.use(apiGuard);

// ── Correction factors ────────────────────────────────────────
// factor = yesterday_athena / yesterday_paid_revenue * 0.95
// Android: simple (all non-organic AF revenue)
// iOS: FB channel gets extra fixed multiplier, non-FB gets base factor
const ANDROID_APP_IDS = {
  'com.doramatch.app': 'Dora And',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
};

const IOS_AF_APP_IDS = {
  'id6746109957': 'Dora iOS',
  'id6746782904': 'Romi iOS',
  'id6746466099': 'Luma',
  'id1658972379': 'GraceChat',
};

const IOS_AD_APP_IDS = {
  '6746109957': 'Dora iOS',
  '6746782904': 'Romi iOS',
  '6746466099': 'Luma',
  '1658972379': 'GraceChat',
};

const IOS_FB_FIXED = {
  'GraceChat': 2.0,
  'Dora iOS': 1.4,
  'Romi iOS': 1.4,
  'Luma': 1.35,
};

// ── Date range helpers ────────────────────────────────────────
// Generate array of date strings from startDate to endDate (inclusive)
function getDateRange(startDate, endDate) {
  const dates = [];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const d = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  while (d <= end) {
    dates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// Find all monthly table names covering a date range
function getTablesForRange(startDate, endDate) {
  const tables = new Set();
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const d = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  while (d <= end) {
    const ym = d.getFullYear().toString() + String(d.getMonth() + 1).padStart(2, '0');
    tables.add('records_' + ym);
    d.setDate(d.getDate() + 1);
  }
  return [...tables];
}

// Compute correction factors for all products given a date and an open DB connection
// Returns { product: number | { fb: number, other: number } }
function computeCorrectionFactorsSync(dataDate, db) {
  const factors = {};
  const dayData = fetcher.loadDayData(dataDate);
  const lastSnap = dayData.snapshots && dayData.snapshots[dayData.snapshots.length - 1];
  const athenaMap = {};
  if (lastSnap && lastSnap.athena) {
    for (const item of lastSnap.athena) {
      athenaMap[item.product] = item.totalRevenue || 0;
    }
  }
  const tableName = tableForMonth(dataDate);
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  if (!tableExists) {
    for (const p of [...Object.values(ANDROID_APP_IDS), ...Object.values(IOS_AF_APP_IDS)]) factors[p] = 1;
    return factors;
  }
  // UTC range for Beijing date
  const [cy, cm, cd] = dataDate.split('-').map(Number);
  const _utcS = new Date(Date.UTC(cy, cm - 1, cd) - 8 * 3600 * 1000);
  const _utcE = new Date(Date.UTC(cy, cm - 1, cd + 1) - 8 * 3600 * 1000);
  const _pad = n => String(n).padStart(2, '0');
  const _fmt = dt => `${dt.getUTCFullYear()}-${_pad(dt.getUTCMonth()+1)}-${_pad(dt.getUTCDate())} ${_pad(dt.getUTCHours())}:${_pad(dt.getUTCMinutes())}:${_pad(dt.getUTCSeconds())}`;
  const evtStart = _fmt(_utcS);
  const evtEnd = _fmt(_utcE);
  const tsStart = Math.floor(_utcS.getTime() / 1000);
  const tsEnd = Math.floor(_utcE.getTime() / 1000);
  // Android: athena / af_non_organic * 0.95
  const androidIds = Object.keys(ANDROID_APP_IDS);
  if (androidIds.length > 0) {
    const rows = db.prepare(`
      SELECT app_id, ROUND(SUM(revenue), 4) as rev
      FROM ${tableName}
      WHERE event_name='af_purchase'
        AND event_time >= ? AND event_time < ?
        AND media_source != 'organic'
        AND app_id IN (${androidIds.map(() => '?').join(',')})
      GROUP BY app_id
    `).all(evtStart, evtEnd, ...androidIds);
    for (const row of rows) {
      const product = ANDROID_APP_IDS[row.app_id];
      const athenaRev = athenaMap[product] || 0;
      if (row.rev > 0 && athenaRev > 0) {
        factors[product] = Math.round(athenaRev / row.rev * 0.95 * 10000) / 10000;
      }
    }
  }
  for (const p of Object.values(ANDROID_APP_IDS)) { if (factors[p] == null) factors[p] = 1; }
  // iOS: FB fixed multiplier then base factor
  const iosAfIds = Object.keys(IOS_AF_APP_IDS);
  const afRows = db.prepare(`
    SELECT app_id, media_source, ROUND(SUM(revenue), 4) as rev
    FROM ${tableName}
    WHERE event_name='af_purchase'
      AND event_time >= ? AND event_time < ?
      AND media_source != 'organic'
      AND app_id IN (${iosAfIds.map(() => '?').join(',')})
    GROUP BY app_id, media_source
  `).all(evtStart, evtEnd, ...iosAfIds);
  const iosAdIds = Object.keys(IOS_AD_APP_IDS);
  const adRows = db.prepare(`
    SELECT app_id, media_source, ROUND(SUM(revenue), 4) as rev
    FROM ${tableName}
    WHERE event_name='ad_purchase'
      AND event_time >= ? AND event_time < ?
      AND media_source NOT IN ('Organic', 'organic')
      AND app_id IN (${iosAdIds.map(() => '?').join(',')})
    GROUP BY app_id, media_source
  `).all(String(tsStart), String(tsEnd), ...iosAdIds);
  const iosProdRevenue = {};
  for (const p of Object.values(IOS_AF_APP_IDS)) iosProdRevenue[p] = { fb: 0, nonFb: 0 };
  for (const row of afRows) {
    const p = IOS_AF_APP_IDS[row.app_id];
    if (isFbSource(row.media_source)) iosProdRevenue[p].fb += row.rev;
    else iosProdRevenue[p].nonFb += row.rev;
  }
  for (const row of adRows) {
    const p = IOS_AD_APP_IDS[row.app_id]; if (!p) continue;
    const ms = row.media_source.replace(/\+/g, ' ');
    if (isFbSource(ms)) iosProdRevenue[p].fb += row.rev;
    else iosProdRevenue[p].nonFb += row.rev;
  }
  for (const p of Object.values(IOS_AF_APP_IDS)) {
    if (p === 'Kira iOS') { factors[p] = 1; continue; }
    const athenaRev = athenaMap[p] || 0;
    const { fb, nonFb } = iosProdRevenue[p];
    const fbFixed = IOS_FB_FIXED[p] || 1;
    const fbAdjusted = fb * fbFixed;
    const totalBase = fbAdjusted + nonFb;
    if (totalBase > 0 && athenaRev > 0) {
      const baseFactor = Math.round(athenaRev / totalBase * 0.95 * 10000) / 10000;
      const fbFactor = Math.round(baseFactor * fbFixed * 10000) / 10000;
      factors[p] = { fb: fbFactor, other: baseFactor };
    } else {
      factors[p] = { fb: fbFixed, other: 1 };
    }
  }
  return factors;
}

// FB classification: includes facebook/instagram/restricted/unattributed, but NOT W2A/web
function isFbSource(ms) {
  if (!ms) return false;
  const lower = ms.toLowerCase().replace(/\+/g, ' ');
  if (lower.includes('w2a') || lower.includes('web')) return false;
  if (lower.includes('facebook') || lower.includes('instagram') || lower.includes('off-facebook')) return true;
  if (ms === 'restricted' || ms === 'Unattributed') return true;
  return false;
}

// 修正系数缓存命中判定：缓存按 dataDate 分桶，条目结构 { factors, computedOn }。
// 策略「当天首次算/当天内复用/跨自然日失效」：
//   - 历史日期（早于昨天）：数据已稳定，永久有效直接用。
//   - 昨天/今天(回退后的 dataDate)：仅当 computedOn === 当前 todayStr（同一北京自然日算的）才有效，
//     跨到第二天 computedOn 不再等于 todayStr → 返回 null 触发重算。
// 命中返回 factors，未命中返回 null。
function getCachedCorrFactors(dataDate, todayStr, yesterdayStr) {
  const entry = _corrFactorCache[dataDate];
  if (!entry) return null;
  if (dataDate < yesterdayStr) return entry.factors;       // 历史日期：永久有效
  if (entry.computedOn === todayStr) return entry.factors;  // 昨天/今天：当天内有效
  return null;                                              // 跨自然日失效
}

app.get('/api/correction-factors', authCheck, (req, res) => {
  // Support startDate/endDate or legacy single date
  let startDate = req.query.startDate || req.query.date;
  let endDate = req.query.endDate || req.query.date;
  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  const todayStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const yesterdayStr = yesterdayBeijing();

  // Single-day mode: preserve original behavior exactly (返回结构不变)
  if (startDate === endDate) {
    const date = startDate;
    let dataDate = date;
    if (date >= todayStr) dataDate = yesterdayStr;

    // 先查缓存（命中则连 DB 都不用开），未命中现算并写回。
    let factors = getCachedCorrFactors(dataDate, todayStr, yesterdayStr);
    if (!factors) {
      let db;
      try { db = getPostbackDb(); } catch (e) { return res.status(500).json({ error: e.message }); }
      try {
        factors = computeCorrectionFactorsSync(dataDate, db);
      } finally {
        db.close();
      }
      _corrFactorCache[dataDate] = { factors, computedOn: todayStr };
    }
    res.json({ date, dataDate, factors });
    return;
  }

  // Multi-day mode: return per-day factors map（同一套「当天首次算/当天内复用」缓存）
  const dates = getDateRange(startDate, endDate);
  const dailyFactors = {};
  // Check which dates need DB queries (缓存命中的直接用，含昨天当天内复用)
  const uncachedDates = [];
  for (const d of dates) {
    let dataDate = d;
    if (d >= todayStr) dataDate = yesterdayStr;
    const cached = getCachedCorrFactors(dataDate, todayStr, yesterdayStr);
    if (cached) {
      dailyFactors[d] = cached;
    } else {
      uncachedDates.push({ d, dataDate });
    }
  }
  if (uncachedDates.length === 0) {
    return res.json({ startDate, endDate, dailyFactors });
  }
  let db;
  try { db = getPostbackDb(); } catch (e) { return res.status(500).json({ error: e.message }); }
  try {
    for (const { d, dataDate } of uncachedDates) {
      // 同一 dataDate 可能在本次请求内被多个 d 命中（如今天/未来都回退到昨天），算完即写回缓存供后续复用
      let factors = getCachedCorrFactors(dataDate, todayStr, yesterdayStr);
      if (!factors) {
        factors = computeCorrectionFactorsSync(dataDate, db);
        _corrFactorCache[dataDate] = { factors, computedOn: todayStr };
      }
      dailyFactors[d] = factors;
    }
    res.json({ startDate, endDate, dailyFactors });
  } finally {
    db.close();
  }
});

// ── eLTV multipliers (double exponential fit, D30 undiscounted, per channel) ────
// Cache structure: { date: { date, multipliers: { product: { FB: {...}, GG: {...}, TT: {...} } } } }
const ELTV_CACHE_PATH = path.join(__dirname, 'data', 'eltv-cache.json');
const HWM_CACHE_PATH = path.join(__dirname, 'data', 'eltv-hwm.json');

function loadEltvCacheFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(ELTV_CACHE_PATH, 'utf8'));
  } catch (_) { return {}; }
}
function saveEltvCacheToDisk(cache) {
  try { fs.writeFileSync(ELTV_CACHE_PATH, JSON.stringify(cache)); } catch (e) { console.error('[eLTV] Failed to save cache:', e.message); }
}
function loadHwmFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(HWM_CACHE_PATH, 'utf8'));
  } catch (_) { return {}; }
}
function saveHwmToDisk(hwm) {
  try { fs.writeFileSync(HWM_CACHE_PATH, JSON.stringify(hwm)); } catch (e) { console.error('[eLTV] Failed to save HWM:', e.message); }
}

const eltvCache = loadEltvCacheFromDisk();
// High-water mark keyed by "product_channel" — once reached, never drops.
const eltvConfidenceHWM = loadHwmFromDisk();
// 修正系数进程内缓存，按 dataDate 分桶：{ [dataDate]: { factors, computedOn } }
// computedOn = 算出该条目时的北京自然日(todayStr)，用于「跨自然日失效」判定（见 getCachedCorrFactors）。
const _corrFactorCache = {};
function confidenceRank(c) { return c === 'green' ? 2 : c === 'yellow' ? 1 : 0; }
function applyConfidenceHWM(key, computed) {
  const prev = eltvConfidenceHWM[key] || 'red';
  const best = confidenceRank(computed) >= confidenceRank(prev) ? computed : prev;
  eltvConfidenceHWM[key] = best;
  saveHwmToDisk(eltvConfidenceHWM);
  return best;
}

// eLTV per-channel data source rules
// For each product, defines which event_name + app_ids to query per channel
const ELTV_PRODUCTS = {
  'Dora And':   { af: ['com.doramatch.app'], ad: [] },
  'Dora iOS':   { af: ['id6746109957'], ad: [] },
  'Romi iOS':   { af: ['id6746782904'], ad: ['6746782904'] }, // FB=AD, TT=AF
  'Jovia And':  { af: ['com.qiga.vio'], ad: [] },
  'Doni':       { af: ['com.doni.appa'], ad: [] },
  'Romi And':   { af: ['com.romiandroid.appmatch'], ad: [] },
  'GraceChat':  { af: ['id1658972379'], ad: [] },
  'Kira iOS':   { af: ['id6759697686'], ad: [] },
  'Kira And':   { af: ['com.meraki.kira'], ad: [] },
  'Nalo And':   { af: ['com.cavalier.nalo'], ad: [] },
  'Luma':       { af: [], ad: ['6746466099'] }, // All channels from AD
};

// Channel mapping for eLTV (organic excluded, restricted→FB)
const ELTV_CHANNEL_MAP = {
  'Facebook Ads': 'FB', 'Facebook+Installs': 'FB', 'Instagram+Installs': 'FB',
  'Off-Facebook+Installs': 'FB', 'Facebook+web': 'FB', 'Luma+ios+FB+W2A': 'FB',
  'restricted': 'FB', 'Unattributed': 'FB', 'Social_facebook': 'FB',
  'googleadwords_int': 'GG', 'Google Ads ACI': 'GG', 'Google+Ads+ACI': 'GG',
  'tiktokglobal_int': 'TT', 'TikTok+SAN': 'TT', 'TikTok SAN': 'TT',
  'organic': null, 'Organic': null,
};
function mapEltvChannel(src) {
  if (!src) return null;
  if (ELTV_CHANNEL_MAP[src] !== undefined) return ELTV_CHANNEL_MAP[src];
  if (src.toLowerCase().includes('w2a') || src.toLowerCase().includes('web')) return 'FB';
  return null;
}

// Determine queries for a product×channel combination
function getEltvQueries(product, channel) {
  const p = ELTV_PRODUCTS[product];
  if (!p) return [];
  if (product === 'Romi iOS') {
    if (channel === 'FB') return [{ event: 'ad_purchase', appIds: p.ad, type: 'ad' }];
    if (channel === 'TT') return [{ event: 'af_purchase', appIds: p.af, type: 'af' }];
    return []; // GG: no data
  }
  if (product === 'Luma') {
    return [{ event: 'ad_purchase', appIds: p.ad, type: 'ad' }]; // All channels from AD
  }
  // All others: AF only
  if (p.af.length === 0) return [];
  return [{ event: 'af_purchase', appIds: p.af, type: 'af' }];
}

// Legacy compat: also keep LTV_APP_IDS for any other code that references it
const LTV_APP_IDS = {
  'id6746109957': 'Dora iOS',
  'id6746782904': 'Romi iOS',
  'id6746466099': 'Luma',
  'id1658972379': 'GraceChat',
  'id6759697686': 'Kira iOS',
  'com.doramatch.app': 'Dora And',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
};

function fitDoubleExp(xArr, yArr) {
  // Double exponential: f(t) = a1*e^{-l1*(t-1)} + (1-a1)*e^{-l2*(t-1)}
  // 3 parameters: [a1, l1, l2] — less prone to overfitting with <30 days of data
  const N = xArr.length;
  function f(t, p) {
    const [a1, l1, l2] = p;
    return a1 * Math.exp(-l1 * (t - 1)) + (1 - a1) * Math.exp(-l2 * (t - 1));
  }
  function loss(p) {
    let s = 0;
    for (let i = 0; i < N; i++) { const r = yArr[i] - f(xArr[i], p); s += r * r; }
    return s;
  }
  let p = [0.75, 2.0, 0.05];
  let lr = 1e-4;
  const bounds = [[0.3, 0.95], [0.5, 15.0], [0.005, 0.5]];
  for (let iter = 0; iter < 50000; iter++) {
    const eps = 1e-6;
    const grad = p.map((_, i) => {
      const pp = [...p]; pp[i] += eps;
      const pm = [...p]; pm[i] -= eps;
      return (loss(pp) - loss(pm)) / (2 * eps);
    });
    const newP = p.map((pi, i) => Math.max(bounds[i][0], Math.min(bounds[i][1], pi - lr * grad[i])));
    if (loss(newP) < loss(p)) { p = newP; lr *= 1.05; } else { lr *= 0.5; }
    if (lr < 1e-12) break;
  }
  return p;
}

// D30 undiscounted LTV multiplier (sum of fitted daily revenue, no discounting)
function computeD30Ltv(params) {
  const [a1, l1, l2] = params;
  const a2 = 1 - a1;
  let ltv = 0;
  for (let d = 1; d <= 30; d++) {
    ltv += a1 * Math.exp(-l1 * (d - 1)) + a2 * Math.exp(-l2 * (d - 1));
  }
  return ltv;
}

app.get('/api/eltv-multipliers', authCheck, (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
  if (eltvCache[date]) return res.json(eltvCache[date]);

  // Rolling 30-day window (Beijing time)
  const now = new Date(Date.now() + 8 * 3600000);
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  const ELTV_INSTALL_CUTOFF = cutoff.toISOString().slice(0, 10);
  const adCutoffTs = String(Math.floor((new Date(ELTV_INSTALL_CUTOFF + 'T00:00:00Z').getTime() - 8 * 3600000) / 1000));

  const multipliers = {};
  let db;
  try { db = getPostbackDb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  try {
    const minTable = 'records_' + ELTV_INSTALL_CUTOFF.slice(0, 4) + ELTV_INSTALL_CUTOFF.slice(5, 7);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' AND name >= ? ORDER BY name").all(minTable).map(r => r.name);
    const CHANNELS = ['FB', 'GG', 'TT'];

    for (const [product, cfg] of Object.entries(ELTV_PRODUCTS)) {
      multipliers[product] = {};
      for (const ch of CHANNELS) {
        const queries = getEltvQueries(product, ch);
        if (queries.length === 0) { multipliers[product][ch] = { d180: null }; continue; }

        const dayRevenue = {};
        const dayCohorts = {};
        let totalRecords = 0;

        for (const q of queries) {
          for (const appId of q.appIds) {
            for (const table of tables) {
              let rows;
              if (q.type === 'af') {
                rows = db.prepare(`
                  SELECT install_time, revenue, media_source,
                    CAST((julianday(event_time) - julianday(install_time)) AS INTEGER) + 1 as day_num
                  FROM ${table}
                  WHERE app_id=? AND event_name='af_purchase'
                    AND install_time >= ? AND revenue > 0 AND event_time >= install_time
                `).all(appId, ELTV_INSTALL_CUTOFF);
              } else {
                rows = db.prepare(`
                  SELECT install_time, revenue, media_source,
                    (CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER)) / 86400 + 1 as day_num
                  FROM ${table}
                  WHERE app_id=? AND event_name='ad_purchase'
                    AND install_time >= ? AND revenue > 0
                    AND CAST(event_time AS INTEGER) >= CAST(install_time AS INTEGER)
                `).all(appId, adCutoffTs);
              }
              for (const row of rows) {
                if (mapEltvChannel(row.media_source) !== ch) continue;
                const d = row.day_num;
                if (d < 1 || d > 220) continue;
                totalRecords++;
                dayRevenue[d] = (dayRevenue[d] || 0) + row.revenue;
                let installDate;
                if (q.type === 'af') {
                  installDate = row.install_time.slice(0, 10);
                } else {
                  const ts = parseInt(row.install_time);
                  const dt = new Date((ts + 8 * 3600) * 1000);
                  installDate = dt.toISOString().slice(0, 10);
                }
                if (!dayCohorts[d]) dayCohorts[d] = new Set();
                dayCohorts[d].add(installDate);
              }
            }
          }
        }

        if (!dayRevenue[1] || !dayCohorts[1] || totalRecords < 5) {
          multipliers[product][ch] = { d180: null, records: totalRecords, d1Span: 0 };
          continue;
        }

        const d1PerCohort = dayRevenue[1] / dayCohorts[1].size;
        const xArr = [], yArr = [];
        for (let d = 1; d <= 220; d++) {
          if (!dayCohorts[d] || dayCohorts[d].size === 0) continue;
          yArr.push((dayRevenue[d] / dayCohorts[d].size) / d1PerCohort);
          xArr.push(d);
        }

        const params = fitDoubleExp(xArr, yArr);
        const d180 = computeD30Ltv(params);
        const d1Span = dayCohorts[1].size;
        // Confidence: only check d1Span (time coverage)
        let rawConf = 'red';
        if (d1Span >= 30) rawConf = 'green';
        else if (d1Span >= 10) rawConf = 'yellow';
        const hwmKey = `${product}_${ch}`;
        const confidence = applyConfidenceHWM(hwmKey, rawConf);
        multipliers[product][ch] = {
          d180, params: params.map(v => Math.round(v * 10000) / 10000),
          records: totalRecords, d1Span, confidence
        };
      }
    }
  } finally {
    db.close();
  }

  eltvCache[date] = { date, multipliers };
  saveEltvCacheToDisk(eltvCache);
  res.json(eltvCache[date]);
});
app.get('/api/data', authCheck, (req, res) => {
  // Support startDate/endDate or legacy single date
  let startDate = req.query.startDate || req.query.date || fetcher.formatDate(new Date());
  let endDate = req.query.endDate || req.query.date || fetcher.formatDate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: 'Invalid date format' });
  }

  // Single-day mode: fully preserve original behavior
  if (startDate === endDate) {
    return res.json(fetcher.loadDayData(startDate));
  }

  // Multi-day mode: aggregate across date range
  const dates = getDateRange(startDate, endDate);
  const _cacheKey = `data|${startDate}|${endDate}`;
  const _cacheFp = ''; // day JSON files; liveness handled by TTL
  const _cached = getRangeCache(_cacheKey, _cacheFp);
  if (_cached) return res.json(_cached);
  const missingDates = [];
  const athenaAgg = {}; // product -> { totalRevenue, newUserRevenue }
  const xmpAgg = {};    // product -> { cost }
  let hasAnyData = false;

  for (const d of dates) {
    const dayData = fetcher.loadDayData(d);
    if (!dayData.snapshots || dayData.snapshots.length === 0) {
      missingDates.push(d);
      continue;
    }
    hasAnyData = true;
    const lastSnap = dayData.snapshots[dayData.snapshots.length - 1];
    if (lastSnap.athena) {
      for (const a of lastSnap.athena) {
        if (!athenaAgg[a.product]) athenaAgg[a.product] = { product: a.product, totalRevenue: 0, newUserRevenue: 0 };
        athenaAgg[a.product].totalRevenue += (a.totalRevenue || 0);
        athenaAgg[a.product].newUserRevenue += (a.newUserRevenue || 0);
      }
    }
    if (lastSnap.xmp) {
      for (const x of lastSnap.xmp) {
        if (!xmpAgg[x.product]) xmpAgg[x.product] = { product: x.product, cost: 0 };
        xmpAgg[x.product].cost += (x.cost || 0);
      }
    }
  }

  // Build a virtual snapshot wrapping the aggregated data
  const aggregatedSnapshot = {
    time: new Date().toISOString(),
    athena: Object.values(athenaAgg),
    xmp: Object.values(xmpAgg),
  };

  const _dataResponse = {
    date: endDate,
    startDate,
    endDate,
    isRange: true,
    missingDates,
    snapshots: [aggregatedSnapshot],
  };
  setRangeCache(_cacheKey, _dataResponse, _cacheFp, rangeCacheTtl(endDate));
  res.json(_dataResponse);
});

// API: Get latest snapshot
app.get('/api/data/latest', authCheck, (req, res) => {
  const today = fetcher.formatDate(new Date());
  const data = fetcher.loadDayData(today);
  if (data.snapshots.length > 0) {
    const latest = data.snapshots[data.snapshots.length - 1];
    res.json({ date: today, snapshot: latest });
  } else {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = fetcher.formatDate(yesterday);
    const yData = fetcher.loadDayData(yesterdayStr);
    if (yData.snapshots.length > 0) {
      const latest = yData.snapshots[yData.snapshots.length - 1];
      res.json({ date: yesterdayStr, snapshot: latest });
    } else {
      res.json({ date: today, snapshot: null });
    }
  }
});

// API: Get personal panel data for a date
app.get('/api/personal/data', authCheck, (req, res) => {
  const date = req.query.date || fetcher.formatDate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
  res.json(fetcher.loadPersonalDayData(date));
});

// API: Get personal fetch status
app.get('/api/personal/status', authCheck, (req, res) => {
  res.json(fetcher.getPersonalStatus());
});

// API: Manual refresh personal data
app.post('/api/personal/refresh', authCheck, async (req, res) => {
  const status = fetcher.getPersonalStatus();
  if (status.isFetching) return res.status(409).json({ error: 'Personal fetch already in progress' });
  res.json({ message: 'Personal fetch started' });
  try {
    await fetcher.fetchPersonal();
    console.log('[Server] Personal manual fetch completed');
  } catch (err) {
    console.error('[Server] Personal manual fetch error:', err.message);
  }
});

// API: Get available dates
app.get('/api/dates', authCheck, (req, res) => {
  res.json(fetcher.getAvailableDates());
});

// API: Get fetch status
app.get('/api/status', authCheck, (req, res) => {
  res.json(fetcher.getStatus());
});

// ── Postback (API接收数据) endpoints ────────────────────────
app.get('/api/postback/data', authCheck, (req, res) => {
  const date = req.query.date; // YYYY-MM-DD, Beijing time date
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid or missing date parameter (YYYY-MM-DD)' });
  }

  const tableName = tableForMonth(date);
  let db;
  try {
    db = getPostbackDb();
  } catch (err) {
    return res.status(500).json({ error: 'Cannot connect to postback database: ' + err.message });
  }

  try {
    // Check if table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    if (!tableExists) {
      db.close();
      return res.json({ 
        date, 
        af: { products: [], totals: { count: 0, revenue: 0 } },
        ad: { products: [], totals: { count: 0, revenue: 0 } }
      });
    }

    // Query AF data (af_purchase, event_time is string format)
    const afRows = db.prepare(`
      SELECT 
        app_id,
        media_source,
        COUNT(*) as count,
        COALESCE(SUM(revenue), 0) as revenue
      FROM ${tableName}
      WHERE event_name = 'af_purchase'
        AND date(event_time, '+8 hours') = ?
      GROUP BY app_id, media_source
      ORDER BY SUM(revenue) DESC
    `).all(date);

    // Query AD data (ad_purchase, event_time is unix timestamp)
    const adRows = db.prepare(`
      SELECT 
        app_id,
        media_source,
        COUNT(*) as count,
        COALESCE(SUM(revenue), 0) as revenue
      FROM ${tableName}
      WHERE event_name = 'ad_purchase'
        AND date(datetime(event_time, 'unixepoch', '+8 hours')) = ?
      GROUP BY app_id, media_source
      ORDER BY SUM(revenue) DESC
    `).all(date);

    // Build AF product → channels structure
    const afProductMap = {};
    let afTotalCount = 0;
    let afTotalRevenue = 0;

    for (const row of afRows) {
      if (EXCLUDED_APP_IDS.has(row.app_id)) continue;
      const productName = APP_ID_MAP[row.app_id] || row.app_id;
      const channelName = mapMediaSource(row.media_source);

      if (!afProductMap[productName]) {
        afProductMap[productName] = { product: productName, count: 0, revenue: 0, channels: {} };
      }
      afProductMap[productName].count += row.count;
      afProductMap[productName].revenue += row.revenue;
      afProductMap[productName].channels[channelName] = {
        channel: channelName,
        count: row.count,
        revenue: row.revenue,
      };
      afTotalCount += row.count;
      afTotalRevenue += row.revenue;
    }

    // Build AD product → channels structure
    const adProductMap = {};
    let adTotalCount = 0;
    let adTotalRevenue = 0;

    for (const row of adRows) {
      if (EXCLUDED_APP_IDS.has(row.app_id)) continue;
      const productName = APP_ID_MAP[row.app_id] || row.app_id;
      const channelName = mapMediaSource(row.media_source);

      if (!adProductMap[productName]) {
        adProductMap[productName] = { product: productName, count: 0, revenue: 0, channels: {} };
      }
      adProductMap[productName].count += row.count;
      adProductMap[productName].revenue += row.revenue;
      adProductMap[productName].channels[channelName] = {
        channel: channelName,
        count: row.count,
        revenue: row.revenue,
      };
      adTotalCount += row.count;
      adTotalRevenue += row.revenue;
    }

    // Convert to sorted arrays
    const afProducts = Object.values(afProductMap)
      .map(p => ({
        ...p,
        channels: Object.values(p.channels).sort((a, b) => b.revenue - a.revenue),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const adProducts = Object.values(adProductMap)
      .map(p => ({
        ...p,
        channels: Object.values(p.channels).sort((a, b) => b.revenue - a.revenue),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({ 
      date,
      af: { products: afProducts, totals: { count: afTotalCount, revenue: afTotalRevenue } },
      ad: { products: adProducts, totals: { count: adTotalCount, revenue: adTotalRevenue } }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

// ── Postback Personal (AF API个人数据) ──────────────────────
const OPERATOR_CODES = ['syh', 'zm1', 'wcx', 'zmf', 'mcy', 'lh', 'ymt', 'wty', 'wvv', 'zjc', 'cy1'];

// Alias rules (checked in fallback, longer patterns first):
// 'liuh' → lh (刘欢)    — some campaigns use full pinyin
// 'zm' → zm1 (张苗)     — only if NOT 'zmf' (张梦凡)
// Check if campaign is a test/creative-testing campaign
function isTestCreative(campaign) {
  if (!campaign) return false;
  if (campaign.includes('测')) return true;
  if (campaign.toLowerCase().includes('test')) return true;
  return false;
}

function matchOperator(campaign) {
  if (!campaign) return null;
  // Priority: test creative detection before operator matching
  if (isTestCreative(campaign)) return 'test_creative';
  const lower = campaign.toLowerCase();
  for (const code of OPERATOR_CODES) {
    if (lower.includes(code)) return code;
  }
  // Aliases (only reached if no primary code matched)
  if (lower.includes('liuh')) return 'lh';
  if (lower.includes('zm') && !lower.includes('zmf')) return 'zm1';
  return null;
}

// Normalize an ad-group / adset name so DB (AF/AD) keys and XMP `adset_name`
// collapse to the same string for joining XMP cost onto adset nodes.
//   - AF `af_adset`: already clean (e.g. "5.14 AEOcao4") — normalize is effectively a trim.
//   - AD `payload.adgroup`: URL-encoded + trailing " (numericId)" (e.g. "group2+%28120242388504120055%29")
//     → urldecode (with +→space) then strip the trailing "(digits)" → "group2".
//   - XMP `adset_name`: clean (e.g. "group2") → trim only.
// Must be applied identically on both sides of the join.
function normAdset(raw) {
  if (raw == null || raw === '') return '';
  let s = String(raw);
  try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { s = s.replace(/\+/g, ' '); }
  s = s.replace(/\s*\(\d+\)\s*$/, '');
  return s.trim();
}

// Adjust paid media sources for personal panel
const AD_PAID_SOURCES = new Set([
  'Facebook+Installs', 'Facebook Installs',
  'Instagram+Installs', 'Instagram Installs',
  'Facebook+web', 'Facebook web',
  'TikTok+SAN', 'TikTok SAN',
  'Google+Ads+ACI', 'Google Ads ACI',
]);
const AD_ORGANIC_SOURCES = new Set(['Organic', 'Unattributed', 'organic', 'restricted', 'Untrusted Devices']);

// ══════════════════════════════════════════════════════════
// Personal Panel Snapshot Cache
// ══════════════════════════════════════════════════════════

const PERSONAL_SNAPSHOT_DIR = path.join(__dirname, 'data', 'personal-snapshots');
if (!fs.existsSync(PERSONAL_SNAPSHOT_DIR)) fs.mkdirSync(PERSONAL_SNAPSHOT_DIR, { recursive: true });

function personalSnapshotPath(dateStr) {
  return path.join(PERSONAL_SNAPSHOT_DIR, `personal-${dateStr}.json`);
}

function loadPersonalSnapshot(dateStr) {
  const p = personalSnapshotPath(dateStr);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function savePersonalSnapshot(dateStr, data, meta) {
  const snapshot = { _meta: { ...meta, savedAt: new Date().toISOString() }, ...data };
  fs.writeFileSync(personalSnapshotPath(dateStr), JSON.stringify(snapshot));
  console.log(`[Snapshot] Saved personal snapshot for ${dateStr} (${meta.type})`);
}

function todayBeijing() {
  const now = new Date(Date.now() + 8 * 3600000);
  return now.toISOString().slice(0, 10);
}

// 北京时间「昨天」的 YYYY-MM-DD。纯 epoch 偏移，与服务器系统时区无关。
// 注意：不要用 `new Date(todayStr+'T00:00:00+08:00'); d.setDate(d.getDate()-1)`
// 那种写法——setDate 按系统本地时区改日，但 toISOString() 输出 UTC，会多减一天。
function yesterdayBeijing() {
  return new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10);
}

function nowBeijingHour() {
  return new Date(Date.now() + 8 * 3600000).getUTCHours();
}

function daysBefore(dateA, dateB) {
  // How many days dateB is before dateA (positive if B < A)
  const a = new Date(dateA + 'T00:00:00Z');
  const b = new Date(dateB + 'T00:00:00Z');
  return Math.round((a - b) / 86400000);
}

function responseHasReasonableCost(data) {
  // Require all 3 paid channels (FB/GG/TT) to have cost data.
  // If any channel has 0 cost, the XMP data was likely incomplete (API rate-limited or partial).
  if (!data || !data.operators) return false;
  const channelCost = {}; // { FB: total, GG: total, TT: total }
  for (const op of data.operators) {
    for (const prod of (op.products || [])) {
      for (const ch of (prod.channels || [])) {
        channelCost[ch.channel] = (channelCost[ch.channel] || 0) + (ch.cost || 0);
      }
    }
  }
  const totalCost = Object.values(channelCost).reduce((s, v) => s + v, 0);
  if (totalCost <= 100) return false;
  // All 3 main channels must have some cost
  return ['FB', 'GG', 'TT'].every(ch => (channelCost[ch] || 0) > 0);
}

// Relaxed check for HISTORICAL (settled) dates — daysAgo >= 2.
// Those dates are finalized: the data won't change, so we should persist a
// complete snapshot even when a channel legitimately had no spend that day
// (e.g. TT cost=0 on 2026-05-16, but FB+GG spend and revenue are all present).
// The strict all-3-channels rule (responseHasReasonableCost) is only meaningful
// for still-settling recent days, where a 0 usually means an incomplete XMP fetch.
// We still guard against a genuine query FAILURE (DB unreachable → empty
// operators, or a total XMP outage → zero spend everywhere): require real
// operators, real revenue, and at least one channel with actual spend.
function responseIsHistoricallyComplete(data) {
  if (!data || !Array.isArray(data.operators) || data.operators.length === 0) return false;
  let totalCost = 0, totalRevenue = 0;
  for (const op of data.operators) {
    totalRevenue += (op.revenue || 0);
    for (const prod of (op.products || [])) {
      for (const ch of (prod.channels || [])) {
        totalCost += (ch.cost || 0);
      }
    }
  }
  // Real data present: some channel actually spent (>100 guards a total XMP
  // outage) AND we captured revenue. A query failure yields empty operators /
  // zero revenue / zero cost and is rejected → it will be re-queried later.
  return totalCost > 100 && totalRevenue > 0;
}

// Patch a partial snapshot with cross-day new user data
function patchCrossDayNewUsers(snapshot, dateStr) {
  // Query only the cross-day new-user extra rows and merge deltas into snapshot
  let db;
  try { db = getPostbackDb(); } catch (e) { return null; }
  
  try {
    const [y, m, d2] = dateStr.split('-').map(Number);
    const nextDateObj = new Date(y, m - 1, d2 + 1);
    const nextDateStr = nextDateObj.getFullYear() + '-' + String(nextDateObj.getMonth() + 1).padStart(2, '0') + '-' + String(nextDateObj.getDate()).padStart(2, '0');
    const tableName = tableForMonth(dateStr);
    const nextTableName = tableForMonth(nextDateStr);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%'").all().map(r => r.name);
    
    // AF cross-day extra
    const afExtraRows = [];
    const afExtraQuery = (tbl) => `
      SELECT campaign, app_id, media_source, revenue, event_time, install_time,
        json_extract(payload, '$.af_adset') as af_adset,
        json_extract(payload, '$.af_ad') as af_ad
      FROM ${tbl}
      WHERE event_name = 'af_purchase'
        AND date(install_time, '+8 hours') = ?
        AND date(event_time, '+8 hours') = ?
        AND media_source IN ('Facebook Ads', 'googleadwords_int', 'tiktokglobal_int')
        AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
        AND (julianday(event_time) - julianday(install_time)) * 24 < 24
    `;
    if (tables.includes(tableName)) {
      afExtraRows.push(...db.prepare(afExtraQuery(tableName)).all(dateStr, nextDateStr));
    }
    if (tables.includes(nextTableName) && nextTableName !== tableName) {
      afExtraRows.push(...db.prepare(afExtraQuery(nextTableName)).all(dateStr, nextDateStr));
    }
    
    // AD cross-day extra
    const adExtraRows = [];
    const adExtraQuery = (tbl) => `
      SELECT campaign, app_id, media_source, revenue, event_time, install_time,
        json_extract(payload, '$.adgroup') as ad_adgroup,
        json_extract(payload, '$.creative') as ad_creative
      FROM ${tbl}
      WHERE event_name = 'ad_purchase'
        AND date(datetime(install_time, 'unixepoch', '+8 hours')) = ?
        AND date(datetime(event_time, 'unixepoch', '+8 hours')) = ?
        AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) >= 0
        AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) < 86400
    `;
    if (tables.includes(tableName)) {
      adExtraRows.push(...db.prepare(adExtraQuery(tableName)).all(dateStr, nextDateStr));
    }
    if (tables.includes(nextTableName) && nextTableName !== tableName) {
      adExtraRows.push(...db.prepare(adExtraQuery(nextTableName)).all(dateStr, nextDateStr));
    }
    
    // Organic cross-day extra
    let organicExtra = 0;
    if (tables.includes(tableName)) {
      const r = db.prepare(`
        SELECT COALESCE(SUM(revenue), 0) as extra FROM ${tableName}
        WHERE event_name = 'af_purchase' AND date(install_time, '+8 hours') = ?
          AND date(event_time, '+8 hours') = ? AND media_source = 'organic'
          AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
          AND (julianday(event_time) - julianday(install_time)) * 24 < 24
      `).get(dateStr, nextDateStr);
      organicExtra += r ? r.extra : 0;
    }
    
    // Restricted cross-day extra
    let restrictedExtra = 0;
    if (tables.includes(tableName)) {
      const r = db.prepare(`
        SELECT COALESCE(SUM(revenue), 0) as extra FROM ${tableName}
        WHERE event_name = 'af_purchase' AND date(install_time, '+8 hours') = ?
          AND date(event_time, '+8 hours') = ? AND media_source = 'restricted'
          AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
          AND (julianday(event_time) - julianday(install_time)) * 24 < 24
      `).get(dateStr, nextDateStr);
      restrictedExtra += r ? r.extra : 0;
    }
    
    db.close();
    return { afExtraRows, adExtraRows, organicExtra, restrictedExtra };
  } catch (e) {
    console.error('[Snapshot] Cross-day patch query error:', e.message);
    try { db.close(); } catch(_) {}
    return null;
  }
}

function applyCrossDayPatch(snapshot, patch, dateStr) {
  // Apply cross-day new user revenue deltas into the snapshot data
  // This modifies newUserRevenue at all levels: operator → product → channel → campaign → adset → ad
  
  // Process AF extra rows
  for (const row of (patch.afExtraRows || [])) {
    const operator = matchOperator(row.campaign) || 'other';
    const productName = APP_ID_MAP[row.app_id] || row.app_id;
    const channelName = mapMediaSource(row.media_source);
    const rev = row.revenue || 0;
    
    const op = snapshot.operators.find(o => o.operator === operator);
    if (!op) continue;
    op.newUserRevenue = (op.newUserRevenue || 0) + rev;
    
    const prod = op.products.find(p => p.product === productName);
    if (!prod) continue;
    prod.newUserRevenue = (prod.newUserRevenue || 0) + rev;
    
    const ch = prod.channels.find(c => c.channel === channelName);
    if (!ch) continue;
    ch.newUserRevenue = (ch.newUserRevenue || 0) + rev;
    
    const campKey = (row.campaign || '(unknown)').trim();
    const camp = (ch.campaigns || []).find(c => c.campaign === campKey);
    if (camp) camp.newUserRevenue = (camp.newUserRevenue || 0) + rev;
    
    const adsetKey = normAdset(row.af_adset) || '(unknown)';
    if (camp) {
      const adset = (camp.adsets || []).find(a => a.adset === adsetKey);
      if (adset) {
        adset.newUserRevenue = (adset.newUserRevenue || 0) + rev;
        const adKey = row.af_ad || '(unknown)';
        const ad = (adset.ads || []).find(a => a.ad === adKey);
        if (ad) ad.newUserRevenue = (ad.newUserRevenue || 0) + rev;
      }
    }
  }
  
  // Process AD extra rows
  for (const row of (patch.adExtraRows || [])) {
    const mediaSource = row.media_source || '';
    const rev = row.revenue || 0;
    let campaign = row.campaign || '';
    try { campaign = decodeURIComponent(campaign.replace(/\+/g, ' ')); } catch(e) {}
    campaign = campaign.replace(/\s*\(.*?\)\s*$/, '').trim();
    
    if (AD_ORGANIC_SOURCES.has(mediaSource)) continue;
    
    const operator = matchOperator(campaign) || 'other';
    const productName = APP_ID_MAP[row.app_id] || row.app_id;
    const channelName = mapMediaSource(mediaSource);
    
    const op = snapshot.operators.find(o => o.operator === operator);
    if (!op) continue;
    op.newUserRevenue = (op.newUserRevenue || 0) + rev;
    
    const prod = op.products.find(p => p.product === productName);
    if (!prod) continue;
    prod.newUserRevenue = (prod.newUserRevenue || 0) + rev;
    
    const ch = prod.channels.find(c => c.channel === channelName);
    if (!ch) continue;
    ch.newUserRevenue = (ch.newUserRevenue || 0) + rev;
    
    const campKey = campaign || '(unknown)';
    const camp = ch.campaigns.find(c => c.campaign === campKey);
    if (camp) camp.newUserRevenue = (camp.newUserRevenue || 0) + rev;
  }
  
  // Organic & restricted
  if (patch.organicExtra && snapshot.organic) {
    snapshot.organic.newUserRevenue = (snapshot.organic.newUserRevenue || 0) + patch.organicExtra;
  }
  if (patch.restrictedExtra && snapshot.restricted) {
    snapshot.restricted.newUserRevenue = (snapshot.restricted.newUserRevenue || 0) + patch.restrictedExtra;
  }
  
  return snapshot;
}

// Helper: get personal data for a single date via full DB+XMP query (used by multi-day aggregation)
async function getPersonalDataLive(date) {
  const tableName = tableForMonth(date);
  let db;
  try { db = getPostbackDb(); } catch (e) { return null; }

  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    if (!tableExists) {
      db.close();
      return { date, operators: [], organic: { count: 0, revenue: 0, newUserRevenue: 0 }, restricted: { count: 0, revenue: 0, newUserRevenue: 0 } };
    }

    // Compute next date for cross-day queries
    const [y, m, d2] = date.split('-').map(Number);
    const nextDateObj = new Date(y, m - 1, d2 + 1);
    const nextDateStr = nextDateObj.getFullYear() + '-' + String(nextDateObj.getMonth() + 1).padStart(2, '0') + '-' + String(nextDateObj.getDate()).padStart(2, '0');
    const nextTableName = tableForMonth(nextDateStr);
    const nextTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(nextTableName);
    // Sargable Beijing-day bounds (index-range scans instead of date()-per-row).
    const dB = beijingDayBounds(date);
    const dBn = beijingDayBounds(nextDateStr);

    // AF paid rows
    const paidRows = db.prepare(`
      SELECT campaign, app_id, media_source, revenue, event_time, install_time,
        json_extract(payload, '$.af_adset') as af_adset,
        json_extract(payload, '$.af_ad') as af_ad
      FROM ${tableName}
      WHERE event_name = 'af_purchase'
        AND event_time >= ? AND event_time < ?
        AND media_source IN ('Facebook Ads', 'googleadwords_int', 'tiktokglobal_int')
    `).all(dB.strLo, dB.strHi);

    // AF cross-day new user rows
    const afNewUserExtraRows = [];
    const afExtraSame = db.prepare(`
      SELECT campaign, app_id, media_source, revenue, event_time, install_time,
        json_extract(payload, '$.af_adset') as af_adset,
        json_extract(payload, '$.af_ad') as af_ad
      FROM ${tableName}
      WHERE event_name = 'af_purchase'
        AND install_time >= ? AND install_time < ?
        AND event_time >= ? AND event_time < ?
        AND media_source IN ('Facebook Ads', 'googleadwords_int', 'tiktokglobal_int')
        AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
        AND (julianday(event_time) - julianday(install_time)) * 24 < 24
    `).all(dB.strLo, dB.strHi, dBn.strLo, dBn.strHi);
    afNewUserExtraRows.push(...afExtraSame);
    if (nextTableExists && nextTableName !== tableName) {
      afNewUserExtraRows.push(...db.prepare(`
        SELECT campaign, app_id, media_source, revenue, event_time, install_time,
          json_extract(payload, '$.af_adset') as af_adset,
          json_extract(payload, '$.af_ad') as af_ad
        FROM ${nextTableName}
        WHERE event_name = 'af_purchase'
          AND install_time >= ? AND install_time < ?
          AND event_time >= ? AND event_time < ?
          AND media_source IN ('Facebook Ads', 'googleadwords_int', 'tiktokglobal_int')
          AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
          AND (julianday(event_time) - julianday(install_time)) * 24 < 24
      `).all(dB.strLo, dB.strHi, dBn.strLo, dBn.strHi));
    }

    // Organic
    const organicRows = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(revenue), 0) as revenue,
        COALESCE(SUM(CASE WHEN install_time >= ? AND install_time < ? AND (julianday(event_time) - julianday(install_time)) * 24 >= 0 AND (julianday(event_time) - julianday(install_time)) * 24 < 24 THEN revenue ELSE 0 END), 0) as new_user_revenue
      FROM ${tableName}
      WHERE event_name = 'af_purchase' AND event_time >= ? AND event_time < ? AND media_source = 'organic'
    `).get(dB.strLo, dB.strHi, dB.strLo, dB.strHi);
    const organicNewUserExtra = db.prepare(`
      SELECT COALESCE(SUM(revenue), 0) as extra FROM ${tableName}
      WHERE event_name = 'af_purchase' AND install_time >= ? AND install_time < ?
        AND event_time >= ? AND event_time < ? AND media_source = 'organic'
        AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
        AND (julianday(event_time) - julianday(install_time)) * 24 < 24
    `).get(dB.strLo, dB.strHi, dBn.strLo, dBn.strHi);

    // Restricted
    const restrictedRows = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(revenue), 0) as revenue,
        COALESCE(SUM(CASE WHEN install_time >= ? AND install_time < ? AND (julianday(event_time) - julianday(install_time)) * 24 >= 0 AND (julianday(event_time) - julianday(install_time)) * 24 < 24 THEN revenue ELSE 0 END), 0) as new_user_revenue
      FROM ${tableName}
      WHERE event_name = 'af_purchase' AND event_time >= ? AND event_time < ? AND media_source = 'restricted'
    `).get(dB.strLo, dB.strHi, dB.strLo, dB.strHi);
    const restrictedNewUserExtra = db.prepare(`
      SELECT COALESCE(SUM(revenue), 0) as extra FROM ${tableName}
      WHERE event_name = 'af_purchase' AND install_time >= ? AND install_time < ?
        AND event_time >= ? AND event_time < ? AND media_source = 'restricted'
        AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
        AND (julianday(event_time) - julianday(install_time)) * 24 < 24
    `).get(dB.strLo, dB.strHi, dBn.strLo, dBn.strHi);

    // AD paid rows
    const adPaidRows = db.prepare(`
      SELECT campaign, app_id, media_source, revenue, event_time, install_time,
        json_extract(payload, '$.adgroup') as ad_adgroup,
        json_extract(payload, '$.creative') as ad_creative
      FROM ${tableName}
      WHERE event_name = 'ad_purchase' AND event_time >= ? AND event_time < ?
    `).all(dB.epLo, dB.epHi);

    // AD cross-day
    const adNewUserExtraRows = [];
    adNewUserExtraRows.push(...db.prepare(`
      SELECT campaign, app_id, media_source, revenue, event_time, install_time,
        json_extract(payload, '$.adgroup') as ad_adgroup,
        json_extract(payload, '$.creative') as ad_creative
      FROM ${tableName}
      WHERE event_name = 'ad_purchase'
        AND install_time >= ? AND install_time < ?
        AND event_time >= ? AND event_time < ?
        AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) >= 0
        AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) < 86400
    `).all(dB.epLo, dB.epHi, dBn.epLo, dBn.epHi));
    if (nextTableExists && nextTableName !== tableName) {
      adNewUserExtraRows.push(...db.prepare(`
        SELECT campaign, app_id, media_source, revenue, event_time, install_time,
          json_extract(payload, '$.adgroup') as ad_adgroup,
          json_extract(payload, '$.creative') as ad_creative
        FROM ${nextTableName}
        WHERE event_name = 'ad_purchase'
          AND install_time >= ? AND install_time < ?
          AND event_time >= ? AND event_time < ?
          AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) >= 0
          AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) < 86400
      `).all(dB.epLo, dB.epHi, dBn.epLo, dBn.epHi));
    }

    db.close();

    // Build simplified operator map (no campaigns for live multi-day)
    const operatorMap = {};
    let adOrganicCount = 0, adOrganicRevenue = 0, adOrganicNewUserRevenue = 0;

    // Process AF paid rows
    for (const row of paidRows) {
      const operator = matchOperator(row.campaign) || 'other';
      const productName = APP_ID_MAP[row.app_id] || row.app_id;
      const channelName = mapMediaSource(row.media_source);
      const rev = row.revenue || 0;
      let isNewUser = false;
      if (row.install_time && row.event_time) {
        const eventDate = new Date(row.event_time.replace(' ', 'T') + 'Z');
        const installDate = new Date(row.install_time.replace(' ', 'T') + 'Z');
        const installBeijingDay = new Date(installDate.getTime() + 8 * 3600000).toISOString().slice(0, 10);
        const diffHours = (eventDate - installDate) / 3600000;
        isNewUser = (installBeijingDay === date && diffHours >= 0 && diffHours < 24);
      }
      if (!operatorMap[operator]) operatorMap[operator] = { operator, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, products: {} };
      operatorMap[operator].count += 1;
      operatorMap[operator].revenue += rev;
      if (isNewUser) operatorMap[operator].newUserRevenue += rev;
      if (!operatorMap[operator].products[productName]) operatorMap[operator].products[productName] = { product: productName, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, channels: {} };
      operatorMap[operator].products[productName].count += 1;
      operatorMap[operator].products[productName].revenue += rev;
      if (isNewUser) operatorMap[operator].products[productName].newUserRevenue += rev;
      if (!operatorMap[operator].products[productName].channels[channelName]) operatorMap[operator].products[productName].channels[channelName] = { channel: channelName, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, campaigns: [] };
      operatorMap[operator].products[productName].channels[channelName].count += 1;
      operatorMap[operator].products[productName].channels[channelName].revenue += rev;
      if (isNewUser) operatorMap[operator].products[productName].channels[channelName].newUserRevenue += rev;
    }

    // Process AF extra new-user rows
    for (const row of afNewUserExtraRows) {
      const operator = matchOperator(row.campaign) || 'other';
      const productName = APP_ID_MAP[row.app_id] || row.app_id;
      const channelName = mapMediaSource(row.media_source);
      const rev = row.revenue || 0;
      if (!operatorMap[operator]) operatorMap[operator] = { operator, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, products: {} };
      operatorMap[operator].newUserRevenue += rev;
      if (!operatorMap[operator].products[productName]) operatorMap[operator].products[productName] = { product: productName, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, channels: {} };
      operatorMap[operator].products[productName].newUserRevenue += rev;
      if (!operatorMap[operator].products[productName].channels[channelName]) operatorMap[operator].products[productName].channels[channelName] = { channel: channelName, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, campaigns: [] };
      operatorMap[operator].products[productName].channels[channelName].newUserRevenue += rev;
    }

    // Process AD paid rows
    for (const row of adPaidRows) {
      const mediaSource = row.media_source || '';
      const rev = row.revenue || 0;
      let campaign = row.campaign || '';
      try { campaign = decodeURIComponent(campaign.replace(/\+/g, ' ')); } catch(e) {}
      campaign = campaign.replace(/\s*\(.*?\)\s*$/, '').trim();
      let isNewUser = false;
      if (row.install_time && row.event_time) {
        const eventTs = parseInt(row.event_time);
        const installTs = parseInt(row.install_time);
        if (!isNaN(eventTs) && !isNaN(installTs)) {
          const installBeijingDay = new Date((installTs + 8 * 3600) * 1000).toISOString().slice(0, 10);
          const diffHours = (eventTs - installTs) / 3600;
          isNewUser = (installBeijingDay === date && diffHours >= 0 && diffHours < 24);
        }
      }
      if (AD_ORGANIC_SOURCES.has(mediaSource)) {
        adOrganicCount += 1; adOrganicRevenue += rev;
        if (isNewUser) adOrganicNewUserRevenue += rev;
        continue;
      }
      const operator = matchOperator(campaign) || 'other';
      const productName = APP_ID_MAP[row.app_id] || row.app_id;
      const channelName = mapMediaSource(mediaSource);
      if (!operatorMap[operator]) operatorMap[operator] = { operator, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, products: {} };
      operatorMap[operator].count += 1; operatorMap[operator].revenue += rev;
      if (isNewUser) operatorMap[operator].newUserRevenue += rev;
      if (!operatorMap[operator].products[productName]) operatorMap[operator].products[productName] = { product: productName, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, channels: {} };
      operatorMap[operator].products[productName].count += 1; operatorMap[operator].products[productName].revenue += rev;
      if (isNewUser) operatorMap[operator].products[productName].newUserRevenue += rev;
      if (!operatorMap[operator].products[productName].channels[channelName]) operatorMap[operator].products[productName].channels[channelName] = { channel: channelName, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, campaigns: [] };
      operatorMap[operator].products[productName].channels[channelName].count += 1; operatorMap[operator].products[productName].channels[channelName].revenue += rev;
      if (isNewUser) operatorMap[operator].products[productName].channels[channelName].newUserRevenue += rev;
    }

    // Process AD extra new-user rows
    for (const row of adNewUserExtraRows) {
      const mediaSource = row.media_source || '';
      const rev = row.revenue || 0;
      let campaign = row.campaign || '';
      try { campaign = decodeURIComponent(campaign.replace(/\+/g, ' ')); } catch(e) {}
      campaign = campaign.replace(/\s*\(.*?\)\s*$/, '').trim();
      if (AD_ORGANIC_SOURCES.has(mediaSource)) { adOrganicNewUserRevenue += rev; continue; }
      const operator = matchOperator(campaign) || 'other';
      const productName = APP_ID_MAP[row.app_id] || row.app_id;
      const channelName = mapMediaSource(mediaSource);
      if (!operatorMap[operator]) operatorMap[operator] = { operator, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, products: {} };
      operatorMap[operator].newUserRevenue += rev;
      if (!operatorMap[operator].products[productName]) operatorMap[operator].products[productName] = { product: productName, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, channels: {} };
      operatorMap[operator].products[productName].newUserRevenue += rev;
      if (!operatorMap[operator].products[productName].channels[channelName]) operatorMap[operator].products[productName].channels[channelName] = { channel: channelName, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, campaigns: [] };
      operatorMap[operator].products[productName].channels[channelName].newUserRevenue += rev;
    }

    // Fetch XMP for this date
    let xmpCampaigns = [];
    try { xmpCampaigns = await fetchXmpCampaigns(date, { staleOk: true }); } catch (e) {}
    for (const xmpRow of xmpCampaigns) {
      const operator = matchOperator(xmpRow.campaign) || 'other';
      if (!operatorMap[operator]) operatorMap[operator] = { operator, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, products: {} };
      operatorMap[operator].cost = (operatorMap[operator].cost || 0) + xmpRow.cost;
      if (!operatorMap[operator].products[xmpRow.product]) operatorMap[operator].products[xmpRow.product] = { product: xmpRow.product, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, channels: {} };
      operatorMap[operator].products[xmpRow.product].cost = (operatorMap[operator].products[xmpRow.product].cost || 0) + xmpRow.cost;
      if (!operatorMap[operator].products[xmpRow.product].channels[xmpRow.channel]) operatorMap[operator].products[xmpRow.product].channels[xmpRow.channel] = { channel: xmpRow.channel, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, campaigns: [] };
      operatorMap[operator].products[xmpRow.product].channels[xmpRow.channel].cost = (operatorMap[operator].products[xmpRow.product].channels[xmpRow.channel].cost || 0) + xmpRow.cost;
    }

    // Convert to sorted arrays
    const operators = Object.values(operatorMap).map(op => ({
      ...op,
      products: Object.values(op.products).map(p => ({
        ...p,
        channels: Object.values(p.channels).sort((a, b) => b.revenue - a.revenue),
      })).sort((a, b) => b.revenue - a.revenue),
    })).sort((a, b) => b.revenue - a.revenue);

    return {
      date,
      operators,
      organic: {
        count: organicRows.count + adOrganicCount,
        revenue: organicRows.revenue + adOrganicRevenue,
        newUserRevenue: organicRows.new_user_revenue + (organicNewUserExtra ? organicNewUserExtra.extra : 0) + adOrganicNewUserRevenue,
      },
      restricted: {
        count: restrictedRows.count,
        revenue: restrictedRows.revenue,
        newUserRevenue: restrictedRows.new_user_revenue + (restrictedNewUserExtra ? restrictedNewUserExtra.extra : 0),
      },
    };
  } catch (e) {
    console.error('[getPersonalDataLive] Error:', e.message);
    try { db.close(); } catch (_) {}
    return null;
  }
}

app.get('/api/postback/personal', authCheck, async (req, res) => {
  let startDate = req.query.startDate || req.query.date;
  let endDate = req.query.endDate || req.query.date;
  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: 'Invalid or missing date parameter (YYYY-MM-DD)' });
  }

  // ── Multi-day mode: aggregate snapshots ──
  if (startDate !== endDate) {
    const dates = getDateRange(startDate, endDate);
    const today = todayBeijing();
    const missingDates = [];
    const operatorAgg = {};
    let organicAgg = { count: 0, revenue: 0, newUserRevenue: 0, correctedRevenue: 0, correctedNewUserRevenue: 0 };
    let restrictedAgg = { count: 0, revenue: 0, newUserRevenue: 0, correctedRevenue: 0, correctedNewUserRevenue: 0 };

    // Pre-compute correction factors for all dates in range
    let db;
    try { db = getPostbackDb(); } catch (e) { /* will use factor=1 */ }
    const dailyCorrFactors = {};
    for (const d of dates) {
      const todayStr = todayBeijing();
      let dataDate = d;
      if (d >= todayStr) {
        dataDate = yesterdayBeijing();
      }
      try {
        dailyCorrFactors[d] = db ? computeCorrectionFactorsSync(dataDate, db) : {};
      } catch (e) {
        dailyCorrFactors[d] = {};
      }
    }

    // Helper: get correction factor for a product+channel on a given date
    function getCorrFactor(date, product, channel) {
      const f = (dailyCorrFactors[date] || {})[product];
      if (f == null) return 1;
      if (typeof f === 'number') return f; // Android: single factor
      // iOS: { fb, other }
      if (channel === 'FB' || channel === 'FB W2A') return f.fb || 1;
      return f.other || 1;
    }

    // Helper: merge a single day's personal data into aggregation
    function mergePersonalDay(dayData, date) {
      if (!dayData) return;
      // Merge organic
      if (dayData.organic) {
        organicAgg.count += (dayData.organic.count || 0);
        organicAgg.revenue += (dayData.organic.revenue || 0);
        organicAgg.newUserRevenue += (dayData.organic.newUserRevenue || 0);
        organicAgg.correctedRevenue += (dayData.organic.revenue || 0);
        organicAgg.correctedNewUserRevenue += (dayData.organic.newUserRevenue || 0);
      }
      // Merge restricted
      if (dayData.restricted) {
        restrictedAgg.count += (dayData.restricted.count || 0);
        restrictedAgg.revenue += (dayData.restricted.revenue || 0);
        restrictedAgg.newUserRevenue += (dayData.restricted.newUserRevenue || 0);
        restrictedAgg.correctedRevenue += (dayData.restricted.revenue || 0);
        restrictedAgg.correctedNewUserRevenue += (dayData.restricted.newUserRevenue || 0);
      }
      // Merge operators
      for (const op of (dayData.operators || [])) {
        if (!operatorAgg[op.operator]) {
          operatorAgg[op.operator] = { operator: op.operator, count: 0, cost: 0, revenue: 0, newUserRevenue: 0, correctedRevenue: 0, correctedNewUserRevenue: 0, products: {} };
        }
        const aggOp = operatorAgg[op.operator];
        aggOp.count += (op.count || 0);
        aggOp.cost += (op.cost || 0);
        aggOp.revenue += (op.revenue || 0);
        aggOp.newUserRevenue += (op.newUserRevenue || 0);

        for (const prod of (op.products || [])) {
          if (!aggOp.products[prod.product]) {
            aggOp.products[prod.product] = { product: prod.product, count: 0, cost: 0, revenue: 0, newUserRevenue: 0, correctedRevenue: 0, correctedNewUserRevenue: 0, channels: {} };
          }
          const aggProd = aggOp.products[prod.product];
          aggProd.count += (prod.count || 0);
          aggProd.cost += (prod.cost || 0);
          aggProd.revenue += (prod.revenue || 0);
          aggProd.newUserRevenue += (prod.newUserRevenue || 0);

          for (const ch of (prod.channels || [])) {
            if (!aggProd.channels[ch.channel]) {
              aggProd.channels[ch.channel] = { channel: ch.channel, count: 0, cost: 0, revenue: 0, newUserRevenue: 0, correctedRevenue: 0, correctedNewUserRevenue: 0, _impressions: 0, _clicks: 0, _campaignMap: {} };
            }
            const aggCh = aggProd.channels[ch.channel];
            aggCh.count += (ch.count || 0);
            aggCh.cost += (ch.cost || 0);
            aggCh.revenue += (ch.revenue || 0);
            aggCh.newUserRevenue += (ch.newUserRevenue || 0);
            // Apply per-day correction factor
            const cf = getCorrFactor(date, prod.product, ch.channel);
            aggCh.correctedRevenue += (ch.revenue || 0) * cf;
            aggCh.correctedNewUserRevenue += (ch.newUserRevenue || 0) * cf;

            // Merge campaigns → adsets → ads
            for (const camp of (ch.campaigns || [])) {
              const campName = (camp.campaign || '').trim();
              if (!aggCh._campaignMap[campName]) {
                aggCh._campaignMap[campName] = { campaign: campName, revenue: 0, newUserRevenue: 0, correctedRevenue: 0, correctedNewUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, installs: 0, _adsetMap: {} };
              }
              const aggCamp = aggCh._campaignMap[campName];
              aggCamp.revenue += (camp.revenue || 0);
              aggCamp.newUserRevenue += (camp.newUserRevenue || 0);
              aggCamp.correctedRevenue += (camp.revenue || 0) * cf;
              aggCamp.correctedNewUserRevenue += (camp.newUserRevenue || 0) * cf;
              aggCamp.cost += (camp.cost || 0);
              aggCamp.impressions += (camp.impressions || 0);
              aggCamp.clicks += (camp.clicks || 0);
              aggCamp.installs += (camp.installs || 0);

              for (const adset of (camp.adsets || [])) {
                if (!aggCamp._adsetMap[adset.adset]) {
                  aggCamp._adsetMap[adset.adset] = { adset: adset.adset, revenue: 0, newUserRevenue: 0, correctedRevenue: 0, correctedNewUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, _adMap: {} };
                }
                const aggAdset = aggCamp._adsetMap[adset.adset];
                aggAdset.revenue += (adset.revenue || 0);
                aggAdset.newUserRevenue += (adset.newUserRevenue || 0);
                aggAdset.correctedRevenue += (adset.revenue || 0) * cf;
                aggAdset.correctedNewUserRevenue += (adset.newUserRevenue || 0) * cf;
                aggAdset.cost += (adset.cost || 0);
                aggAdset.impressions += (adset.impressions || 0);
                aggAdset.clicks += (adset.clicks || 0);

                for (const ad of (adset.ads || [])) {
                  if (!aggAdset._adMap[ad.ad]) {
                    aggAdset._adMap[ad.ad] = { ad: ad.ad, revenue: 0, newUserRevenue: 0, correctedRevenue: 0, correctedNewUserRevenue: 0 };
                  }
                  const aggAd = aggAdset._adMap[ad.ad];
                  aggAd.revenue += (ad.revenue || 0);
                  aggAd.newUserRevenue += (ad.newUserRevenue || 0);
                  aggAd.correctedRevenue += (ad.revenue || 0) * cf;
                  aggAd.correctedNewUserRevenue += (ad.newUserRevenue || 0) * cf;
                }
              }
            }
          }
        }

        // Roll up corrected values to product and operator level
        for (const prodKey of Object.keys(aggOp.products)) {
          const aggProd = aggOp.products[prodKey];
          aggProd.correctedRevenue = Object.values(aggProd.channels).reduce((s, c) => s + (c.correctedRevenue || 0), 0);
          aggProd.correctedNewUserRevenue = Object.values(aggProd.channels).reduce((s, c) => s + (c.correctedNewUserRevenue || 0), 0);
        }
        aggOp.correctedRevenue = Object.values(aggOp.products).reduce((s, p) => s + (p.correctedRevenue || 0), 0);
        aggOp.correctedNewUserRevenue = Object.values(aggOp.products).reduce((s, p) => s + (p.correctedNewUserRevenue || 0), 0);
      }
    }

    // Process each date: use snapshots for historical, live query for today
    for (const d of dates) {
      const daysAgo = daysBefore(today, d);
      
      // Try snapshot first
      const snapshot = loadPersonalSnapshot(d);
      if (snapshot) {
        const meta = snapshot._meta || {};
        delete snapshot._meta;
        
        if (meta.type === 'complete') {
          mergePersonalDay(snapshot, d);
          continue;
        }
        if (meta.type === 'partial' && daysAgo >= 2) {
          // Upgrade partial to complete
          const patch = patchCrossDayNewUsers(snapshot, d);
          if (patch) {
            applyCrossDayPatch(snapshot, patch, d);
            savePersonalSnapshot(d, snapshot, { type: 'complete', upgradedFrom: 'partial' });
          }
          mergePersonalDay(snapshot, d);
          continue;
        }
        if (meta.type === 'partial' && daysAgo === 1) {
          // Live cross-day patch
          const patch = patchCrossDayNewUsers(snapshot, d);
          if (patch) applyCrossDayPatch(snapshot, patch, d);
          mergePersonalDay(snapshot, d);
          continue;
        }
      }
      
      // No snapshot: for today, do live query; for other dates, mark missing
      if (d === today) {
        // Live query for today — make an internal request by calling the handler with single date
        // We'll use a simplified approach: redirect to single-day logic via fetch
        try {
          const singleDayData = await getPersonalDataLive(d);
          if (singleDayData) {
            mergePersonalDay(singleDayData, d);
          } else {
            missingDates.push(d);
          }
        } catch (e) {
          console.error(`[Personal Multi-day] Live query failed for ${d}:`, e.message);
          missingDates.push(d);
        }
      } else {
        missingDates.push(d);
      }
    }

    // Convert aggregated maps to sorted arrays (including campaigns → adsets → ads)
    const operators = Object.values(operatorAgg)
      .map(op => ({
        ...op,
        products: Object.values(op.products)
          .map(p => ({
            ...p,
            channels: Object.values(p.channels)
              .map(c => {
                const totalCost = c.cost || 0;
                // Convert campaign map to sorted array
                const campaigns = Object.values(c._campaignMap || {})
                  .map(camp => ({
                    ...camp,
                    adsets: Object.values(camp._adsetMap || {})
                      .map(adset => ({
                        ...adset,
                        ads: Object.values(adset._adMap || {})
                          .sort((a, b) => b.revenue - a.revenue),
                      }))
                      .sort((a, b) => b.revenue - a.revenue),
                  }))
                  .sort((a, b) => b.cost - a.cost);
                // Clean up internal maps
                const { _campaignMap, _impressions, _clicks, ...rest } = c;
                return {
                  ...rest,
                  cpm: _impressions > 0 ? parseFloat((totalCost / _impressions * 1000).toFixed(2)) : null,
                  cpc: _clicks > 0 ? parseFloat((totalCost / _clicks).toFixed(2)) : null,
                  campaigns,
                };
              })
              .sort((a, b) => b.revenue - a.revenue),
          }))
          .sort((a, b) => b.revenue - a.revenue),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // Clean up internal maps from campaigns/adsets
    for (const op of operators) {
      for (const prod of op.products) {
        for (const ch of prod.channels) {
          for (const camp of ch.campaigns) {
            delete camp._adsetMap;
            for (const adset of (camp.adsets || [])) {
              delete adset._adMap;
            }
          }
        }
      }
    }

    if (db) try { db.close(); } catch (_) {}

    return res.json({
      date: endDate,
      startDate,
      endDate,
      isRange: true,
      missingDates,
      operators,
      organic: organicAgg,
      restricted: restrictedAgg,
    });
  }

  // ── Single-day mode: original logic below ──
  const date = startDate;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid or missing date parameter (YYYY-MM-DD)' });
  }

  const today = todayBeijing();
  const daysAgo = daysBefore(today, date);
  const hour = nowBeijingHour();

  // ── Snapshot cache check ──
  const existing = loadPersonalSnapshot(date);
  if (existing) {
    const meta = existing._meta || {};
    
    if (meta.type === 'complete') {
      // Fully finalized snapshot — use as-is
      console.log(`[Snapshot] Serving complete snapshot for ${date}`);
      delete existing._meta;
      return res.json(existing);
    }
    
    if (meta.type === 'partial' && daysAgo >= 2) {
      // Partial snapshot from yesterday, now it's 2+ days ago → patch cross-day and finalize
      console.log(`[Snapshot] Upgrading partial snapshot for ${date} (now ${daysAgo} days ago)`);
      const patch = patchCrossDayNewUsers(existing, date);
      if (patch) {
        delete existing._meta;
        applyCrossDayPatch(existing, patch, date);
        savePersonalSnapshot(date, existing, { type: 'complete', upgradedFrom: 'partial' });
        return res.json(existing);
      }
      // Patch failed — fall through to full query
      console.error(`[Snapshot] Cross-day patch failed for ${date}, falling back to full query`);
    }
    
    if (meta.type === 'partial' && daysAgo === 1) {
      // Still yesterday — serve partial + live cross-day patch (no save)
      console.log(`[Snapshot] Serving partial snapshot + live cross-day for ${date}`);
      const patch = patchCrossDayNewUsers(existing, date);
      delete existing._meta;
      if (patch) applyCrossDayPatch(existing, patch, date);
      return res.json(existing);
    }
  }

  // ── Full query (original logic) ──

  const tableName = tableForMonth(date);
  let db;
  try {
    db = getPostbackDb();
  } catch (err) {
    return res.status(500).json({ error: 'Cannot connect to postback database: ' + err.message });
  }

  try {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    if (!tableExists) {
      db.close();
      return res.json({ date, operators: [], organic: { count: 0, revenue: 0, newUserRevenue: 0 } });
    }

    // Sargable Beijing-day bounds (index-range scans instead of date()-per-row).
    const dB = beijingDayBounds(date);

    // Get AF paid traffic data (FB/GG/TT) with campaign, for operator matching
    const paidRows = db.prepare(`
      SELECT
        campaign,
        app_id,
        media_source,
        revenue,
        event_time,
        install_time,
        json_extract(payload, '$.af_adset') as af_adset,
        json_extract(payload, '$.af_ad') as af_ad
      FROM ${tableName}
      WHERE event_name = 'af_purchase'
        AND event_time >= ? AND event_time < ?
        AND media_source IN ('Facebook Ads', 'googleadwords_int', 'tiktokglobal_int')
    `).all(dB.strLo, dB.strHi);

    // Get AF new-user-only rows: installed on target date but paid on next day (within 24h)
    // These only contribute to newUserRevenue, not total revenue
    // Note: must compute next date as simple string arithmetic to avoid UTC/timezone issues
    const [y, m, d2] = date.split('-').map(Number);
    const nextDateObj = new Date(y, m - 1, d2 + 1);
    const nextDateStr = nextDateObj.getFullYear() + '-' + String(nextDateObj.getMonth() + 1).padStart(2, '0') + '-' + String(nextDateObj.getDate()).padStart(2, '0');
    const nextTableName = tableForMonth(nextDateStr);
    const nextTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(nextTableName);
    const dBn = beijingDayBounds(nextDateStr);

    const afNewUserExtraRows = [];
    // Same table: install on date, event on next day, diff < 24h
    const afExtraSame = db.prepare(`
      SELECT campaign, app_id, media_source, revenue, event_time, install_time,
        json_extract(payload, '$.af_adset') as af_adset,
        json_extract(payload, '$.af_ad') as af_ad
      FROM ${tableName}
      WHERE event_name = 'af_purchase'
        AND install_time >= ? AND install_time < ?
        AND event_time >= ? AND event_time < ?
        AND media_source IN ('Facebook Ads', 'googleadwords_int', 'tiktokglobal_int')
        AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
        AND (julianday(event_time) - julianday(install_time)) * 24 < 24
    `).all(dB.strLo, dB.strHi, dBn.strLo, dBn.strHi);
    afNewUserExtraRows.push(...afExtraSame);

    // Different table (month boundary): install on date, event on next day in next month table
    if (nextTableExists && nextTableName !== tableName) {
      const afExtraNext = db.prepare(`
        SELECT campaign, app_id, media_source, revenue, event_time, install_time,
          json_extract(payload, '$.af_adset') as af_adset,
          json_extract(payload, '$.af_ad') as af_ad
        FROM ${nextTableName}
        WHERE event_name = 'af_purchase'
          AND install_time >= ? AND install_time < ?
          AND event_time >= ? AND event_time < ?
          AND media_source IN ('Facebook Ads', 'googleadwords_int', 'tiktokglobal_int')
          AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
          AND (julianday(event_time) - julianday(install_time)) * 24 < 24
      `).all(dB.strLo, dB.strHi, dBn.strLo, dBn.strHi);
      afNewUserExtraRows.push(...afExtraNext);
    }

    // Get AF complete_registration counts by campaign (for CPI)
    const afInstallRows = db.prepare(`
      SELECT campaign, COUNT(*) as installs
      FROM ${tableName}
      WHERE event_name = 'af_complete_registration'
        AND event_time >= ? AND event_time < ?
        AND media_source IN ('Facebook Ads', 'googleadwords_int', 'tiktokglobal_int')
      GROUP BY campaign
    `).all(dB.strLo, dB.strHi);
    const afInstallMap = {};
    for (const r of afInstallRows) afInstallMap[(r.campaign || '(unknown)').trim()] = r.installs;

    // Get AD complete_registration counts by campaign (for CPI)
    const adInstallRows = db.prepare(`
      SELECT campaign, COUNT(*) as installs
      FROM ${tableName}
      WHERE event_name = 'ad_complete_registration'
        AND event_time >= ? AND event_time < ?
      GROUP BY campaign
    `).all(dB.epLo, dB.epHi);
    const adInstallMap = {};
    for (const r of adInstallRows) {
      let camp = r.campaign || '';
      try { camp = decodeURIComponent(camp.replace(/\+/g, ' ')); } catch(e) {}
      camp = camp.replace(/\s*\(.*?\)\s*$/, '').trim() || '(unknown)';
      adInstallMap[camp] = (adInstallMap[camp] || 0) + r.installs;
    }

    // Get AF organic summary (excluding restricted)
    const organicRows = db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(revenue), 0) as revenue,
        COALESCE(SUM(CASE WHEN install_time >= ? AND install_time < ? AND (julianday(event_time) - julianday(install_time)) * 24 >= 0 AND (julianday(event_time) - julianday(install_time)) * 24 < 24 THEN revenue ELSE 0 END), 0) as new_user_revenue
      FROM ${tableName}
      WHERE event_name = 'af_purchase'
        AND event_time >= ? AND event_time < ?
        AND media_source = 'organic'
    `).get(dB.strLo, dB.strHi, dB.strLo, dB.strHi);

    // Organic new-user extra: installed on date, paid next day within 24h
    const organicNewUserExtra = db.prepare(`
      SELECT COALESCE(SUM(revenue), 0) as extra
      FROM ${tableName}
      WHERE event_name = 'af_purchase'
        AND install_time >= ? AND install_time < ?
        AND event_time >= ? AND event_time < ?
        AND media_source = 'organic'
        AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
        AND (julianday(event_time) - julianday(install_time)) * 24 < 24
    `).get(dB.strLo, dB.strHi, dBn.strLo, dBn.strHi);

    // Get AF restricted summary separately
    const restrictedRows = db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(revenue), 0) as revenue,
        COALESCE(SUM(CASE WHEN install_time >= ? AND install_time < ? AND (julianday(event_time) - julianday(install_time)) * 24 >= 0 AND (julianday(event_time) - julianday(install_time)) * 24 < 24 THEN revenue ELSE 0 END), 0) as new_user_revenue
      FROM ${tableName}
      WHERE event_name = 'af_purchase'
        AND event_time >= ? AND event_time < ?
        AND media_source = 'restricted'
    `).get(dB.strLo, dB.strHi, dB.strLo, dB.strHi);

    // Restricted new-user extra
    const restrictedNewUserExtra = db.prepare(`
      SELECT COALESCE(SUM(revenue), 0) as extra
      FROM ${tableName}
      WHERE event_name = 'af_purchase'
        AND install_time >= ? AND install_time < ?
        AND event_time >= ? AND event_time < ?
        AND media_source = 'restricted'
        AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
        AND (julianday(event_time) - julianday(install_time)) * 24 < 24
    `).get(dB.strLo, dB.strHi, dBn.strLo, dBn.strHi);

    // Get AD paid traffic data
    const adPaidRows = db.prepare(`
      SELECT
        campaign,
        app_id,
        media_source,
        revenue,
        event_time,
        install_time,
        json_extract(payload, '$.adgroup') as ad_adgroup,
        json_extract(payload, '$.creative') as ad_creative
      FROM ${tableName}
      WHERE event_name = 'ad_purchase'
        AND event_time >= ? AND event_time < ?
    `).all(dB.epLo, dB.epHi);

    // Get AD new-user-only rows: installed on date but paid next day (within 24h)
    const adNewUserExtraRows = [];
    const adExtraSame = db.prepare(`
      SELECT campaign, app_id, media_source, revenue, event_time, install_time,
        json_extract(payload, '$.adgroup') as ad_adgroup,
        json_extract(payload, '$.creative') as ad_creative
      FROM ${tableName}
      WHERE event_name = 'ad_purchase'
        AND install_time >= ? AND install_time < ?
        AND event_time >= ? AND event_time < ?
        AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) >= 0
        AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) < 86400
    `).all(dB.epLo, dB.epHi, dBn.epLo, dBn.epHi);
    adNewUserExtraRows.push(...adExtraSame);

    if (nextTableExists && nextTableName !== tableName) {
      const adExtraNext = db.prepare(`
        SELECT campaign, app_id, media_source, revenue, event_time, install_time,
          json_extract(payload, '$.adgroup') as ad_adgroup,
          json_extract(payload, '$.creative') as ad_creative
        FROM ${nextTableName}
        WHERE event_name = 'ad_purchase'
          AND install_time >= ? AND install_time < ?
          AND event_time >= ? AND event_time < ?
          AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) >= 0
          AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) < 86400
      `).all(dB.epLo, dB.epHi, dBn.epLo, dBn.epHi);
      adNewUserExtraRows.push(...adExtraNext);
    }

    // Process paid rows: group by operator → product → channel
    const operatorMap = {};

    // Process AF paid rows
    for (const row of paidRows) {
      const operator = matchOperator(row.campaign) || 'other';
      const productName = APP_ID_MAP[row.app_id] || row.app_id;
      const channelName = mapMediaSource(row.media_source);
      const rev = row.revenue || 0;

      // New user: install_time is on target date (Beijing) AND event within 24h of install
      let isNewUser = false;
      if (row.install_time && row.event_time) {
        const eventDate = new Date(row.event_time.replace(' ', 'T') + 'Z');
        const installDate = new Date(row.install_time.replace(' ', 'T') + 'Z');
        const installBeijingDay = new Date(installDate.getTime() + 8 * 3600000).toISOString().slice(0, 10);
        const diffHours = (eventDate - installDate) / 3600000;
        isNewUser = (installBeijingDay === date && diffHours >= 0 && diffHours < 24);
      }

      if (!operatorMap[operator]) {
        operatorMap[operator] = { operator, count: 0, revenue: 0, newUserRevenue: 0, products: {} };
      }
      operatorMap[operator].count += 1;
      operatorMap[operator].revenue += rev;
      if (isNewUser) operatorMap[operator].newUserRevenue += rev;

      const prodKey = productName;
      if (!operatorMap[operator].products[prodKey]) {
        operatorMap[operator].products[prodKey] = { product: productName, count: 0, revenue: 0, newUserRevenue: 0, channels: {} };
      }
      operatorMap[operator].products[prodKey].count += 1;
      operatorMap[operator].products[prodKey].revenue += rev;
      if (isNewUser) operatorMap[operator].products[prodKey].newUserRevenue += rev;

      if (!operatorMap[operator].products[prodKey].channels[channelName]) {
        operatorMap[operator].products[prodKey].channels[channelName] = { channel: channelName, count: 0, revenue: 0, newUserRevenue: 0, campaigns: {} };
      }
      operatorMap[operator].products[prodKey].channels[channelName].count += 1;
      operatorMap[operator].products[prodKey].channels[channelName].revenue += rev;
      if (isNewUser) operatorMap[operator].products[prodKey].channels[channelName].newUserRevenue += rev;
      const afCampKey = (row.campaign || '(unknown)').trim();
      const afCamps = operatorMap[operator].products[prodKey].channels[channelName].campaigns;
      if (!afCamps[afCampKey]) afCamps[afCampKey] = { campaign: afCampKey, revenue: 0, newUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, installs: 0, adsets: {} };
      afCamps[afCampKey].installs = afInstallMap[afCampKey] || 0;
      afCamps[afCampKey].revenue += rev;
      if (isNewUser) afCamps[afCampKey].newUserRevenue += rev;
      const afAdsetKey = normAdset(row.af_adset) || '(unknown)';
      if (!afCamps[afCampKey].adsets[afAdsetKey]) afCamps[afCampKey].adsets[afAdsetKey] = { adset: afAdsetKey, revenue: 0, newUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, ads: {} };
      afCamps[afCampKey].adsets[afAdsetKey].revenue += rev;
      if (isNewUser) afCamps[afCampKey].adsets[afAdsetKey].newUserRevenue += rev;
      const afAdKey = row.af_ad || '(unknown)';
      if (!afCamps[afCampKey].adsets[afAdsetKey].ads[afAdKey]) afCamps[afCampKey].adsets[afAdsetKey].ads[afAdKey] = { ad: afAdKey, revenue: 0, newUserRevenue: 0 };
      afCamps[afCampKey].adsets[afAdsetKey].ads[afAdKey].revenue += rev;
      if (isNewUser) afCamps[afCampKey].adsets[afAdsetKey].ads[afAdKey].newUserRevenue += rev;
    }

    // Process AF extra new-user rows: only contribute to newUserRevenue, not count/revenue
    for (const row of afNewUserExtraRows) {
      const operator = matchOperator(row.campaign) || 'other';
      const productName = APP_ID_MAP[row.app_id] || row.app_id;
      const channelName = mapMediaSource(row.media_source);
      const rev = row.revenue || 0;

      if (!operatorMap[operator]) {
        operatorMap[operator] = { operator, count: 0, revenue: 0, newUserRevenue: 0, products: {} };
      }
      operatorMap[operator].newUserRevenue += rev;

      const prodKey = productName;
      if (!operatorMap[operator].products[prodKey]) {
        operatorMap[operator].products[prodKey] = { product: productName, count: 0, revenue: 0, newUserRevenue: 0, channels: {} };
      }
      operatorMap[operator].products[prodKey].newUserRevenue += rev;

      if (!operatorMap[operator].products[prodKey].channels[channelName]) {
        operatorMap[operator].products[prodKey].channels[channelName] = { channel: channelName, count: 0, revenue: 0, newUserRevenue: 0, campaigns: {} };
      }
      operatorMap[operator].products[prodKey].channels[channelName].newUserRevenue += rev;

      const afCampKey = (row.campaign || '(unknown)').trim();
      const afCamps = operatorMap[operator].products[prodKey].channels[channelName].campaigns;
      if (!afCamps[afCampKey]) afCamps[afCampKey] = { campaign: afCampKey, revenue: 0, newUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, installs: 0, adsets: {} };
      afCamps[afCampKey].newUserRevenue += rev;

      const afAdsetKey = normAdset(row.af_adset) || '(unknown)';
      if (!afCamps[afCampKey].adsets[afAdsetKey]) afCamps[afCampKey].adsets[afAdsetKey] = { adset: afAdsetKey, revenue: 0, newUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, ads: {} };
      afCamps[afCampKey].adsets[afAdsetKey].newUserRevenue += rev;

      const afAdKey = row.af_ad || '(unknown)';
      if (!afCamps[afCampKey].adsets[afAdsetKey].ads[afAdKey]) afCamps[afCampKey].adsets[afAdsetKey].ads[afAdKey] = { ad: afAdKey, revenue: 0, newUserRevenue: 0 };
      afCamps[afCampKey].adsets[afAdsetKey].ads[afAdKey].newUserRevenue += rev;
    }

    // Process AD paid rows (and separate organic)
    let adOrganicCount = 0, adOrganicRevenue = 0, adOrganicNewUserRevenue = 0;

    for (const row of adPaidRows) {
      const mediaSource = row.media_source || '';
      const rev = row.revenue || 0;

      // Decode campaign for operator matching
      let campaign = row.campaign || '';
      try { campaign = decodeURIComponent(campaign.replace(/\+/g, ' ')); } catch(e) {}
      campaign = campaign.replace(/\s*\(.*?\)\s*$/, '').trim();

      // Check if new user: install_time on target date (Beijing) AND event within 24h
      let isNewUser = false;
      if (row.install_time && row.event_time) {
        const eventTs = parseInt(row.event_time);
        const installTs = parseInt(row.install_time);
        if (!isNaN(eventTs) && !isNaN(installTs)) {
          const installBeijingDay = new Date((installTs + 8 * 3600) * 1000).toISOString().slice(0, 10);
          const diffHours = (eventTs - installTs) / 3600;
          isNewUser = (installBeijingDay === date && diffHours >= 0 && diffHours < 24);
        }
      }

      // Check if organic/unattributed
      if (AD_ORGANIC_SOURCES.has(mediaSource)) {
        adOrganicCount += 1;
        adOrganicRevenue += rev;
        if (isNewUser) adOrganicNewUserRevenue += rev;
        continue;
      }

      // Paid: match operator from campaign
      const operator = matchOperator(campaign) || 'other';
      const productName = APP_ID_MAP[row.app_id] || row.app_id;
      const channelName = mapMediaSource(mediaSource);

      if (!operatorMap[operator]) {
        operatorMap[operator] = { operator, count: 0, revenue: 0, newUserRevenue: 0, products: {} };
      }
      operatorMap[operator].count += 1;
      operatorMap[operator].revenue += rev;
      if (isNewUser) operatorMap[operator].newUserRevenue += rev;

      const prodKey = productName;
      if (!operatorMap[operator].products[prodKey]) {
        operatorMap[operator].products[prodKey] = { product: productName, count: 0, revenue: 0, newUserRevenue: 0, channels: {} };
      }
      operatorMap[operator].products[prodKey].count += 1;
      operatorMap[operator].products[prodKey].revenue += rev;
      if (isNewUser) operatorMap[operator].products[prodKey].newUserRevenue += rev;

      if (!operatorMap[operator].products[prodKey].channels[channelName]) {
        operatorMap[operator].products[prodKey].channels[channelName] = { channel: channelName, count: 0, revenue: 0, newUserRevenue: 0, campaigns: {} };
      }
      operatorMap[operator].products[prodKey].channels[channelName].count += 1;
      operatorMap[operator].products[prodKey].channels[channelName].revenue += rev;
      if (isNewUser) operatorMap[operator].products[prodKey].channels[channelName].newUserRevenue += rev;
      const adCampKey = campaign || '(unknown)';
      const adCamps = operatorMap[operator].products[prodKey].channels[channelName].campaigns;
      if (!adCamps[adCampKey]) adCamps[adCampKey] = { campaign: adCampKey, revenue: 0, newUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, installs: 0, adsets: {} };
      adCamps[adCampKey].installs = adInstallMap[adCampKey] || 0;
      adCamps[adCampKey].revenue += rev;
      if (isNewUser) adCamps[adCampKey].newUserRevenue += rev;
      const adAdsetKey = normAdset(row.ad_adgroup) || '(unknown)';
      if (!adCamps[adCampKey].adsets[adAdsetKey]) adCamps[adCampKey].adsets[adAdsetKey] = { adset: adAdsetKey, revenue: 0, newUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, ads: {} };
      adCamps[adCampKey].adsets[adAdsetKey].revenue += rev;
      if (isNewUser) adCamps[adCampKey].adsets[adAdsetKey].newUserRevenue += rev;
      const adAdKey = row.ad_creative ? decodeURIComponent(row.ad_creative).replace(/\s*\(.*?\)\s*$/, '').trim() : '(unknown)';
      if (!adCamps[adCampKey].adsets[adAdsetKey].ads[adAdKey]) adCamps[adCampKey].adsets[adAdsetKey].ads[adAdKey] = { ad: adAdKey, revenue: 0, newUserRevenue: 0 };
      adCamps[adCampKey].adsets[adAdsetKey].ads[adAdKey].revenue += rev;
      if (isNewUser) adCamps[adCampKey].adsets[adAdsetKey].ads[adAdKey].newUserRevenue += rev;
    }

    // Process AD extra new-user rows: only contribute to newUserRevenue
    for (const row of adNewUserExtraRows) {
      const mediaSource = row.media_source || '';
      const rev = row.revenue || 0;
      let campaign = row.campaign || '';
      try { campaign = decodeURIComponent(campaign.replace(/\+/g, ' ')); } catch(e) {}
      campaign = campaign.replace(/\s*\(.*?\)\s*$/, '').trim();

      if (AD_ORGANIC_SOURCES.has(mediaSource)) {
        adOrganicNewUserRevenue += rev;
        continue;
      }

      const operator = matchOperator(campaign) || 'other';
      const productName = APP_ID_MAP[row.app_id] || row.app_id;
      const channelName = mapMediaSource(mediaSource);

      if (!operatorMap[operator]) {
        operatorMap[operator] = { operator, count: 0, revenue: 0, newUserRevenue: 0, products: {} };
      }
      operatorMap[operator].newUserRevenue += rev;

      const prodKey = productName;
      if (!operatorMap[operator].products[prodKey]) {
        operatorMap[operator].products[prodKey] = { product: productName, count: 0, revenue: 0, newUserRevenue: 0, channels: {} };
      }
      operatorMap[operator].products[prodKey].newUserRevenue += rev;

      if (!operatorMap[operator].products[prodKey].channels[channelName]) {
        operatorMap[operator].products[prodKey].channels[channelName] = { channel: channelName, count: 0, revenue: 0, newUserRevenue: 0, campaigns: {} };
      }
      operatorMap[operator].products[prodKey].channels[channelName].newUserRevenue += rev;

      const adCampKey = campaign || '(unknown)';
      const adCamps = operatorMap[operator].products[prodKey].channels[channelName].campaigns;
      if (!adCamps[adCampKey]) adCamps[adCampKey] = { campaign: adCampKey, revenue: 0, newUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, installs: 0, adsets: {} };
      adCamps[adCampKey].newUserRevenue += rev;

      const adAdsetKey = normAdset(row.ad_adgroup) || '(unknown)';
      if (!adCamps[adCampKey].adsets[adAdsetKey]) adCamps[adCampKey].adsets[adAdsetKey] = { adset: adAdsetKey, revenue: 0, newUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, ads: {} };
      adCamps[adCampKey].adsets[adAdsetKey].newUserRevenue += rev;

      const adAdKey = row.ad_creative ? decodeURIComponent(row.ad_creative).replace(/\s*\(.*?\)\s*$/, '').trim() : '(unknown)';
      if (!adCamps[adCampKey].adsets[adAdsetKey].ads[adAdKey]) adCamps[adCampKey].adsets[adAdsetKey].ads[adAdKey] = { ad: adAdKey, revenue: 0, newUserRevenue: 0 };
      adCamps[adCampKey].adsets[adAdsetKey].ads[adAdKey].newUserRevenue += rev;
    }

    // Fetch XMP campaign cost data and merge into operator map
    // If this date will be saved as a partial snapshot (yesterday, first visit after 6am),
    // force a fresh XMP fetch to capture the full day's spend (not stale 23:05 cache).
    const willSavePartial = daysAgo === 1 && hour >= 6 && !existing;
    let xmpCampaigns = [];
    try {
      xmpCampaigns = await fetchXmpCampaigns(date, { staleOk: !willSavePartial, needAdset: true });
    } catch (xmpErr) {
      console.error('[API] XMP fetch failed for personal panel:', xmpErr.message);
    }

    // Group XMP cost by operator → product → channel
    let xmpAdsetMatched = 0, xmpAdsetUnknown = 0, xmpCostMatched = 0, xmpCostUnknown = 0;
    for (const xmpRow of xmpCampaigns) {
      const operator = matchOperator(xmpRow.campaign) || 'other';
      if (!operatorMap[operator]) {
        operatorMap[operator] = { operator, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, products: {} };
      }
      if (operatorMap[operator].cost == null) operatorMap[operator].cost = 0;
      operatorMap[operator].cost += xmpRow.cost;

      const prodKey = xmpRow.product;
      if (!operatorMap[operator].products[prodKey]) {
        operatorMap[operator].products[prodKey] = { product: prodKey, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, channels: {} };
      }
      if (operatorMap[operator].products[prodKey].cost == null) operatorMap[operator].products[prodKey].cost = 0;
      operatorMap[operator].products[prodKey].cost += xmpRow.cost;

      const chKey = xmpRow.channel;
      if (!operatorMap[operator].products[prodKey].channels[chKey]) {
        operatorMap[operator].products[prodKey].channels[chKey] = { channel: chKey, count: 0, revenue: 0, newUserRevenue: 0, cost: 0, _impressions: 0, _clicks: 0, campaigns: {} };
      }
      if (operatorMap[operator].products[prodKey].channels[chKey].cost == null) operatorMap[operator].products[prodKey].channels[chKey].cost = 0;
      operatorMap[operator].products[prodKey].channels[chKey].cost += xmpRow.cost;
      operatorMap[operator].products[prodKey].channels[chKey]._impressions += xmpRow.impressions;
      operatorMap[operator].products[prodKey].channels[chKey]._clicks += xmpRow.clicks;
      // Aggregate XMP cost/impressions/clicks by campaign
      const xmpCampKey = (xmpRow.campaign || '(unknown)').trim();
      const xmpCamps = operatorMap[operator].products[prodKey].channels[chKey].campaigns;
      if (!xmpCamps[xmpCampKey]) xmpCamps[xmpCampKey] = { campaign: xmpCampKey, revenue: 0, newUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, installs: 0, adsets: {} };
      xmpCamps[xmpCampKey].cost += xmpRow.cost;
      xmpCamps[xmpCampKey].impressions += xmpRow.impressions;
      xmpCamps[xmpCampKey].clicks += xmpRow.clicks;
      // Inject XMP cost onto the adset node. Join key = normAdset(adset name), which
      // matches the AF/AD adset keys built above. Matched → existing DB adset node;
      // unmatched (zero-payment groups, pwa/test, etc.) → the campaign's '(unknown)'
      // adset so no spend is silently dropped. Σ adset.cost == campaign.cost holds.
      const xmpAdsets = xmpCamps[xmpCampKey].adsets;
      const normKey = normAdset(xmpRow.adset);
      const adsetKey = (normKey && xmpAdsets[normKey]) ? normKey : '(unknown)';
      if (normKey && xmpAdsets[normKey]) { xmpAdsetMatched++; xmpCostMatched += xmpRow.cost; }
      else { xmpAdsetUnknown++; xmpCostUnknown += xmpRow.cost; }
      if (!xmpAdsets[adsetKey]) xmpAdsets[adsetKey] = { adset: adsetKey, revenue: 0, newUserRevenue: 0, cost: 0, impressions: 0, clicks: 0, ads: {} };
      xmpAdsets[adsetKey].cost += xmpRow.cost;
      xmpAdsets[adsetKey].impressions += xmpRow.impressions;
      xmpAdsets[adsetKey].clicks += xmpRow.clicks;
    }
    if (xmpCampaigns.length > 0) {
      const totCost = xmpCostMatched + xmpCostUnknown;
      const pct = totCost > 0 ? (xmpCostMatched / totCost * 100).toFixed(1) : '0.0';
      console.log(`[XMP adset] ${date}: rows matched=${xmpAdsetMatched} unknown=${xmpAdsetUnknown}; cost matched=$${xmpCostMatched.toFixed(2)} unknown=$${xmpCostUnknown.toFixed(2)} (${pct}% matched)`);
    }

    // Convert to sorted arrays
    const operators = Object.values(operatorMap)
      .map(op => ({
        ...op,
        cost: op.cost || 0,
        products: Object.values(op.products)
          .map(p => ({
            ...p,
            cost: p.cost || 0,
            channels: Object.values(p.channels)
              .map(c => {
                const camps = Object.values(c.campaigns || {});
                const totalImp = camps.reduce((s, camp) => s + (camp.impressions || 0), 0);
                const totalClk = camps.reduce((s, camp) => s + (camp.clicks || 0), 0);
                const totalCost = c.cost || 0;
                return {
                  ...c,
                  cost: totalCost,
                  cpm: totalImp > 0 ? parseFloat((totalCost / totalImp * 1000).toFixed(2)) : null,
                  cpc: totalClk > 0 ? parseFloat((totalCost / totalClk).toFixed(2)) : null,
                  campaigns: camps
                  .map(camp => ({
                    ...camp,
                    adsets: Object.values(camp.adsets || {})
                      .map(adset => ({
                        ...adset,
                        ads: Object.values(adset.ads || {}).sort((a, b) => b.revenue - a.revenue),
                      }))
                      .sort((a, b) => b.revenue - a.revenue),
                  }))
                  .sort((a, b) => (b.cost + b.revenue) - (a.cost + a.revenue)),
                };
              })
              .sort((a, b) => b.revenue - a.revenue),
          }))
          .sort((a, b) => b.revenue - a.revenue),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const responseData = {
      date,
      operators,
      organic: {
        count: organicRows.count + adOrganicCount,
        revenue: organicRows.revenue + adOrganicRevenue,
        newUserRevenue: organicRows.new_user_revenue + (organicNewUserExtra ? organicNewUserExtra.extra : 0) + adOrganicNewUserRevenue,
      },
      restricted: {
        count: restrictedRows.count,
        revenue: restrictedRows.revenue,
        newUserRevenue: restrictedRows.new_user_revenue + (restrictedNewUserExtra ? restrictedNewUserExtra.extra : 0),
      },
    };

    // ── Snapshot save logic ──
    const hasCost = responseHasReasonableCost(responseData);
    if (daysAgo >= 2 && hasCost) {
      // 2+ days ago: cross-day new users fully settled, save complete.
      // STRICT: require all 3 channels (FB/GG/TT) to have cost — a missing
      // channel means the XMP fetch was incomplete. We NEVER store an
      // incomplete snapshot as complete (incomplete data is worse than none).
      // Historical XMP gaps are fixed out-of-band by backfilling the XMP cache
      // then rebuilding, not by relaxing this check.
      savePersonalSnapshot(date, responseData, { type: 'complete' });
    } else if (daysAgo === 1 && hour >= 6 && hasCost && !existing) {
      // Yesterday, after 6am, all channels present, no existing snapshot:
      // Save a version WITHOUT cross-day extras as partial.
      // To get the base (without cross-day), subtract the extras we added.
      const baseCopy = JSON.parse(JSON.stringify(responseData));
      // Subtract AF cross-day extras
      for (const row of afNewUserExtraRows) {
        const operator = matchOperator(row.campaign) || 'other';
        const productName = APP_ID_MAP[row.app_id] || row.app_id;
        const channelName = mapMediaSource(row.media_source);
        const rev = row.revenue || 0;
        const op = baseCopy.operators.find(o => o.operator === operator);
        if (op) {
          op.newUserRevenue = (op.newUserRevenue || 0) - rev;
          const prod = (op.products || []).find(p => p.product === productName);
          if (prod) {
            prod.newUserRevenue = (prod.newUserRevenue || 0) - rev;
            const ch = (prod.channels || []).find(c => c.channel === channelName);
            if (ch) {
              ch.newUserRevenue = (ch.newUserRevenue || 0) - rev;
              const campKey = (row.campaign || '(unknown)').trim();
              const camp = (ch.campaigns || []).find(c => c.campaign === campKey);
              if (camp) camp.newUserRevenue = (camp.newUserRevenue || 0) - rev;
            }
          }
        }
      }
      // Subtract AD cross-day extras
      for (const row of adNewUserExtraRows) {
        const mediaSource = row.media_source || '';
        if (AD_ORGANIC_SOURCES.has(mediaSource)) continue;
        const rev = row.revenue || 0;
        let campaign = row.campaign || '';
        try { campaign = decodeURIComponent(campaign.replace(/\+/g, ' ')); } catch(e) {}
        campaign = campaign.replace(/\s*\(.*?\)\s*$/, '').trim();
        const operator = matchOperator(campaign) || 'other';
        const productName = APP_ID_MAP[row.app_id] || row.app_id;
        const channelName = mapMediaSource(mediaSource);
        const op = baseCopy.operators.find(o => o.operator === operator);
        if (op) {
          op.newUserRevenue = (op.newUserRevenue || 0) - rev;
          const prod = (op.products || []).find(p => p.product === productName);
          if (prod) {
            prod.newUserRevenue = (prod.newUserRevenue || 0) - rev;
            const ch = (prod.channels || []).find(c => c.channel === channelName);
            if (ch) {
              ch.newUserRevenue = (ch.newUserRevenue || 0) - rev;
              const campKey = campaign || '(unknown)';
              const camp = (ch.campaigns || []).find(c => c.campaign === campKey);
              if (camp) camp.newUserRevenue = (camp.newUserRevenue || 0) - rev;
            }
          }
        }
      }
      // Subtract organic/restricted cross-day extras
      if (organicNewUserExtra && baseCopy.organic) {
        baseCopy.organic.newUserRevenue = (baseCopy.organic.newUserRevenue || 0) - (organicNewUserExtra.extra || 0);
      }
      if (restrictedNewUserExtra && baseCopy.restricted) {
        baseCopy.restricted.newUserRevenue = (baseCopy.restricted.newUserRevenue || 0) - (restrictedNewUserExtra.extra || 0);
      }
      savePersonalSnapshot(date, baseCopy, { type: 'partial' });
    }

    res.json(responseData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

app.get('/api/postback/dates', authCheck, (req, res) => {
  let db;
  try {
    db = getPostbackDb();
  } catch (err) {
    return res.status(500).json({ error: 'Cannot connect to postback database: ' + err.message });
  }

  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' ORDER BY name").all();
    const dates = [];
    for (const { name: tbl } of tables) {
      const dayRows = db.prepare(`
        SELECT DISTINCT date(event_time, '+8 hours') as dt 
        FROM ${tbl} 
        WHERE event_name = 'af_purchase'
        ORDER BY dt DESC
      `).all();
      for (const r of dayRows) {
        if (r.dt) dates.push(r.dt);
      }
    }
    dates.sort().reverse();
    res.json(dates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    db.close();
  }
});

app.post('/api/refresh', authCheck, async (req, res) => {
  const status = fetcher.getStatus();
  if (status.isFetching) return res.status(409).json({ error: 'Fetch already in progress' });
  res.json({ message: 'Fetch started' });
  try {
    await fetcher.fetchAll();
    console.log('[Server] Manual fetch completed');
  } catch (err) {
    console.error('[Server] Manual fetch error:', err.message);
  }
});

// ══════════════════════════════════════════════════════════
// Creative Panel API
// ══════════════════════════════════════════════════════════

// In-memory flag to track if today's daily fetch has run
let creativeDailyFetchDone = null; // date string of last completed daily fetch
let creativeFetchInProgress = null; // date string of a fetch currently running in background

function getCreativeDataDir() {
  return path.join(__dirname, 'data');
}

function loadCreativeFile(dateStr) {
  const filePath = path.join(getCreativeDataDir(), `creative-${dateStr}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Aggregation result cache keyed by the window's date list. Each entry records a
// fingerprint of the source files' mtimes; when any file changes (e.g. the
// background daily fetch rewrites yesterday's file) or a missing file appears,
// the fingerprint no longer matches and the window is recomputed. Process-local,
// cleared on restart — no persistence needed.
const _creativeAggCache = new Map(); // dateKey -> { fingerprint, result }

function creativeWindowFingerprint(dates) {
  return dates.map(d => {
    try {
      const st = fs.statSync(path.join(getCreativeDataDir(), `creative-${d}.json`));
      return `${d}:${st.mtimeMs}`;
    } catch (e) {
      return `${d}:0`; // file missing — still part of the fingerprint
    }
  }).join('|');
}

// Aggregate an N-day window of creative data for the panel, keyed by
// product + normalized name + channel (mirrors aggregateAigcDays). Tolerant of
// legacy creative-*.json files (old shape: `key`/designer/series, no name/product)
// so a 7/14-day window that spans pre-migration files still renders them.
// Results are cached per window and invalidated when any source file's mtime
// changes; the returned {fb, tt} structure is identical to the uncached path.
function aggregateCreativeDays(dates) {
  const dateKey = dates.join(',');
  const fingerprint = creativeWindowFingerprint(dates);
  const cached = _creativeAggCache.get(dateKey);
  if (cached && cached.fingerprint === fingerprint) {
    console.log(`[Creative] Aggregation cache hit for window ${dateKey}`);
    return cached.result;
  }

  const fbMap = new Map();
  const ttMap = new Map();

  for (const dateStr of dates) {
    const data = loadCreativeFile(dateStr);
    if (!data || !data.creatives) continue;

    for (const c of data.creatives) {
      const map = c.channel === 'FB' ? fbMap : c.channel === 'TT' ? ttMap : null;
      if (!map) continue;

      // Legacy rows have no `name` — fall back to the old `key` so nothing drops.
      const name = c.name || c.key || '';
      const product = c.product || '';
      const mapKey = `${product}::${name}`;
      if (!map.has(mapKey)) {
        map.set(mapKey, {
          name,
          product,
          designer: c.designer || '',
          series: c.series || '',
          number: c.number || '',
          date: c.date || '',
          channel: c.channel,
          cost: 0,
          impressions: 0,
          clicks: 0,
          newUserRevenue: 0,
        });
      }
      const agg = map.get(mapKey);
      if (!agg.product && product) agg.product = product;
      agg.cost += c.cost || 0;
      agg.impressions += c.impressions || 0;
      agg.clicks += c.clicks || 0;
      agg.newUserRevenue += c.newUserRevenue || 0;
    }
  }

  const result = {
    fb: Array.from(fbMap.values()),
    tt: Array.from(ttMap.values()),
  };
  _creativeAggCache.set(dateKey, { fingerprint, result });
  console.log(`[Creative] Aggregation computed for window ${dateKey}`);
  return result;
}

const CREATIVE_ALLOWED_WINDOWS = [3, 7, 14];

app.get('/api/creative/data', authCheck, async (req, res) => {
  try {
    let days = parseInt(req.query.days, 10);
    if (!CREATIVE_ALLOWED_WINDOWS.includes(days)) days = 3;

    const today = creativeModule.todayBeijing();
    // Build the N-day window of complete days: [today-days, ..., today-1]
    const dates = [];
    for (let i = days; i >= 1; i--) dates.push(creativeModule.prevDate(today, i));

    // First visit of the day: trigger yesterday's fetch if missing
    const yesterday = dates[dates.length - 1];
    const yesterdayFile = path.join(getCreativeDataDir(), `creative-${yesterday}.json`);

    if (!fs.existsSync(yesterdayFile) && creativeDailyFetchDone !== today && creativeFetchInProgress !== yesterday) {
      // Yesterday's data is missing: fetch it in the BACKGROUND (fire-and-forget)
      // instead of awaiting here — awaiting would block the whole single-threaded
      // server for the tens of seconds the XMP+AF fetch takes. This request returns
      // immediately with whatever data files already exist (the missing day shows up
      // in missingDates so the UI can warn); the fetched file lands on disk for the
      // next request, which then picks it up (and the mtime change invalidates the
      // aggregation cache automatically).
      console.log(`[Creative] Daily fetch triggered (background) for ${yesterday}`);
      creativeFetchInProgress = yesterday; // guard against concurrent duplicate triggers
      creativeModule.fetchAndSaveDate(yesterday)
        .then(() => {
          creativeDailyFetchDone = today;
          console.log(`[Creative] Daily fetch completed for ${yesterday}`);
        })
        .catch((err) => {
          console.error(`[Creative] Daily fetch failed for ${yesterday}:`, err.message);
        })
        .finally(() => {
          creativeFetchInProgress = null;
        });
    } else if (fs.existsSync(yesterdayFile)) {
      creativeDailyFetchDone = today;
    }

    // Aggregate the window
    const aggregated = aggregateCreativeDays(dates);

    // Report which days in the window have no data file (so the UI can warn).
    const missingDates = dates.filter(
      d => !fs.existsSync(path.join(getCreativeDataDir(), `creative-${d}.json`))
    );

    res.json({
      days,
      dates,
      missingDates,
      dateRange: `${dates[0]} ~ ${dates[dates.length - 1]}`,
      fb: aggregated.fb,
      tt: aggregated.tt,
    });
  } catch (err) {
    console.error('[Creative] API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// AIGC Material Panel API
// (Parallel to creative panel; keys by FULL raw material name,
//  AIGC-filtered upstream in fetch-creative-data.js.)
// ══════════════════════════════════════════════════════════

let aigcDailyFetchDone = null; // date string of last completed daily AIGC fetch

function loadAigcFile(dateStr) {
  const filePath = path.join(getCreativeDataDir(), `aigc-${dateStr}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

// Aggregate 3 days of AIGC data, keyed by full material name + channel.
function aggregateAigcDays(dates) {
  const fbMap = new Map();
  const ttMap = new Map();

  for (const dateStr of dates) {
    const data = loadAigcFile(dateStr);
    if (!data || !data.creatives) continue;

    for (const c of data.creatives) {
      const map = c.channel === 'FB' ? fbMap : c.channel === 'TT' ? ttMap : null;
      if (!map) continue;

      // Key by product + name so the same material under different products stays distinct.
      const key = `${c.product || ''}::${c.name}`;
      if (!map.has(key)) {
        map.set(key, {
          name: c.name,
          product: c.product || '',
          channel: c.channel,
          cost: 0,
          impressions: 0,
          clicks: 0,
          newUserRevenue: 0,
        });
      }
      const agg = map.get(key);
      if (!agg.product && c.product) agg.product = c.product;
      agg.cost += c.cost || 0;
      agg.impressions += c.impressions || 0;
      agg.clicks += c.clicks || 0;
      agg.newUserRevenue += c.newUserRevenue || 0;
    }
  }

  return {
    fb: Array.from(fbMap.values()),
    tt: Array.from(ttMap.values()),
  };
}

const AIGC_ALLOWED_WINDOWS = [3, 7, 14];

app.get('/api/aigc/data', authCheck, async (req, res) => {
  try {
    let days = parseInt(req.query.days, 10);
    if (!AIGC_ALLOWED_WINDOWS.includes(days)) days = 3;

    const today = creativeModule.todayBeijing();
    // Build the N-day window of complete days: [today-days, ..., today-1]
    const dates = [];
    for (let i = days; i >= 1; i--) dates.push(creativeModule.prevDate(today, i));

    // First visit of the day: trigger yesterday's AIGC fetch if missing
    const yesterday = dates[dates.length - 1];
    const yesterdayFile = path.join(getCreativeDataDir(), `aigc-${yesterday}.json`);

    if (!fs.existsSync(yesterdayFile) && aigcDailyFetchDone !== today) {
      console.log(`[AIGC] Daily fetch triggered for ${yesterday}`);
      try {
        await creativeModule.fetchAndSaveAigcDate(yesterday);
        aigcDailyFetchDone = today;
        console.log(`[AIGC] Daily fetch completed for ${yesterday}`);
      } catch (err) {
        console.error(`[AIGC] Daily fetch failed for ${yesterday}:`, err.message);
      }
    } else if (fs.existsSync(yesterdayFile)) {
      aigcDailyFetchDone = today;
    }

    const aggregated = aggregateAigcDays(dates);

    // Report which days in the window have no data file (so the UI can warn).
    const missingDates = dates.filter(
      d => !fs.existsSync(path.join(getCreativeDataDir(), `aigc-${d}.json`))
    );

    res.json({
      days,
      dates,
      missingDates,
      dateRange: `${dates[0]} ~ ${dates[dates.length - 1]}`,
      fb: aggregated.fb,
      tt: aggregated.tt,
    });
  } catch (err) {
    console.error('[AIGC] API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Schedule hourly fetch aligned to wall-clock time
// Uses self-correcting setTimeout instead of setInterval to prevent drift on restarts
function scheduleHourlyFetch() {
  // Helper: ms until next occurrence of mm:00 (Beijing time)
  function msUntilNextMinute(targetMinute) {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(targetMinute, 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next - now;
  }

  // Summary fetch: aligned to xx:00
  function scheduleSummary() {
    const ms = msUntilNextMinute(0);
    const nextTime = new Date(Date.now() + ms);
    console.log(`[Scheduler] Next summary fetch in ${Math.round(ms / 60000)} min (at ${nextTime.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })})`);
    setTimeout(async () => {
      try {
        await fetcher.fetchAll();
      } catch (err) {
        console.error('[Scheduler] Fetch error:', err.message);
      }
      scheduleSummary(); // re-schedule for next hour
    }, ms);
  }

  // XMP campaign cache warm: aligned to xx:05
  function scheduleXmpWarm() {
    const ms = msUntilNextMinute(5);
    const nextTime = new Date(Date.now() + ms);
    console.log(`[Scheduler] Next XMP cache warm in ${Math.round(ms / 60000)} min (at ${nextTime.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })})`);
    setTimeout(async () => {
      try {
        const today = todayBeijing();
        console.log(`[Scheduler] Warming XMP campaign cache for ${today}`);
        await fetchXmpCampaigns(today);
        console.log(`[Scheduler] XMP cache warmed for ${today}`);
      } catch (err) {
        console.error('[Scheduler] XMP cache warm error:', err.message);
      }
      scheduleXmpWarm(); // re-schedule for next hour
    }, ms);
  }

  // XMP yesterday backfill: daily at 00:50 Beijing time
  // Captures the full day's spend (the last hourly warm at 23:05 misses ~55 min)
  function scheduleXmpYesterdayBackfill() {
    const now = new Date();
    const beijing = new Date(now.getTime() + 8 * 3600000);
    const next = new Date(beijing);
    next.setUTCHours(0, 50, 0, 0); // 00:50 Beijing = 16:50 UTC
    // Convert back: target UTC = Beijing 00:50 - 8h = prev day 16:50 UTC
    let targetUtc = new Date(next.getTime() - 8 * 3600000);
    if (targetUtc <= now) targetUtc.setDate(targetUtc.getDate() + 1);
    const ms = targetUtc - now;
    console.log(`[Scheduler] Next XMP yesterday backfill in ${Math.round(ms / 60000)} min (at ${new Date(Date.now() + ms).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })})`);
    setTimeout(async () => {
      try {
        // Yesterday in Beijing time
        const nowBj = new Date(Date.now() + 8 * 3600000);
        nowBj.setUTCDate(nowBj.getUTCDate() - 1);
        const yesterday = nowBj.toISOString().slice(0, 10);
        console.log(`[Scheduler] Backfilling XMP cache for yesterday: ${yesterday}`);
        // Clear in-memory cache to force fresh API fetch
        const cacheKey = `xmp-campaigns-${yesterday}`;
        delete xmpCacheMem[cacheKey];
        await fetchXmpCampaigns(yesterday);
        console.log(`[Scheduler] XMP yesterday backfill done for ${yesterday}`);
      } catch (err) {
        console.error('[Scheduler] XMP yesterday backfill error:', err.message);
      }
      scheduleXmpYesterdayBackfill(); // re-schedule for next day
    }, ms);
  }

  scheduleSummary();
  scheduleXmpWarm();
  scheduleXmpYesterdayBackfill();
}

// ── AF Summary from DB (replaces Playwright scraping) ───────
app.get('/api/af-summary', authCheck, (req, res) => {
  // Support startDate/endDate or legacy single date
  let startDate = req.query.startDate || req.query.date;
  let endDate = req.query.endDate || req.query.date;
  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  // Helper: Beijing date → UTC range [D-1 16:00, D 16:00)
  function utcRange(dStr) {
    const [y, m, d] = dStr.split('-').map(Number);
    const s = new Date(Date.UTC(y, m - 1, d) - 8 * 3600 * 1000);
    const e = new Date(Date.UTC(y, m - 1, d + 1) - 8 * 3600 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const fmt = dt => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
    return { start: fmt(s), end: fmt(e) };
  }

  // Full range: startDate → endDate
  const rangeStart = utcRange(startDate).start;
  const rangeEnd = utcRange(endDate).end;

  // Multi-day result cache (single-day is already fast → left live/uncached)
  const _afCacheKey = `af-summary|${startDate}|${endDate}`;
  if (startDate !== endDate) {
    const _hit = getRangeCache(_afCacheKey, '');
    if (_hit) return res.json(_hit);
  }

  let db;
  try { db = getPostbackDb(); } catch (err) { return res.status(500).json({ error: err.message }); }

  try {
    const tables = getTablesForRange(startDate, endDate);
    const result = {};

    for (const tableName of tables) {
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
      if (!tableExists) continue;

      // AF Actual: event_time in range
      const actualRows = db.prepare(`
        SELECT app_id, COALESCE(SUM(revenue), 0) as revenue
        FROM ${tableName}
        WHERE event_name='af_purchase'
          AND event_time >= ? AND event_time < ?
        GROUP BY app_id
      `).all(rangeStart, rangeEnd);

      // AF LTV: install_time in range AND event on same Beijing day as install
      // Approximation: install_time in range AND event within 24h after install AND event also in range
      // For single-day: this matches "same Beijing day" since both install and event are in same 24h window
      // For multi-day: install on any day in range, event on same Beijing day = event within same 24h UTC window
      const ltvRows = db.prepare(`
        SELECT app_id, COALESCE(SUM(revenue), 0) as revenue
        FROM ${tableName}
        WHERE event_name='af_purchase'
          AND install_time >= ? AND install_time < ?
          AND event_time >= ? AND event_time < ?
          AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
          AND (julianday(event_time) - julianday(install_time)) * 24 < 24
          AND substr(datetime(event_time, '+8 hours'), 1, 10) = substr(datetime(install_time, '+8 hours'), 1, 10)
        GROUP BY app_id
      `).all(rangeStart, rangeEnd, rangeStart, rangeEnd);

      // AF Installs: event_time in range
      const installRows = db.prepare(`
        SELECT app_id, COUNT(*) as installs
        FROM ${tableName}
        WHERE event_name='af_complete_registration'
          AND event_time >= ? AND event_time < ?
        GROUP BY app_id
      `).all(rangeStart, rangeEnd);

      // Merge into result
      for (const row of actualRows) {
        const p = APP_ID_MAP[row.app_id] || row.app_id;
        if (!result[p]) result[p] = { revenueActual: 0, revenueLTV: 0, installs: 0 };
        result[p].revenueActual += row.revenue;
      }
      for (const row of ltvRows) {
        const p = APP_ID_MAP[row.app_id] || row.app_id;
        if (!result[p]) result[p] = { revenueActual: 0, revenueLTV: 0, installs: 0 };
        result[p].revenueLTV += row.revenue;
      }
      for (const row of installRows) {
        const p = APP_ID_MAP[row.app_id] || row.app_id;
        if (!result[p]) result[p] = { revenueActual: 0, revenueLTV: 0, installs: 0 };
        result[p].installs += row.installs;
      }
    }

    db.close();
    const _afResponse = { startDate, endDate, date: endDate, products: result };
    if (startDate !== endDate) setRangeCache(_afCacheKey, _afResponse, '', rangeCacheTtl(endDate));
    res.json(_afResponse);
  } catch (err) {
    try { db.close(); } catch (_) {}
    res.status(500).json({ error: err.message });
  }
});

// ── Channel Summary API (渠道明细：汇总面板用) ──────────────────────────────────
// Returns per-channel (FB/GG/TT) cost, revenue, installs, CPI, new-user ROAS, D7 ROAS
// restricted → FB (only in this API, doesn't affect other panels)
app.get('/api/channel-summary', authCheck, async (req, res) => {
  let startDate = req.query.startDate || req.query.date;
  let endDate = req.query.endDate || req.query.date;
  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  // Channel mapping: restricted → FB for this API only
  function mapChannelForSummary(src) {
    if (!src) return null;
    const mapped = MEDIA_SOURCE_MAP[src];
    // Override: restricted/Organic sources that should be FB in channel summary
    if (src === 'restricted') return 'FB';
    if (src === 'Unattributed') return 'FB'; // AD Unattributed → FB
    if (mapped === 'Organic') return null; // organic → exclude
    if (mapped) {
      // Merge FB W2A → FB
      if (mapped === 'FB W2A') return 'FB';
      return mapped;
    }
    // Dynamic W2A check
    const s = src.toLowerCase();
    if (s.includes('w2a') || s.includes('web')) return 'FB';
    return null; // unknown → exclude
  }

  const dates = getDateRange(startDate, endDate);
  const todayStr = todayBeijing();

  // Multi-day result cache. Fingerprint includes the XMP disk-cache mtimes over
  // the range so an XMP (re)fetch/backfill busts the cache. Single-day is fast →
  // left live/uncached.
  const _csCacheKey = `channel-summary|${startDate}|${endDate}`;
  const _csFp = xmpRangeFingerprint(startDate, endDate);
  if (startDate !== endDate) {
    const _hit = getRangeCache(_csCacheKey, _csFp);
    if (_hit) return res.json(_hit);
  }

  // Result accumulator per channel (with per-product breakdown)
  function emptyBucket() { return { cost: 0, revenue: 0, installs: 0, newUserRevenue: 0, d7Revenue: 0 }; }
  const channels = { FB: { ...emptyBucket(), products: {} }, GG: { ...emptyBucket(), products: {} }, TT: { ...emptyBucket(), products: {} } };

  // Helper: get or create product bucket within a channel
  function getProductBucket(ch, product) {
    if (!channels[ch]) return null;
    if (!channels[ch].products[product]) channels[ch].products[product] = emptyBucket();
    return channels[ch].products[product];
  }

  // ── 1. XMP cost by channel (disk cache only, no live fetch to avoid QPM/memory issues) ──
  const xmpMissingDates = [];
  for (const date of dates) {
    const cacheKey = `xmp-campaigns-${date}`;
    const cached = getXmpCacheEntry(cacheKey);
    if (cached && cached.data && cached.data.length > 0) {
      for (const row of cached.data) {
        const ch = row.channel; // Already FB/GG/TT from XMP
        if (channels[ch]) {
          channels[ch].cost += (row.cost || 0);
          // Product-level cost
          const prod = row.product;
          if (prod) {
            const pb = getProductBucket(ch, prod);
            if (pb) pb.cost += (row.cost || 0);
          }
        }
      }
    } else {
      xmpMissingDates.push(date);
    }
  }

  // ── 2. SQLite: revenue, installs, new-user revenue, D7 revenue by channel ──
  // ☆ Performance: use UTC range queries for the ENTIRE date range at once (not per-day loop).
  //   Beijing date D = UTC range [D-1 16:00:00, D 16:00:00)
  //   AF event_time is ISO text (UTC), install_time is ISO text (UTC)
  //   AD event_time/install_time are Unix timestamps (seconds)
  let db;
  try { db = getPostbackDb(); } catch (err) { return res.status(500).json({ error: err.message }); }

  // Helper: Beijing date → UTC range
  function utcRange(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const startUtc = new Date(Date.UTC(y, m - 1, d) - 8 * 3600 * 1000);
    const endUtc = new Date(Date.UTC(y, m - 1, d + 1) - 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
    return { start: fmt(startUtc), end: fmt(endUtc) };
  }
  function unixRange(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return {
      start: Math.floor((Date.UTC(y, m - 1, d) - 8 * 3600 * 1000) / 1000),
      end: Math.floor((Date.UTC(y, m - 1, d + 1) - 8 * 3600 * 1000) / 1000),
    };
  }

  // Compute full range: startDate → endDate (Beijing) → UTC
  const rangeStart = utcRange(startDate).start;
  const rangeEnd = utcRange(endDate).end;
  const tsRangeStart = unixRange(startDate).start;
  const tsRangeEnd = unixRange(endDate).end;

  // Install range for new-user queries (same as event range: install on any date in [startDate, endDate])
  const instRangeStart = rangeStart;
  const instRangeEnd = rangeEnd;
  const instTsStart = tsRangeStart;
  const instTsEnd = tsRangeEnd;

  // Tables covering the range
  const tables = getTablesForRange(startDate, endDate);
  // For D7/cross-day, we may also need the next month table after endDate
  const [ey, em, ed] = endDate.split('-').map(Number);
  const endNext = new Date(ey, em - 1, ed + 8); // +8 days for D7 window
  const endNextTable = 'records_' + endNext.getFullYear() + String(endNext.getMonth() + 1).padStart(2, '0');
  const allTables = [...new Set([...tables, endNextTable])];

  try {
    // Run queries across all relevant tables
    for (const tableName of allTables) {
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
      if (!tableExists) continue;
      const _t0 = Date.now();

      // ── 2a. AF revenue (event_time in range) ──
      const _t2a = Date.now();
      const afRevRows = db.prepare(`
        SELECT media_source, app_id, COALESCE(SUM(revenue), 0) as revenue
        FROM ${tableName}
        WHERE event_name='af_purchase'
          AND event_time >= ? AND event_time < ?
        GROUP BY media_source, app_id
      `).all(rangeStart, rangeEnd);
      for (const row of afRevRows) {
        const ch = mapChannelForSummary(row.media_source);
        if (ch && channels[ch]) {
          channels[ch].revenue += row.revenue;
          const prod = APP_ID_MAP[row.app_id] || row.app_id;
          const pb = getProductBucket(ch, prod);
          if (pb) pb.revenue += row.revenue;
        }
      }

      // ── 2b. AD revenue (unix timestamp — stored as text, use string comparison for index) ──
      const _t2b = Date.now();
      const adRevRows = db.prepare(`
        SELECT media_source, app_id, COALESCE(SUM(revenue), 0) as revenue
        FROM ${tableName}
        WHERE event_name='ad_purchase'
          AND event_time >= ? AND event_time < ?
        GROUP BY media_source, app_id
      `).all(String(tsRangeStart), String(tsRangeEnd));
      for (const row of adRevRows) {
        const ch = mapChannelForSummary(row.media_source);
        if (ch && channels[ch]) {
          channels[ch].revenue += row.revenue;
          const prod = APP_ID_MAP[row.app_id] || row.app_id;
          const pb = getProductBucket(ch, prod);
          if (pb) pb.revenue += row.revenue;
        }
      }

      // ── 2c. AF installs ──
      const _t2c = Date.now();
      const afRegRows = db.prepare(`
        SELECT media_source, app_id, COUNT(*) as cnt
        FROM ${tableName}
        WHERE event_name='af_complete_registration'
          AND event_time >= ? AND event_time < ?
        GROUP BY media_source, app_id
      `).all(rangeStart, rangeEnd);
      for (const row of afRegRows) {
        const ch = mapChannelForSummary(row.media_source);
        if (ch && channels[ch]) {
          channels[ch].installs += row.cnt;
          const prod = APP_ID_MAP[row.app_id] || row.app_id;
          const pb = getProductBucket(ch, prod);
          if (pb) pb.installs += row.cnt;
        }
      }

      // ── 2d. AD installs ──
      const _t2d = Date.now();
      const adRegRows = db.prepare(`
        SELECT media_source, app_id, COUNT(*) as cnt
        FROM ${tableName}
        WHERE event_name='ad_complete_registration'
          AND event_time >= ? AND event_time < ?
        GROUP BY media_source, app_id
      `).all(String(tsRangeStart), String(tsRangeEnd));
      for (const row of adRegRows) {
        const ch = mapChannelForSummary(row.media_source);
        if (ch && channels[ch]) {
          channels[ch].installs += row.cnt;
          const prod = APP_ID_MAP[row.app_id] || row.app_id;
          const pb = getProductBucket(ch, prod);
          if (pb) pb.installs += row.cnt;
        }
      }

      // ── 2e. New-user revenue (install_time in range, event within 24h) ──
      const _t2e = Date.now();
      const afNewUser = db.prepare(`
        SELECT media_source, app_id, COALESCE(SUM(revenue), 0) as revenue
        FROM ${tableName}
        WHERE event_name='af_purchase'
          AND install_time >= ? AND install_time < ?
          AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
          AND (julianday(event_time) - julianday(install_time)) * 24 < 24
        GROUP BY media_source, app_id
      `).all(instRangeStart, instRangeEnd);
      for (const row of afNewUser) {
        const ch = mapChannelForSummary(row.media_source);
        if (ch && channels[ch]) {
          channels[ch].newUserRevenue += row.revenue;
          const prod = APP_ID_MAP[row.app_id] || row.app_id;
          const pb = getProductBucket(ch, prod);
          if (pb) pb.newUserRevenue += row.revenue;
        }
      }

      // AD new-user revenue (unix timestamps)
      const adNewUser = db.prepare(`
        SELECT media_source, app_id, COALESCE(SUM(revenue), 0) as revenue
        FROM ${tableName}
        WHERE event_name='ad_purchase'
          AND install_time >= ? AND install_time < ?
          AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) >= 0
          AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) < 86400
        GROUP BY media_source, app_id
      `).all(String(instTsStart), String(instTsEnd));
      for (const row of adNewUser) {
        const ch = mapChannelForSummary(row.media_source);
        if (ch && channels[ch]) {
          channels[ch].newUserRevenue += row.revenue;
          const prod = APP_ID_MAP[row.app_id] || row.app_id;
          const pb = getProductBucket(ch, prod);
          if (pb) pb.newUserRevenue += row.revenue;
        }
      }

      // ── 2f. D7 revenue (install_time in range, event within 7*24h) ──
      const _t2f = Date.now();
      const afD7 = db.prepare(`
        SELECT media_source, app_id, COALESCE(SUM(revenue), 0) as revenue
        FROM ${tableName}
        WHERE event_name='af_purchase'
          AND install_time >= ? AND install_time < ?
          AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
          AND (julianday(event_time) - julianday(install_time)) * 24 < 168
        GROUP BY media_source, app_id
      `).all(instRangeStart, instRangeEnd);
      for (const row of afD7) {
        const ch = mapChannelForSummary(row.media_source);
        if (ch && channels[ch]) {
          channels[ch].d7Revenue += row.revenue;
          const prod = APP_ID_MAP[row.app_id] || row.app_id;
          const pb = getProductBucket(ch, prod);
          if (pb) pb.d7Revenue += row.revenue;
        }
      }

      // AD D7 revenue (unix timestamps)
      const adD7 = db.prepare(`
        SELECT media_source, app_id, COALESCE(SUM(revenue), 0) as revenue
        FROM ${tableName}
        WHERE event_name='ad_purchase'
          AND install_time >= ? AND install_time < ?
          AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) >= 0
          AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) < 604800
        GROUP BY media_source, app_id
      `).all(String(instTsStart), String(instTsEnd));
      for (const row of adD7) {
        const ch = mapChannelForSummary(row.media_source);
        if (ch && channels[ch]) {
          channels[ch].d7Revenue += row.revenue;
          const prod = APP_ID_MAP[row.app_id] || row.app_id;
          const pb = getProductBucket(ch, prod);
          if (pb) pb.d7Revenue += row.revenue;
        }
      }
      const _tEnd = Date.now();
      console.log(`[channel-summary] ${tableName}: 2a=${_t2b-_t2a}ms 2b=${_t2c-_t2b}ms 2c=${_t2d-_t2c}ms 2d=${_t2e-_t2d}ms 2e=${_t2f-_t2e}ms 2f=${_tEnd-_t2f}ms total=${_tEnd-_t0}ms`);
    }

    db.close();

    // Compute derived metrics (channel-level + per-product)
    const result = {};
    for (const [ch, data] of Object.entries(channels)) {
      // Per-product derived metrics
      const products = {};
      for (const [prod, pd] of Object.entries(data.products)) {
        products[prod] = {
          cost: pd.cost,
          revenue: pd.revenue,
          installs: pd.installs,
          cpi: pd.installs > 0 ? pd.cost / pd.installs : null,
          newUserRevenue: pd.newUserRevenue,
          newUserRoas: pd.cost > 0 ? (pd.newUserRevenue / pd.cost * 100) : null,
          d7Revenue: pd.d7Revenue,
          d7Roas: pd.cost > 0 ? (pd.d7Revenue / pd.cost * 100) : null,
        };
      }
      result[ch] = {
        cost: data.cost,
        revenue: data.revenue,
        installs: data.installs,
        cpi: data.installs > 0 ? data.cost / data.installs : null,
        newUserRevenue: data.newUserRevenue,
        newUserRoas: data.cost > 0 ? (data.newUserRevenue / data.cost * 100) : null,
        d7Revenue: data.d7Revenue,
        d7Roas: data.cost > 0 ? (data.d7Revenue / data.cost * 100) : null,
        products,
      };
    }

    // D7 completeness: check if all dates have a full 7-day window
    const d7Incomplete = [];
    for (const date of dates) {
      const [y, m, d2] = date.split('-').map(Number);
      const d7End = new Date(y, m - 1, d2 + 7);
      const d7EndStr = d7End.getFullYear() + '-' + String(d7End.getMonth() + 1).padStart(2, '0') + '-' + String(d7End.getDate()).padStart(2, '0');
      if (d7EndStr > todayStr) d7Incomplete.push(date);
    }

    const _csResponse = { startDate, endDate, channels: result, d7Incomplete, xmpMissingDates };
    if (startDate !== endDate) setRangeCache(_csCacheKey, _csResponse, _csFp, rangeCacheTtl(endDate));
    res.json(_csResponse);
  } catch (err) {
    try { db.close(); } catch (_) {}
    console.error('[channel-summary] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── XMP Cache Backfill API ──────────────────────────────────
let _xmpBackfillRunning = false;
app.post('/api/xmp-backfill', authCheck, async (req, res) => {
  const { dates } = req.body;
  if (!dates || !Array.isArray(dates) || dates.length === 0) {
    return res.status(400).json({ error: 'dates array required' });
  }
  if (_xmpBackfillRunning) {
    return res.status(409).json({ error: 'Backfill already in progress' });
  }
  const validDates = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (validDates.length === 0) {
    return res.status(400).json({ error: 'No valid dates' });
  }

  _xmpBackfillRunning = true;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let completed = 0;
  const total = validDates.length;
  const MAX_RETRIES = 2;

  for (const date of validDates) {
    res.write(JSON.stringify({ status: 'fetching', date, completed, total }) + '\n');
    let success = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Clear incomplete cache before fetch so stale partial data isn't reused
        const cacheKey = `xmp-campaigns-${date}`;
        const existingCache = getXmpCacheEntry(cacheKey);
        if (existingCache && !existingCache.complete) {
          setXmpCacheEntry(cacheKey, null); // purge incomplete
        }

        await fetchXmpCampaigns(date); // force fresh fetch

        // Verify all 3 channels are complete
        const cached = getXmpCacheEntry(cacheKey);
        if (cached && cached.complete) {
          success = true;
          break;
        } else {
          // Incomplete — some channel hit QPM. Report retrying and wait 60s for QPM window to reset.
          if (attempt < MAX_RETRIES) {
            const missingChannels = [];
            if (cached && cached.data) {
              const have = new Set(cached.data.map(r => r.channel));
              for (const ch of ['FB', 'GG', 'TT']) { if (!have.has(ch)) missingChannels.push(ch); }
            }
            res.write(JSON.stringify({ status: 'retrying', date, attempt: attempt + 1, maxRetries: MAX_RETRIES, missingChannels, completed, total }) + '\n');
            await new Promise(r => setTimeout(r, 60000)); // wait 60s for QPM reset
          }
        }
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          res.write(JSON.stringify({ status: 'retrying', date, attempt: attempt + 1, maxRetries: MAX_RETRIES, error: err.message, completed, total }) + '\n');
          await new Promise(r => setTimeout(r, 60000));
        }
      }
    }

    completed++;
    if (success) {
      res.write(JSON.stringify({ status: 'done', date, completed, total }) + '\n');
    } else {
      res.write(JSON.stringify({ status: 'partial', date, completed, total, message: '\u90e8\u5206\u6e20\u9053\u672a\u8865\u5168\uff08QPM\u9650\u9891\uff09' }) + '\n');
    }

    // 10s between dates (enough for QPM to recover, 3 channels × ~3 pages each)
    if (completed < total) {
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  res.write(JSON.stringify({ status: 'complete', completed, total }) + '\n');
  res.end();
  _xmpBackfillRunning = false;
});

// ── External (machine-to-machine) raw-data endpoints ─────
// These sit under /api/ext/ so any /api/* endpoint (session OR ?key=/Bearer)
// is reachable by external agents. /api/ext/records exposes the raw SQLite
// postback rows with arbitrary filtering + optional aggregation, guaranteeing
// zero blind spots on the DB. /api/ext/xmp exposes raw XMP cost rows.
// /api/ext/meta is the discovery map (freshness, enums, endpoint catalog).

// Whitelist of columns clients may filter on / group by (prevents SQL injection).
const EXT_COLUMNS = ['source','app_id','event_name','event_time','revenue','currency','campaign','media_source','ad_id','adset','country','device_id','install_time','is_retargeting','created_at'];

// GET /api/ext/records
//   Query raw postback rows from records_YYYYMM (AF/AD purchase & registration).
//   Params:
//     startDate,endDate  YYYY-MM-DD (Beijing). Required. Filters on event_time UTC range [D-1 16:00, endD 16:00).
//     dateField          'event_time' (default) | 'install_time' — which column the date range applies to.
//     event_name         optional exact match (af_purchase|af_complete_registration|ad_purchase|ad_complete_registration)
//     app_id, media_source, campaign, adset, country, source  optional exact-match filters
//     groupBy            optional comma list of whitelisted columns → returns aggregated rows (count, revenue sum)
//     limit              max rows for raw mode (default 1000, max 50000)
//     includePayload     '1' to include the raw payload JSON column (raw mode only)
app.get('/api/ext/records', authCheck, (req, res) => {
  const startDate = req.query.startDate || req.query.date;
  const endDate = req.query.endDate || req.query.date;
  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ ok: false, error: 'Invalid or missing startDate/endDate (YYYY-MM-DD)' });
  }
  const dateField = req.query.dateField === 'install_time' ? 'install_time' : 'event_time';
  let db;
  try { db = getPostbackDb(); } catch (e) { return res.status(500).json({ ok: false, error: 'DB open failed: ' + e.message }); }
  try {
    const tables = getTablesForRange(startDate, endDate);
    // Beijing date range → UTC range for AF (ISO text). AD stores unix seconds;
    // we filter AF rows via text compare and AD rows via CAST — but since both
    // live in the same table, we build a range that works for text AF timestamps
    // and additionally CAST-compare for numeric AD rows. Simplest correct path:
    // compute the UTC ISO bounds and unix bounds, then OR them.
    const startUtc = startDate + 'T16:00:00';           // (D-1) 16:00 UTC = D 00:00 Beijing
    // endDate 16:00 UTC next day = endDate+1 00:00 Beijing (exclusive)
    const endObj = new Date(endDate + 'T00:00:00Z'); endObj.setUTCDate(endObj.getUTCDate() + 1);
    const endUtc = endObj.toISOString().slice(0, 10) + 'T16:00:00';
    // Actually the Beijing day D maps to UTC [ (D-1)16:00, D 16:00 ). For a range
    // startDate..endDate inclusive: lowerUtc = (startDate-1) 16:00, upperUtc = endDate 16:00.
    const lowObj = new Date(startDate + 'T00:00:00Z'); lowObj.setUTCDate(lowObj.getUTCDate() - 1);
    const lowerUtc = lowObj.toISOString().slice(0, 10) + 'T16:00:00';
    const upObj = new Date(endDate + 'T00:00:00Z');
    const upperUtc = upObj.toISOString().slice(0, 10) + 'T16:00:00';
    const lowerUnix = Math.floor(new Date(lowerUtc + 'Z').getTime() / 1000);
    const upperUnix = Math.floor(new Date(upperUtc + 'Z').getTime() / 1000);

    // Build filter WHERE clause (exact-match, whitelisted columns only).
    const filters = [];
    const fparams = [];
    for (const col of ['event_name','app_id','media_source','campaign','adset','country','source']) {
      if (req.query[col] != null && req.query[col] !== '') { filters.push(`${col} = ?`); fparams.push(String(req.query[col])); }
    }
    // Date range: AF rows are ISO text, AD rows are numeric text. Handle both.
    // AF: dateField text BETWEEN lowerUtc AND upperUtc (exclusive upper).
    // AD: CAST(dateField AS INTEGER) BETWEEN lowerUnix AND upperUnix.
    const dateClause = `((${dateField} >= ? AND ${dateField} < ? AND ${dateField} LIKE '____-%') OR (CAST(${dateField} AS INTEGER) >= ? AND CAST(${dateField} AS INTEGER) < ? AND ${dateField} NOT LIKE '____-%'))`;

    const groupBy = (req.query.groupBy || '').split(',').map(s => s.trim()).filter(Boolean).filter(c => EXT_COLUMNS.includes(c));

    if (groupBy.length) {
      // Aggregated mode
      const gb = groupBy.join(', ');
      let agg = {};
      for (const tbl of tables) {
        const sql = `SELECT ${gb}, COUNT(*) AS cnt, ROUND(SUM(revenue),4) AS revenue FROM ${tbl} WHERE ${dateClause}${filters.length ? ' AND ' + filters.join(' AND ') : ''} GROUP BY ${gb}`;
        const params = [lowerUtc, upperUtc, lowerUnix, upperUnix, ...fparams];
        let rows;
        try { rows = db.prepare(sql).all(...params); } catch (e) { continue; }
        for (const r of rows) {
          const key = groupBy.map(c => r[c]).join('\u0001');
          if (!agg[key]) { agg[key] = {}; for (const c of groupBy) agg[key][c] = r[c]; agg[key].count = 0; agg[key].revenue = 0; }
          agg[key].count += r.cnt || 0;
          agg[key].revenue += r.revenue || 0;
        }
      }
      const out = Object.values(agg).map(r => ({ ...r, revenue: Math.round(r.revenue * 10000) / 10000 }));
      out.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
      return res.json({ ok: true, mode: 'aggregate', data: out, meta: { startDate, endDate, dateField, groupBy, tables, rows: out.length } });
    }

    // Raw mode
    let limit = parseInt(req.query.limit, 10); if (!Number.isFinite(limit) || limit <= 0) limit = 1000; if (limit > 50000) limit = 50000;
    const includePayload = req.query.includePayload === '1';
    const cols = includePayload ? EXT_COLUMNS.concat(['payload']) : EXT_COLUMNS;
    const selectCols = cols.join(', ');
    const rows = [];
    for (const tbl of tables) {
      if (rows.length >= limit) break;
      const remaining = limit - rows.length;
      const sql = `SELECT ${selectCols} FROM ${tbl} WHERE ${dateClause}${filters.length ? ' AND ' + filters.join(' AND ') : ''} ORDER BY ${dateField} DESC LIMIT ?`;
      const params = [lowerUtc, upperUtc, lowerUnix, upperUnix, ...fparams, remaining];
      try { rows.push(...db.prepare(sql).all(...params)); } catch (e) { /* table may not exist */ }
    }
    return res.json({ ok: true, mode: 'raw', data: rows, meta: { startDate, endDate, dateField, tables, rows: rows.length, limit, truncated: rows.length >= limit } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    try { db.close(); } catch (e) {}
  }
});

// GET /api/ext/xmp — raw XMP cost rows (product/campaign/channel/cost/impressions/clicks).
//   Params: startDate,endDate YYYY-MM-DD. product/channel optional exact-match filter.
//   refresh=1 to force live XMP fetch for missing/incomplete cache (respects 10 QPM — use sparingly).
app.get('/api/ext/xmp', authCheck, async (req, res) => {
  const startDate = req.query.startDate || req.query.date;
  const endDate = req.query.endDate || req.query.date;
  if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ ok: false, error: 'Invalid or missing startDate/endDate (YYYY-MM-DD)' });
  }
  const refresh = req.query.refresh === '1';
  const dates = getDateRange(startDate, endDate);
  const out = [];
  const missingDates = [];
  for (const d of dates) {
    let rows = null;
    if (refresh) {
      try { rows = await fetchXmpCampaigns(d, { staleOk: true }); } catch (e) { rows = null; }
    } else {
      const cached = getXmpCacheEntry(`xmp-campaigns-${d}`);
      rows = cached && cached.data ? cached.data : null;
    }
    if (!rows || !rows.length) { missingDates.push(d); continue; }
    for (const r of rows) {
      if (req.query.product && r.product !== req.query.product) continue;
      if (req.query.channel && r.channel !== req.query.channel) continue;
      out.push({ date: d, ...r });
    }
  }
  return res.json({ ok: true, data: out, meta: { startDate, endDate, rows: out.length, missingDates, source: refresh ? 'live+cache' : 'cache-only' } });
});

// ── XMP Open API passthrough (full-surface) ───────────────────────
// These proxy XMP's own API so a holder of this dashboard can reach EVERY XMP
// capability (all dimensions/metrics/modules, ad report + material report + the
// self-describing fields endpoint), not just the curated /api/ext/xmp cost view.
// Official docs: https://help-xmp.mobvista.com/docs/open_api_desc
// We inject client_id/timestamp/sign server-side; caller passes the business
// params only. XMP rate limits apply (report 10 QPM, material 20 QPM,
// fields 120 QPM) — callers must serialize & respect "请求太频繁".
//
// Tiny in-process rate limiter so a chatty external agent can't blow XMP's QPM
// (which is shared with the dashboard's own fetches). Sliding 60s window per path.
const _xmpExtCalls = {}; // apiPath -> [timestamps ms]
const XMP_EXT_QPM = { '/v2/media/account/report': 10, '/v2/media/material_report/list': 20, '/v1/media/report/fields': 120 };
function xmpExtRateOk(apiPath) {
  const cap = XMP_EXT_QPM[apiPath] || 10;
  const now = Date.now();
  const arr = (_xmpExtCalls[apiPath] || []).filter(t => now - t < 60000);
  if (arr.length >= cap) { _xmpExtCalls[apiPath] = arr; return false; }
  arr.push(now); _xmpExtCalls[apiPath] = arr; return true;
}
// Build the XMP body: merge caller params, then overwrite auth fields (never trust client-supplied auth).
function buildXmpBody(reqBody) {
  const { timestamp, sign } = xmpSign();
  const body = Object.assign({}, reqBody || {});
  delete body.client_id; delete body.timestamp; delete body.sign;
  return Object.assign(body, { client_id: XMP_CLIENT_ID, timestamp, sign });
}
async function xmpPassthrough(apiPath, req, res) {
  if (!xmpExtRateOk(apiPath)) {
    return res.status(429).json({ ok: false, error: 'Rate limited by dashboard proxy (XMP QPM guard). Wait and retry.', apiPath });
  }
  // Accept params from JSON body (POST) or query string (GET convenience).
  let params = (req.method === 'POST' && req.body && Object.keys(req.body).length) ? req.body : {};
  if (req.method === 'GET') {
    params = Object.assign({}, req.query);
    delete params.key; // strip our own auth param
    // Coerce common array/int params from query strings
    for (const k of ['dimension','metrics','account_id','campaign_id','adset_id','ad_id','geo','product_id','md5_file_id']) {
      if (typeof params[k] === 'string' && params[k] !== '') params[k] = params[k].split(',').map(x => x.trim());
    }
    if (typeof params.page === 'string') params.page = parseInt(params.page, 10);
    if (typeof params.page_size === 'string') params.page_size = parseInt(params.page_size, 10);
  }
  // Accept-Language passthrough for the fields endpoint (zh-CN / en-US)
  const extraHeaders = {};
  const lang = req.query.lang || req.query.accept_language || (req.body && req.body.accept_language);
  if (lang) extraHeaders['Accept-Language'] = lang;
  try {
    const xmpResp = await xmpApiRequestPath(apiPath, buildXmpBody(params), extraHeaders);
    // Pass XMP's response through verbatim under data, plus ok flag mirroring XMP code.
    const ok = xmpResp && (xmpResp.code === 0 || xmpResp.code === '0');
    return res.json({ ok: !!ok, apiPath, xmp: xmpResp });
  } catch (e) {
    return res.status(502).json({ ok: false, apiPath, error: 'XMP request failed: ' + e.message });
  }
}

// GET/POST /api/ext/xmp-report — passthrough to XMP 广告报表 API (/v2/media/account/report).
// Full dimension/metrics/module/filter support. See official docs for params.
app.get('/api/ext/xmp-report', authCheck, (req, res) => xmpPassthrough('/v2/media/account/report', req, res));
app.post('/api/ext/xmp-report', authCheck, (req, res) => xmpPassthrough('/v2/media/account/report', req, res));

// GET/POST /api/ext/xmp-material — passthrough to XMP 素材报表 API (/v2/media/material_report/list).
app.get('/api/ext/xmp-material', authCheck, (req, res) => xmpPassthrough('/v2/media/material_report/list', req, res));
app.post('/api/ext/xmp-material', authCheck, (req, res) => xmpPassthrough('/v2/media/material_report/list', req, res));

// GET/POST /api/ext/xmp-fields — passthrough to XMP 查询可用指标 API (/v1/media/report/fields).
// report_type=ad|material, module=facebook|google|tiktok|..., lang=zh-CN|en-US.
// This is the SELF-DESCRIBING entry point: call it first to discover every metric.
app.get('/api/ext/xmp-fields', authCheck, (req, res) => xmpPassthrough('/v1/media/report/fields', req, res));
app.post('/api/ext/xmp-fields', authCheck, (req, res) => xmpPassthrough('/v1/media/report/fields', req, res));

// GET /api/ext/meta — discovery map: data freshness, enums, endpoint catalog.
app.get('/api/ext/meta', authCheck, (req, res) => {
  const meta = { ok: true };
  try {
    const db = getPostbackDb();
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%' ORDER BY name").all().map(r => r.name);
      meta.tables = tables;
      const latest = tables[tables.length - 1];
      if (latest) {
        meta.eventCounts = db.prepare(`SELECT event_name, COUNT(*) AS cnt, ROUND(SUM(revenue),2) AS revenue FROM ${latest} GROUP BY event_name`).all();
        const mx = db.prepare(`SELECT MAX(event_time) AS mx FROM ${latest} WHERE event_time LIKE '____-%'`).get();
        meta.latestEventTime = mx ? mx.mx : null;
      }
      meta.userLookupCount = db.prepare('SELECT COUNT(*) AS c FROM user_lookup').get().c;
    } finally { try { db.close(); } catch (e) {} }
  } catch (e) { meta.dbError = e.message; }
  try {
    const fs = require('fs');
    const dir = path.join(__dirname, 'data', 'xmp-cache');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^xmp-campaigns-\d{4}-\d{2}-\d{2}\.json$/.test(f)) : [];
    const days = files.map(f => f.slice('xmp-campaigns-'.length, -'.json'.length)).sort();
    meta.xmpCacheDays = { count: days.length, earliest: days[0] || null, latest: days[days.length - 1] || null };
  } catch (e) { meta.xmpError = e.message; }
  meta.enums = {
    events: ['af_purchase','af_complete_registration','ad_purchase','ad_complete_registration'],
    channels: ['FB','FB W2A','GG','TT'],
    products: Array.from(new Set(Object.values(APP_ID_MAP))),
    columns: EXT_COLUMNS.concat(['payload']),
    xmpChannels: XMP_CHANNELS,
  };
  meta.appIdMap = APP_ID_MAP;
  meta.endpoints = [
    { path: '/api/ext/records', desc: 'Raw SQLite postback rows (AF/AD purchase & registration). Filter by any column, optional groupBy aggregation, optional payload.' },
    { path: '/api/ext/xmp', desc: 'Raw XMP cost rows (product/campaign/channel/cost/impressions/clicks). Cache-first; refresh=1 for live.' },
    { path: '/api/ext/xmp-report', desc: 'XMP 广告报表 passthrough (/v2/media/account/report): FULL dimension/metrics/module/filter. GET or POST. XMP 10 QPM.' },
    { path: '/api/ext/xmp-material', desc: 'XMP 素材报表 passthrough (/v2/media/material_report/list): creative-level metrics. XMP 20 QPM.' },
    { path: '/api/ext/xmp-fields?report_type=ad|material&module=facebook&lang=en-US', desc: 'XMP 可用指标 passthrough (/v1/media/report/fields): self-describing metric catalog. Call FIRST to discover every metric. XMP 120 QPM.' },
    { path: '/api/ext/meta', desc: 'This discovery map.' },
    { path: '/api/postback/personal?startDate=&endDate=', desc: 'Personal panel: operator→product→channel→campaign→adset→ad, 9 metrics incl corrected revenue & eLTV. THE daily-report source.' },
    { path: '/api/af-summary?startDate=&endDate=', desc: 'Summary-panel AF revenue/registration aggregation.' },
    { path: '/api/channel-summary?startDate=&endDate=', desc: 'FB/GG/TT channel rollup: cost+revenue+CPI+ROAS+D7 (XMP cost + AF/AD revenue), expandable by product.' },
    { path: '/api/data?startDate=&endDate=', desc: 'Summary panel: Athena revenue + XMP cost + AF, per product.' },
    { path: '/api/correction-factors?startDate=&endDate=', desc: 'Correction factors per product (Athena/AF+AD ratio).' },
    { path: '/api/eltv-multipliers?date=', desc: 'eLTV D30 multipliers per product×channel with confidence.' },
    { path: '/api/user-lookup?userId=', desc: 'Per-user ad attribution lookup.' },
    { path: '/api/creative/data?date=', desc: 'Creative panel ranking (FB/TT).' },
    { path: '/api/aigc/data?days=3|7|14', desc: 'AIGC creative ranking, product-aware.' },
    { path: '/api/revenue-by-install?level=&date=&days=', desc: 'Revenue by install cohort (old-user dependency).' },
  ];
  meta.auth = 'Append ?key=<dashboard password> to any URL, or send Authorization: Bearer <dashboard password>.';
  meta.xmpDocs = 'https://help-xmp.mobvista.com/docs/open_api_desc';
  meta.xmpPassthrough = 'Endpoints /api/ext/xmp-report | xmp-material | xmp-fields proxy XMP Open API 1:1 (auth injected server-side). Full XMP capability. Discover metrics via xmp-fields. Docs: ' + meta.xmpDocs;
  meta.note = 'All /api/* endpoints accept the same auth. Cache-first everywhere; XMP is rate-limited (report 10 / material 20 / fields 120 QPM) — the proxy enforces a guard and returns 429 if exceeded. Avoid tight loops.';
  return res.json(meta);
});

// ── Server Overview API ──────────────────────────────────
app.get('/api/overview', authCheck, (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const overviewPath = path.join(__dirname, '..', 'SERVER_OVERVIEW.md');
    const content = fs.readFileSync(overviewPath, 'utf8');
    res.type('text/plain').send(content);
  } catch (err) {
    res.status(404).json({ error: 'SERVER_OVERVIEW.md not found' });
  }
});

// ── Campaign Advice Context Builder ────────────────────────
app.get('/api/campaign-context', authCheck, async (req, res) => {
  try {
  const { campaign, product, channel, operator, date } = req.query;
  if (!campaign || !product || !channel) {
    return res.status(400).json({ error: 'campaign, product, channel required' });
  }

  const queryDate = date || fetcher.formatDate(new Date());
  const todayStr = fetcher.formatDate(new Date());

  // ── Helper: compute metrics for a single day ──
  // ── Collect 7 days of historical data (not including today) ──
  const historyDays = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(queryDate + 'T00:00:00+08:00');
    d.setDate(d.getDate() - i);
    historyDays.push(fetcher.formatDate(d));
  }
  // historyDays[0] = yesterday, [6] = 7 days ago

  // ── Open DB once for all queries ──
  let db;
  try { db = getPostbackDb(); } catch (err) { /* will return nulls later */ }

  // ── Pre-compute constants ──
  const appIds = Object.entries(APP_ID_MAP)
    .filter(([_, name]) => name === product)
    .map(([id]) => id);
  const appIdPlaceholders = appIds.map(() => '?').join(',');

  // Pre-load XMP data: try disk cache first, then fetchXmpCampaigns for missing dates
  const allDaysToQuery = [...historyDays, todayStr];
  const xmpCacheMap = {};
  for (const d of allDaysToQuery) {
    try {
      const cachePath = path.join(__dirname, 'data', 'xmp-cache', `xmp-campaigns-${d}.json`);
      const raw = fs.readFileSync(cachePath, 'utf8');
      xmpCacheMap[d] = JSON.parse(raw);
      console.log(`[campaign-context] Disk cache loaded for ${d}`);
    } catch (_) { xmpCacheMap[d] = null; }
  }
  // For missing dates, try fetchXmpCampaigns (async, respects rate limits)
  for (const d of allDaysToQuery) {
    if (!xmpCacheMap[d]) {
      try {
        const xmpData = await fetchXmpCampaigns(d, { staleOk: true });
        xmpCacheMap[d] = xmpData;
      } catch (_) { /* leave null */ }
    }
  }

  console.log('[campaign-context] XMP cache pre-loaded, computing eLTV...');
  // Pre-compute eLTV & breakeven (once, not per day)
  // New: eLTV is per product×channel, look up the channel for this campaign
  let eltvD180 = null;
  let eltvConfidence = 'red';
  const eltvCacheForProduct = (() => {
    const sortedDates = Object.keys(eltvCache).sort().reverse();
    for (const dateStr of sortedDates) {
      const cached = eltvCache[dateStr];
      if (cached && cached.multipliers && cached.multipliers[product]) return cached.multipliers[product];
    }
    return null;
  })();
  // Static fallback: per-channel D30 values
  const eltvStaticByChannel = {
    'Dora iOS':   { FB: { d180: 1.75 }, TT: { d180: 2.62 } },
    'Romi iOS':   { FB: { d180: 1.97 }, TT: { d180: 1.71 } },
    'Luma':       { FB: { d180: 2.18 }, TT: { d180: 2.12 } },
    'GraceChat':  { FB: { d180: 1.89 } },
    'Dora And':   { FB: { d180: 8.44 }, GG: { d180: 20.31 } },
    'Jovia And':  { FB: { d180: 4.18 }, GG: { d180: 6.80 }, TT: { d180: 4.39 } },
    'Doni':       { FB: { d180: 2.59 }, GG: { d180: 3.36 }, TT: { d180: 3.24 } },
    'Kira And':   { FB: { d180: 2.61 }, GG: { d180: 2.34 }, TT: { d180: 4.57 } },
    'Nalo And':   { FB: { d180: 7.76 }, TT: { d180: 18.24 } },
  }[product] || null;
  // Determine channel for this campaign (from query param, already FB/GG/TT)
  const campChannel = channel || 'FB';
  const eltvInfo = (eltvCacheForProduct && eltvCacheForProduct[campChannel]) || (eltvStaticByChannel && eltvStaticByChannel[campChannel]) || null;
  if (eltvInfo && eltvInfo.d180 != null && eltvInfo.d180 > 0) {
    eltvD180 = Math.round(eltvInfo.d180 * 100) / 100;
    const hwmKey = `${product}_${campChannel}`;
    if (eltvInfo.confidence) {
      eltvConfidence = applyConfidenceHWM(hwmKey, eltvInfo.confidence);
    } else {
      const d1span = eltvInfo.d1Span || 0;
      let rawConf = 'red';
      if (d1span >= 30) rawConf = 'green';
      else if (d1span >= 10) rawConf = 'yellow';
      eltvConfidence = applyConfidenceHWM(hwmKey, rawConf);
    }
  } else {
    const hwmKey = `${product}_${campChannel}`;
    eltvConfidence = applyConfidenceHWM(hwmKey, 'red');
  }

  const BREAKEVEN_ROAS_MAP = {
    'Dora And': 100, 'Jovia And': 100, 'GraceChat': 100, 'Doni': 100,
    'Kira And': 100, 'Romi iOS': 100, 'Dora iOS': 100, 'Luma': 100,
    'Romi And': 100, 'Nalo And': 100,
  };
  let breakevenROAS = BREAKEVEN_ROAS_MAP[product] || null;
  if (eltvConfidence === 'red') {
    const isIOS = ['Dora iOS', 'Romi iOS', 'Luma', 'GraceChat', 'Kira iOS'].includes(product);
    breakevenROAS = isIOS ? 60 : 30;
  } else if (eltvConfidence === 'yellow' && breakevenROAS != null) {
    breakevenROAS = Math.round(breakevenROAS * 1.05 * 10) / 10;
  }

  // ── Helper: is channel FB? (supports both mapped names and raw media_source) ──
  function isChannelFB(ch) {
    if (ch === 'FB' || ch === 'FB W2A') return true;
    return isFbSource(ch);
  }

  // ── Pre-compute correction factors for all needed dates (product-specific, faster) ──
  const correctionFactorsCache = {};
  const isAndroid = Object.values(ANDROID_APP_IDS).includes(product);
  const isIOS = Object.values(IOS_AF_APP_IDS).includes(product);

  function computeCorrectionForProduct(cfDate) {
    // Product-specific correction factor (avoids querying all products)
    const dayData = fetcher.loadDayData(cfDate);
    const lastSnap = dayData.snapshots && dayData.snapshots[dayData.snapshots.length - 1];
    if (!lastSnap || !lastSnap.athena) return 1;
    const athenaItem = lastSnap.athena.find(a => a.product === product);
    const athenaRev = athenaItem ? (athenaItem.totalRevenue || 0) : 0;
    if (athenaRev <= 0) return 1;

    const tableName = tableForMonth(cfDate);
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    if (!tableExists) return 1;

    if (isAndroid) {
      // Android: athena / af_non_organic * 0.95 (only for this product's app_ids)
      const row = db.prepare(`
        SELECT ROUND(SUM(revenue), 4) as rev
        FROM ${tableName}
        WHERE event_name='af_purchase' AND date(event_time, '+8 hours')=?
          AND media_source != 'organic'
          AND app_id IN (${appIdPlaceholders})
      `).get(cfDate, ...appIds);
      const afRev = row?.rev || 0;
      if (afRev > 0) return Math.round(athenaRev / afRev * 0.95 * 10000) / 10000;
      return 1;
    } else if (isIOS) {
      if (product === 'Kira iOS') return 1;
      // iOS: FB fixed multiplier then base factor
      const iosAfIds = Object.entries(IOS_AF_APP_IDS).filter(([,n]) => n === product).map(([id]) => id);
      const iosAdIds = Object.entries(IOS_AD_APP_IDS).filter(([,n]) => n === product).map(([id]) => id);
      let fbRev = 0, nonFbRev = 0;
      if (iosAfIds.length > 0) {
        const rows = db.prepare(`
          SELECT media_source, ROUND(SUM(revenue), 4) as rev
          FROM ${tableName}
          WHERE event_name='af_purchase' AND date(event_time, '+8 hours')=?
            AND media_source != 'organic'
            AND app_id IN (${iosAfIds.map(() => '?').join(',')})
          GROUP BY media_source
        `).all(cfDate, ...iosAfIds);
        for (const r of rows) { if (isFbSource(r.media_source)) fbRev += r.rev; else nonFbRev += r.rev; }
      }
      if (iosAdIds.length > 0) {
        const rows = db.prepare(`
          SELECT media_source, ROUND(SUM(revenue), 4) as rev
          FROM ${tableName}
          WHERE event_name='ad_purchase' AND date(datetime(event_time, 'unixepoch', '+8 hours'))=?
            AND media_source NOT IN ('Organic', 'organic')
            AND app_id IN (${iosAdIds.map(() => '?').join(',')})
          GROUP BY media_source
        `).all(cfDate, ...iosAdIds);
        for (const r of rows) { const ms = r.media_source.replace(/\+/g, ' '); if (isFbSource(ms)) fbRev += r.rev; else nonFbRev += r.rev; }
      }
      const fbFixed = IOS_FB_FIXED[product] || 1;
      const totalBase = fbRev * fbFixed + nonFbRev;
      if (totalBase <= 0) return isChannelFB(channel) ? fbFixed : 1;
      const baseFactor = Math.round(athenaRev / totalBase * 0.95 * 10000) / 10000;
      return isChannelFB(channel) ? Math.round(baseFactor * fbFixed * 10000) / 10000 : baseFactor;
    }
    return 1;
  }

  function getCorrectionFactorForDay(day) {
    const cfDate = day >= todayStr ? yesterdayBeijing() : day;
    if (correctionFactorsCache[cfDate] == null) {
      try {
        correctionFactorsCache[cfDate] = computeCorrectionForProduct(cfDate);
      } catch (_) {
        correctionFactorsCache[cfDate] = 1;
      }
    }
    return correctionFactorsCache[cfDate];
  }

  // ── Compute metrics for a single day (sync, aligned with personal panel logic) ──
  function computeDayMetrics(day) {
    if (!db) return null;
    try {
      const tableName = tableForMonth(day);
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
      if (!tableExists) return null;

      // Compute next date string (pure string arithmetic to avoid UTC timezone issues)
      const [y, m, d2] = day.split('-').map(Number);
      const nextDateObj = new Date(y, m - 1, d2 + 1);
      const nextDateStr = nextDateObj.getFullYear() + '-' + String(nextDateObj.getMonth() + 1).padStart(2, '0') + '-' + String(nextDateObj.getDate()).padStart(2, '0');
      const nextTableName = tableForMonth(nextDateStr);
      const nextTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(nextTableName);

      let totalNewUserRev = 0, totalInstalls = 0;
      const campaignTrimmed = campaign.trim();
      if (appIds.length > 0) {
        // ── New user revenue: install_time on target day + event within 24h (same as personal panel) ──
        // Part 1: event_time also on target day
        const afMainRow = db.prepare(`
          SELECT
            ROUND(SUM(CASE WHEN date(install_time, '+8 hours') = ?
                             AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
                             AND (julianday(event_time) - julianday(install_time)) * 24 < 24
                       THEN revenue ELSE 0 END), 2) as new_user_revenue
          FROM ${tableName}
          WHERE event_name = 'af_purchase'
            AND app_id IN (${appIdPlaceholders})
            AND date(event_time, '+8 hours') = ?
            AND campaign = ?
        `).get(day, ...appIds, day, campaignTrimmed);
        totalNewUserRev = afMainRow?.new_user_revenue || 0;

        // Part 2: cross-day extra — install on target day, event on next day, diff < 24h
        const afExtraSame = db.prepare(`
          SELECT COALESCE(SUM(revenue), 0) as extra
          FROM ${tableName}
          WHERE event_name = 'af_purchase'
            AND app_id IN (${appIdPlaceholders})
            AND date(install_time, '+8 hours') = ?
            AND date(event_time, '+8 hours') = ?
            AND campaign = ?
            AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
            AND (julianday(event_time) - julianday(install_time)) * 24 < 24
        `).get(...appIds, day, nextDateStr, campaignTrimmed);
        totalNewUserRev += afExtraSame?.extra || 0;

        // Cross month boundary
        if (nextTableExists && nextTableName !== tableName) {
          const afExtraNext = db.prepare(`
            SELECT COALESCE(SUM(revenue), 0) as extra
            FROM ${nextTableName}
            WHERE event_name = 'af_purchase'
              AND app_id IN (${appIdPlaceholders})
              AND date(install_time, '+8 hours') = ?
              AND date(event_time, '+8 hours') = ?
              AND campaign = ?
              AND (julianday(event_time) - julianday(install_time)) * 24 >= 0
              AND (julianday(event_time) - julianday(install_time)) * 24 < 24
          `).get(...appIds, day, nextDateStr, campaignTrimmed);
          totalNewUserRev += afExtraNext?.extra || 0;
        }

        // Installs (af_complete_registration)
        const afRegRow = db.prepare(`
          SELECT COUNT(*) as installs
          FROM ${tableName}
          WHERE event_name = 'af_complete_registration'
            AND app_id IN (${appIdPlaceholders})
            AND date(event_time, '+8 hours') = ?
            AND campaign = ?
        `).get(...appIds, day, campaignTrimmed);
        totalInstalls = afRegRow?.installs || 0;

        // ── AD data (Adjust, iOS products only, event_time/install_time are unix timestamps) ──
        // AD campaign names are URL-encoded with (id) suffix; decode and match in JS
        const adPaidRows = db.prepare(`
          SELECT campaign, revenue, event_time, install_time, media_source
          FROM ${tableName}
          WHERE event_name = 'ad_purchase'
            AND app_id IN (${appIdPlaceholders})
            AND date(datetime(event_time, 'unixepoch', '+8 hours')) = ?
        `).all(...appIds, day);

        for (const row of adPaidRows) {
          let adCamp = row.campaign || '';
          try { adCamp = decodeURIComponent(adCamp.replace(/\+/g, ' ')); } catch(e) {}
          adCamp = adCamp.replace(/\s*\(.*?\)\s*$/, '').trim();
          if (adCamp !== campaignTrimmed) continue;
          if (AD_ORGANIC_SOURCES.has(row.media_source)) continue;
          const rev = row.revenue || 0;
          const eventTs = parseInt(row.event_time);
          const installTs = parseInt(row.install_time);
          if (!isNaN(eventTs) && !isNaN(installTs)) {
            const installBeijingDay = new Date((installTs + 8 * 3600) * 1000).toISOString().slice(0, 10);
            const diffSec = eventTs - installTs;
            if (installBeijingDay === day && diffSec >= 0 && diffSec < 86400) {
              totalNewUserRev += rev;
            }
          }
        }

        // AD cross-day extra: install on target day, event on next day, diff < 24h
        const adExtraSame = db.prepare(`
          SELECT campaign, revenue, event_time, install_time, media_source
          FROM ${tableName}
          WHERE event_name = 'ad_purchase'
            AND app_id IN (${appIdPlaceholders})
            AND date(datetime(install_time, 'unixepoch', '+8 hours')) = ?
            AND date(datetime(event_time, 'unixepoch', '+8 hours')) = ?
            AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) >= 0
            AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) < 86400
        `).all(...appIds, day, nextDateStr);
        for (const row of adExtraSame) {
          let adCamp = row.campaign || '';
          try { adCamp = decodeURIComponent(adCamp.replace(/\+/g, ' ')); } catch(e) {}
          adCamp = adCamp.replace(/\s*\(.*?\)\s*$/, '').trim();
          if (adCamp !== campaignTrimmed) continue;
          if (AD_ORGANIC_SOURCES.has(row.media_source)) continue;
          totalNewUserRev += row.revenue || 0;
        }

        // AD cross month boundary
        if (nextTableExists && nextTableName !== tableName) {
          const adExtraNext = db.prepare(`
            SELECT campaign, revenue, event_time, install_time, media_source
            FROM ${nextTableName}
            WHERE event_name = 'ad_purchase'
              AND app_id IN (${appIdPlaceholders})
              AND date(datetime(install_time, 'unixepoch', '+8 hours')) = ?
              AND date(datetime(event_time, 'unixepoch', '+8 hours')) = ?
              AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) >= 0
              AND CAST(event_time AS INTEGER) - CAST(install_time AS INTEGER) < 86400
          `).all(...appIds, day, nextDateStr);
          for (const row of adExtraNext) {
            let adCamp = row.campaign || '';
            try { adCamp = decodeURIComponent(adCamp.replace(/\+/g, ' ')); } catch(e) {}
            adCamp = adCamp.replace(/\s*\(.*?\)\s*$/, '').trim();
            if (adCamp !== campaignTrimmed) continue;
            if (AD_ORGANIC_SOURCES.has(row.media_source)) continue;
            totalNewUserRev += row.revenue || 0;
          }
        }

        // AD installs (ad_complete_registration)
        const adRegRows = db.prepare(`
          SELECT campaign, COUNT(*) as cnt
          FROM ${tableName}
          WHERE event_name = 'ad_complete_registration'
            AND app_id IN (${appIdPlaceholders})
            AND date(datetime(event_time, 'unixepoch', '+8 hours')) = ?
          GROUP BY campaign
        `).all(...appIds, day);
        for (const row of adRegRows) {
          let adCamp = row.campaign || '';
          try { adCamp = decodeURIComponent(adCamp.replace(/\+/g, ' ')); } catch(e) {}
          adCamp = adCamp.replace(/\s*\(.*?\)\s*$/, '').trim();
          if (adCamp === campaignTrimmed) totalInstalls += row.cnt;
        }
      }

      // XMP from pre-loaded cache (now includes fetchXmpCampaigns fallback)
      let xmpCost = 0, xmpImpressions = 0, xmpClicks = 0;
      const xmpRows = (xmpCacheMap[day] && xmpCacheMap[day].data) || [];
      for (const row of xmpRows) {
        if (row.product === product && (row.campaign === campaign || row.campaign?.trim() === campaignTrimmed)) {
          xmpCost += row.cost || 0;
          xmpImpressions += row.impressions || 0;
          xmpClicks += row.clicks || 0;
        }
      }

      // Correction factor (using pre-computed cache, same logic as /api/correction-factors)
      const correctionFactor = getCorrectionFactorForDay(day);

      const correctedNuRev = totalNewUserRev * correctionFactor;
      const nuROAS = xmpCost > 0 ? correctedNuRev / xmpCost : 0;
      const eltvROAS = nuROAS > 0 && eltvD180 ? nuROAS * eltvD180 : 0;

      return {
        date: day,
        cost: Math.round(xmpCost * 100) / 100,
        impressions: xmpImpressions,
        clicks: xmpClicks,
        installs: totalInstalls,
        newUserRevenue: Math.round(totalNewUserRev * 100) / 100,
        correctedNewUserRevenue: Math.round(correctedNuRev * 100) / 100,
        correctionFactor: Math.round(correctionFactor * 10000) / 10000,
        eltvD180,
        eltvConfidence,
        breakevenROAS,
        cpm: xmpImpressions > 0 ? Math.round(xmpCost / xmpImpressions * 1000 * 100) / 100 : 0,
        cpc: xmpClicks > 0 ? Math.round(xmpCost / xmpClicks * 100) / 100 : 0,
        cpi: totalInstalls > 0 ? Math.round(xmpCost / totalInstalls * 100) / 100 : 0,
        newUserROAS: nuROAS > 0 ? Math.round(nuROAS * 10000) / 10000 : 0,
        newUserEltvROAS: eltvROAS > 0 ? Math.round(eltvROAS * 10000) / 10000 : 0,
      };
    } catch (_) { return null; }
  }

  const historicalData = [];
  for (const day of historyDays) {
    const metrics = computeDayMetrics(day);
    if (metrics) historicalData.push(metrics);
    else historicalData.push({ date: day, cost: 0, impressions: 0, clicks: 0, installs: 0, newUserRevenue: 0, correctedNewUserRevenue: 0, correctionFactor: 0, eltvD180, eltvConfidence, breakevenROAS, cpm: 0, cpc: 0, cpi: 0, newUserROAS: 0, newUserEltvROAS: 0 });
  }

  const todayMetrics = computeDayMetrics(todayStr);
  if (db) db.close();

  const realtimeData = todayMetrics || { date: todayStr, cost: 0, impressions: 0, clicks: 0, installs: 0, newUserRevenue: 0, correctedNewUserRevenue: 0, correctionFactor: 0, eltvD180, eltvConfidence, breakevenROAS, cpm: 0, cpc: 0, cpi: 0, newUserROAS: 0, newUserEltvROAS: 0 };
  realtimeData.snapshotTime = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').replace('Z', '') + ' CST';

  // ── Build structured context ──
  const structuredInput = {
    campaign,
    product,
    channel,
    historyDays: historicalData.reverse(), // chronologically: 7d ago → yesterday
    realtime: realtimeData,
  };

  // ── Build HTML summary for the data card ──
  const rt = realtimeData;
  const summary = `
    <table>
      <tr><td>产品</td><td>${product}</td></tr>
      <tr><td>渠道</td><td>${channel}</td></tr>
      <tr><td>日期</td><td>${queryDate}</td></tr>
      <tr><td>XMP 消耗</td><td>$${rt.cost.toFixed(2)}</td></tr>
      <tr><td>CPM</td><td>$${rt.cpm.toFixed(2)}</td></tr>
      <tr><td>CPC</td><td>$${rt.cpc.toFixed(2)}</td></tr>
      <tr><td>CPI</td><td>$${rt.cpi.toFixed(2)}</td></tr>
      <tr><td>新用户收入</td><td>$${rt.newUserRevenue.toFixed(2)}</td></tr>
      <tr><td>修正后新用户收入</td><td>$${rt.correctedNewUserRevenue.toFixed(2)}</td></tr>
      <tr><td>新用户ROAS</td><td>${(rt.newUserROAS * 100).toFixed(1)}%</td></tr>
      <tr><td>eLTV ROAS</td><td>${(rt.newUserEltvROAS * 100).toFixed(1)}% ${rt.eltvConfidence === 'green' ? '🟢可信' : rt.eltvConfidence === 'yellow' ? '🟡供参考' : '🔴不可信'}</td></tr>
      ${rt.breakevenROAS != null ? `<tr><td>回本ROAS</td><td>${rt.breakevenROAS}%</td></tr>` : ''}
    </table>
  `;

  // (fs & path already declared at top of file — redeclaring would TDZ earlier fs.readFileSync calls)
  let masterDoc = '';
  try {
    masterDoc = fs.readFileSync(path.join(__dirname, '投放大师.md'), 'utf8');
  } catch (_) {
    masterDoc = '（投放大师.md 文件未找到，请确保文件存在）';
  }

  let dataDoc = '';
  try {
    dataDoc = fs.readFileSync(path.join(__dirname, 'AI投放决策.md'), 'utf8');
  } catch (_) {
    dataDoc = '';
  }

  let systemPrompt = `你是投放大师AI。请严格按照以下决策指南的框架和规则，基于用户提供的输入数据给出预算调整建议。\n\n${masterDoc}`;
  if (dataDoc) {
    systemPrompt += `\n\n---\n\n以下是基于历史数据量化分析得出的补充决策规则。当上述经验框架与以下数据结论冲突时，以数据结论为准。\n\n${dataDoc}`;
  }

  // Build user message identical to what's shown in the textarea (with aligned columns)
  const confTag = c => c === 'green' ? '🟢可信' : c === 'yellow' ? '🟡供参考' : '🔴不可信';
  const f3 = v => { const s = String(v); const dot = s.indexOf('.'); return dot < 0 ? s : s.slice(0, dot + 4); };
  // History table: no 可信度/回本ROAS (same every day), date without year
  const tHeaders = ['日期', '消耗', 'CPM', 'CPC', 'CPI', '新用户收入', '修正后收入', '修正系数', '新用户ROAS', 'eLTV_ROAS'];
  const tRows = structuredInput.historyDays.map(d => [
    d.date.slice(5), `$${f3(d.cost)}`, `$${f3(d.cpm)}`, `$${f3(d.cpc)}`, `$${f3(d.cpi)}`,
    `$${f3(d.newUserRevenue)}`, `$${f3(d.correctedNewUserRevenue)}`, `${f3(d.correctionFactor)}`,
    `${(d.newUserROAS*100).toFixed(1)}%`, `${(d.newUserEltvROAS*100).toFixed(1)}%`,
  ]);
  // Column width: CJK chars ~1.5 monospace width; include header in width calc
  const dw = s => { let w = 0; for (const ch of String(s)) w += ch.charCodeAt(0) > 0x7F ? 1.6 : 1; return Math.ceil(w); };
  const padCell = (s, width) => s + ' '.repeat(Math.max(0, width - dw(s)));
  const colWidths = tHeaders.map((h, i) => Math.max(dw(h), ...tRows.map(r => dw(r[i]))));
  const fmtRow = cells => '| ' + cells.map((c, i) => padCell(c, colWidths[i])).join(' | ') + ' |';
  const sepLine = '|' + colWidths.map(w => '-'.repeat(w + 2)).join('|') + '|';

  let userText = `Campaign: ${campaign}\nProduct: ${product}\nChannel: ${channel}\n\n`;
  userText += `=== 过去7天每日数据 ===\n`;
  userText += fmtRow(tHeaders) + '\n';
  userText += sepLine + '\n';
  for (const r of tRows) userText += fmtRow(r) + '\n';
  userText += `\n=== 今天实时数据 (截至 ${rt.snapshotTime || '?'}) ===\n`;
  userText += `日期: ${rt.date}\n`;
  userText += `消耗: $${f3(rt.cost)}\n`;
  userText += `CPM: $${f3(rt.cpm)}\n`;
  userText += `CPC: $${f3(rt.cpc)}\n`;
  userText += `CPI: $${f3(rt.cpi)}\n`;
  userText += `新用户收入: $${f3(rt.newUserRevenue)}\n`;
  userText += `修正后收入: $${f3(rt.correctedNewUserRevenue)}\n`;
  userText += `修正系数: ${f3(rt.correctionFactor)}\n`;
  userText += `新用户ROAS: ${(rt.newUserROAS * 100).toFixed(1)}%\n`;
  userText += `eLTV D180: ${rt.eltvD180 || 'N/A'}\n`;
  userText += `eLTV ROAS: ${(rt.newUserEltvROAS * 100).toFixed(1)}% ${confTag(rt.eltvConfidence)}\n`;
  if (rt.breakevenROAS != null) userText += `回本ROAS: ${rt.breakevenROAS}%${rt.eltvConfidence === 'yellow' ? '（已含5%风险调整）' : ''}\n`;

    res.json({
    summary,
    structuredInput,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
  });
  } catch (err) {
    console.error(`[campaign-context] Error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: `Internal error: ${err.message}` });
    }
  }
});

// ── Revenue-by-install endpoint ──────────────────────────
// "收入来源图" for the personal panel: of the revenue earned ON the query day,
// how much comes from old users (installed long ago) vs new users (recent install).
// Filter = payment events whose event_time falls on the query day (Beijing 0–24h);
// then group those payments by the user's install_time Beijing date. X axis = install
// date over the past `days` (rightmost = query day); Y = that install-cohort's revenue
// earned on the query day. Raw revenue (no correction factor).
//
// Attribution mirrors /api/postback/personal PAID logic (so numbers line up with the
// panel): AF paid = media_source IN (Facebook Ads, googleadwords_int, tiktokglobal_int);
// AD paid = ad_purchase excluding AD_ORGANIC_SOURCES. Channel via mapMediaSource,
// operator via matchOperator, product via APP_ID_MAP. Full AF+AD attribution with no
// dedup (matches the panel's corrected total — including Romi iOS FB/TT/AF+AD).
//
// Performance: the MAIN filter is event_time = single query day → tiny row count,
// served by the (event_name, event_time) index. install_time is only read per row to
// bucket into the axis (no install_time range scan); installs outside the window are
// dropped. `days` only sizes the JS axis, so days=60 (or 180) is still fast.
//   GET /api/revenue-by-install?level=campaign|channel|product|operator
//        &campaign=&product=&channel=&operator=&date=YYYY-MM-DD&days=60
app.get('/api/revenue-by-install', authCheck, (req, res) => {
  const level = (req.query.level || 'campaign').trim();
  if (!['campaign', 'channel', 'product', 'operator'].includes(level)) {
    return res.status(400).json({ error: 'level must be campaign|channel|product|operator' });
  }
  const date = (req.query.date || todayBeijing()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD)' });
  let days = parseInt(req.query.days, 10);
  if (!Number.isFinite(days) || days <= 0) days = 99;
  if (days > 180) days = 180; // only sizes the JS axis (event_time filter is single-day)

  const reqCampaign = (req.query.campaign || '').trim();
  const reqChannel = (req.query.channel || '').trim();
  const reqProduct = (req.query.product || '').trim();
  const reqOperator = (req.query.operator || '').trim();

  if (level === 'campaign' && (!reqCampaign || !reqProduct || !reqChannel)) {
    return res.status(400).json({ error: 'campaign level requires campaign, product, channel' });
  }
  if (level === 'channel' && (!reqProduct || !reqChannel)) {
    return res.status(400).json({ error: 'channel level requires product, channel' });
  }
  if (level === 'product' && !reqProduct) {
    return res.status(400).json({ error: 'product level requires product' });
  }
  if (level === 'operator' && !reqOperator) {
    return res.status(400).json({ error: 'operator level requires operator' });
  }

  // ── Beijing date axis: startDate .. date inclusive (left→right = early→late) ──
  const [dy, dm, dd] = date.split('-').map(Number);
  const startMs = Date.UTC(dy, dm - 1, dd) - days * 86400000;
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const axis = [];
  for (let i = 0; i <= days; i++) axis.push(new Date(startMs + i * 86400000).toISOString().slice(0, 10));

  // ── event_time bounds: the query day (Beijing 0–24h) expressed in UTC ──
  // This is the MAIN filter. low = 00:00 of date (Beijing) → UTC = Date.UTC(date) - 8h;
  // high = 00:00 of (date + 1) (Beijing) → UTC = Date.UTC(date+1) - 8h (exclusive).
  const evLowMs = Date.UTC(dy, dm - 1, dd) - 8 * 3600000;
  const evHighMs = Date.UTC(dy, dm - 1, dd + 1) - 8 * 3600000;
  const pad = n => String(n).padStart(2, '0');
  const fmtUtc = ms => {
    const t = new Date(ms);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
  };
  const afEvLow = fmtUtc(evLowMs);            // AF event_time is ISO text (UTC) → lexicographic range
  const afEvHigh = fmtUtc(evHighMs);
  const adEvLow = Math.floor(evLowMs / 1000); // AD event_time is unix seconds (text) → CAST int range
  const adEvHigh = Math.floor(evHighMs / 1000);

  // ── Product → app_ids ──
  // Use APP_ID_MAP (the same mapping the personal panel uses for product
  // attribution, line ~2192) so totals line up with the panel. It already covers
  // every app_id form (AF `idXXX`/`com.*` and AD numeric); the AF query only ever
  // matches af_purchase rows and the AD query only ad_purchase rows, so listing
  // all forms in both IN-clauses is harmless.
  let appIds = null; // null = no app_id filter (operator level spans all products)
  if (level !== 'operator') {
    appIds = Object.entries(APP_ID_MAP).filter(([, n]) => n === reqProduct).map(([id]) => id);
    if (!appIds.length) {
      return res.json({ level, date, days, startDate, series: axis.map(d => ({ date: d, revenue: 0 })) });
    }
  }
  const appIdPh = appIds ? appIds.map(() => '?').join(',') : '';
  const AF_PAID = ['Facebook Ads', 'googleadwords_int', 'tiktokglobal_int'];

  // install Beijing day helpers (match the personal panel exactly)
  const afInstallDay = iso => {
    if (!iso) return null;
    const t = new Date(iso.replace(' ', 'T') + 'Z');
    if (isNaN(t)) return null;
    return new Date(t.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  };
  const adInstallDay = ts => {
    const n = parseInt(ts, 10);
    if (isNaN(n)) return null;
    return new Date((n + 8 * 3600) * 1000).toISOString().slice(0, 10);
  };

  const byDay = Object.create(null);
  for (const d of axis) byDay[d] = 0;
  let earlierRevenue = 0; // corrected revenue from installs earlier than the axis window (< axis[0])

  let db;
  try { db = getPostbackDb(); }
  catch (err) { return res.status(500).json({ error: 'Cannot open postback database: ' + err.message }); }

  // ── Correction factors: use the SAME source & data-date as the personal panel ──
  // The panel (/api/postback/personal) and /api/correction-factors compute factors
  // from athena data of `dataDate`, where `dataDate` falls back to the previous day
  // when the requested day is today/future (today's athena data is incomplete, which
  // would otherwise yield ≈1 factors). Mirror that fallback exactly so the chart's
  // corrected revenue matches the panel's 修正总收入.
  const IOS_PRODUCTS_WITH_FB_FACTOR = new Set(['Dora iOS', 'Romi iOS', 'Luma', 'GraceChat']);
  const todayStr = todayBeijing();
  let corrDataDate = date;
  if (date >= todayStr) {
    corrDataDate = yesterdayBeijing();
  }
  const corrFactors = computeCorrectionFactorsSync(corrDataDate, db);
  function getCorrFactor(product, channel) {
    if (!corrFactors || corrFactors[product] == null) return 1;
    const f = corrFactors[product];
    if (typeof f === 'number') return f; // Android: single factor
    // iOS: { fb, other } — match the panel: FB and FB W2A both use the fb factor
    if (channel === 'FB' || channel === 'FB W2A') return f.fb || 1;
    return f.other || 1;
  }

  try {
    // event_time = query day can straddle a month boundary in UTC → may touch 2 tables
    const evLowDateUtc = new Date(evLowMs).toISOString().slice(0, 10);
    const tables = getTablesForRange(evLowDateUtc, date);

    for (const tbl of tables) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
      if (!exists) continue;

      // ---- AF paid: events ON the query day (index (event_name, event_time)) ----
      const afSql = `
        SELECT campaign, app_id, media_source, revenue, install_time
        FROM ${tbl}
        WHERE event_name = 'af_purchase'
          AND event_time >= ? AND event_time < ?
          AND media_source IN (${AF_PAID.map(() => '?').join(',')})
          ${appIds ? `AND app_id IN (${appIdPh})` : ''}`;
      const afParams = appIds ? [afEvLow, afEvHigh, ...AF_PAID, ...appIds] : [afEvLow, afEvHigh, ...AF_PAID];
      for (const row of db.prepare(afSql).all(...afParams)) {
        const product = APP_ID_MAP[row.app_id];
        const channel = mapMediaSource(row.media_source);
        const campaign = (row.campaign || '').trim();
        if (level === 'campaign' && (channel !== reqChannel || campaign !== reqCampaign)) continue;
        if (level === 'channel' && channel !== reqChannel) continue;
        if (level === 'operator' && (matchOperator(campaign) || 'other') !== reqOperator) continue;
        const day = afInstallDay(row.install_time);
        if (day != null) {
          const rev = (row.revenue || 0) * getCorrFactor(product, channel);
          if (day in byDay) byDay[day] += rev;
          else if (day < axis[0]) earlierRevenue += rev;
        }
      }

      // ---- AD paid: events ON the query day (CAST int range on unix-seconds event_time) ----
      const adSql = `
        SELECT campaign, app_id, media_source, revenue, install_time
        FROM ${tbl}
        WHERE event_name = 'ad_purchase'
          AND CAST(event_time AS INTEGER) >= ? AND CAST(event_time AS INTEGER) < ?
          ${appIds ? `AND app_id IN (${appIdPh})` : ''}`;
      const adParams = appIds ? [adEvLow, adEvHigh, ...appIds] : [adEvLow, adEvHigh];
      for (const row of db.prepare(adSql).all(...adParams)) {
        if (AD_ORGANIC_SOURCES.has(row.media_source)) continue;
        const product = APP_ID_MAP[row.app_id];
        const channel = mapMediaSource(row.media_source);
        let campaign = row.campaign || '';
        try { campaign = decodeURIComponent(campaign.replace(/\+/g, ' ')); } catch (e) {}
        campaign = campaign.replace(/\s*\(.*?\)\s*$/, '').trim();
        if (level === 'campaign' && (channel !== reqChannel || campaign !== reqCampaign)) continue;
        if (level === 'channel' && channel !== reqChannel) continue;
        if (level === 'operator' && (matchOperator(campaign) || 'other') !== reqOperator) continue;
        const day = adInstallDay(row.install_time);
        if (day != null) {
          const rev = (row.revenue || 0) * getCorrFactor(product, channel);
          if (day in byDay) byDay[day] += rev;
          else if (day < axis[0]) earlierRevenue += rev;
        }
      }
    }
  } catch (err) {
    try { db.close(); } catch (_) {}
    console.error(`[revenue-by-install] Error: ${err.message}`);
    return res.status(500).json({ error: `Internal error: ${err.message}` });
  }
  try { db.close(); } catch (_) {}

  const series = axis.map(d => ({ date: d, revenue: Math.round(byDay[d] * 100) / 100 }));
  res.json({
    level, date, days, startDate,
    campaign: reqCampaign || undefined,
    product: reqProduct || undefined,
    channel: reqChannel || undefined,
    operator: reqOperator || undefined,
    series,
    earlierRevenue: Math.round(earlierRevenue * 100) / 100,
  });
});

// ── LLM Proxy Route ──────────────────────────────────────
// Proxies chat completion requests to the configured LLM API (SiliconFlow)
// Supports SSE streaming via ?stream=true
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY || '';
const SILICONFLOW_BASE_URL = process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.com/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'zai-org/GLM-5.1';
const LLM_TIMEOUT = 180000; // 180s timeout for LLM calls (GLM-5.1 thinking can be slow)

app.post('/api/llm/chat', authCheck, (req, res) => {
  if (!SILICONFLOW_API_KEY) {
    return res.status(503).json({ error: 'LLM API key not configured' });
  }

  const { messages, model, stream, temperature, max_tokens } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const targetModel = model || LLM_MODEL;
  const useStream = stream !== false; // default true

  const payload = JSON.stringify({
    model: targetModel,
    messages,
    stream: useStream,
    ...(temperature != null ? { temperature } : {}),
    ...(max_tokens != null ? { max_tokens } : {}),
  });

  const baseUrl = SILICONFLOW_BASE_URL.replace(/\/$/, '');
  const url = new URL(`${baseUrl}/chat/completions`);

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SILICONFLOW_API_KEY}`,
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  if (useStream) {
    // SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const llmReq = https.request(options, (llmRes) => {
      if (llmRes.statusCode !== 200) {
        let errBody = '';
        llmRes.on('data', c => errBody += c);
        llmRes.on('end', () => {
          let errMsg = errBody;
          try { errMsg = JSON.parse(errBody).error?.message || errBody; } catch (_) {}
          res.write(`data: ${JSON.stringify({ error: errMsg, statusCode: llmRes.statusCode })}\n\n`);
          res.end();
        });
        return;
      }
      llmRes.on('data', (chunk) => {
        res.write(chunk);
      });
      llmRes.on('end', () => {
        res.end();
      });
    });

    llmReq.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });

    llmReq.setTimeout(LLM_TIMEOUT, () => {
      llmReq.destroy(new Error('LLM request timeout'));
    });

    llmReq.write(payload);
    llmReq.end();
  } else {
    // Non-streaming
    const llmReq = https.request(options, (llmRes) => {
      let body = '';
      llmRes.on('data', c => body += c);
      llmRes.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          res.json(parsed);
        } catch (_) {
          res.status(502).json({ error: 'Invalid LLM response', raw: body.substring(0, 500) });
        }
      });
    });

    llmReq.on('error', (err) => {
      res.status(502).json({ error: err.message });
    });

    llmReq.setTimeout(LLM_TIMEOUT, () => {
      llmReq.destroy(new Error('LLM request timeout'));
    });

    llmReq.write(payload);
    llmReq.end();
  }
});

// ── 用户查询 (User Lookup) API ──────────────────────────────
app.get('/api/user-lookup', authCheck, (req, res) => {
  const userId = req.query.userId;
  if (!userId || !/^\d{5,10}$/.test(userId)) {
    return res.status(400).json({ error: '请输入5-10位数字的用户ID' });
  }

  let db;
  try { db = getPostbackDb(); } catch (e) { return res.status(500).json({ error: e.message }); }

  try {
    // Use pre-built user_lookup table for fast indexed queries
    const rows = db.prepare(`
      SELECT payload, event_time, install_time, app_id
      FROM user_lookup
      WHERE user_id = ?
      ORDER BY event_time DESC
    `).all(parseInt(userId, 10));

    const results = [];
    const seen = new Set();

    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload);
        const product = LTV_APP_IDS[payload.app_id] || payload.bundle_id || payload.app_id || row.app_id;
        const key = `${row.app_id}-${row.event_time}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const mediaSource = payload.af_channel || payload.media_source || '';
        // Classify to ad platform (FB/GG/TT) using both af_channel and media_source
        let adPlatform = '';
        const chLower = (payload.af_channel || '').toLowerCase();
        // Check af_channel first (Facebook, Instagram, ACI_Display, TikTok, etc.)
        if (['facebook', 'instagram', 'audiencenetwork', 'threads', 'graphic'].includes(chLower) ||
            chLower.startsWith('social_facebook')) {
          adPlatform = 'FB';
        } else if (chLower.startsWith('aci_')) {
          adPlatform = 'GG';
        } else if (chLower === 'tiktok') {
          adPlatform = 'TT';
        }
        // Fallback: use media_source via mapMediaSource()
        if (!adPlatform) {
          const mapped = mapMediaSource(payload.media_source || '');
          if (mapped === 'FB' || mapped === 'FB W2A') adPlatform = 'FB';
          else if (mapped === 'GG') adPlatform = 'GG';
          else if (mapped === 'TT') adPlatform = 'TT';
        }

        results.push({
          product,
          appId: payload.app_id || row.app_id,
          userId: parseInt(userId, 10),
          mediaSource,
          adPlatform,
          campaign: (payload.campaign || '').trim(),
          adset: (payload.af_adset || '').trim(),
          ad: (payload.af_ad || '').trim(),
          eventTime: payload.event_time || row.event_time || '',
          installTime: payload.install_time || row.install_time || '',
          isOrganic: !payload.campaign,
          platform: payload._platform || 'af',
        });
      } catch (_) { /* skip malformed rows */ }
    }

    res.json({ userId, results });
  } finally {
    db.close();
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Sitin Dashboard running at http://localhost:${PORT}`);
  console.log(`[Server] Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

  scheduleHourlyFetch();

  // Ensure new monthly tables have the aggregation indexes (idempotent).
  try { ensureMonthlyIndexes(); } catch (e) { console.error('[Index] startup error:', e.message); }

  // Startup fetch removed — scheduler will run at the next scheduled hour
  console.log('[Server] Skipping initial fetch on startup, waiting for scheduled run.');

  // eLTV HWM is loaded from disk at startup (loadHwmFromDisk),
  // no need for expensive full-table-scan pre-warm on every restart.
  console.log('[Server] eLTV confidence HWM loaded from disk:', JSON.stringify(eltvConfidenceHWM));
});
