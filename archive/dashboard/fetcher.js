const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');
const DATA_DIR = path.resolve(__dirname, 'data');

const PRODUCT_NAME_MAP = {
  'Dora': 'Dora iOS',
  'Dora iOS': 'Dora iOS',
  'Romi': 'Romi iOS',
  'Romi iOS': 'Romi iOS',
  'GraceChat': 'GraceChat',
  'Dora And': 'Dora And',
  'Doni': 'Doni',
  'Romi And': 'Romi And',
  'Luma': 'Luma',
  'Jovia And': 'Jovia And',
  'Kira And': 'Kira And',
  'Kira iOS': 'Kira iOS',
  'Nalo And': 'Nalo And',
  // 雅典娜返回的名字
  'Kira': 'Kira iOS',
  // XMP返回的名字
  'Kira: Creative Community': 'Kira iOS',
  'Kira: Find Your Romance': 'Kira And',
  'Nalo: Meet, Swipe & Chat': 'Nalo And',
  // AF返回的名字（旧映射保留）
  'Kira: Face Effects': 'Kira iOS',
};

function normalizeProductName(name) {
  return PRODUCT_NAME_MAP[name] || name;
}

function parseMoney(val) {
  if (val == null || val === 'N/A' || val === 'Error') return 0;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[$,USD\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function getDataFilePath(dateStr) {
  return path.join(DATA_DIR, `${dateStr}.json`);
}

function getPersonalDataFilePath(dateStr) {
  return path.join(DATA_DIR, `personal-${dateStr}.json`);
}

function loadDayData(dateStr) {
  const filePath = getDataFilePath(dateStr);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`Error loading data for ${dateStr}:`, err.message);
  }
  return { date: dateStr, snapshots: [] };
}

function saveDayData(dateStr, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(getDataFilePath(dateStr), JSON.stringify(data, null, 2));
}

function loadPersonalDayData(dateStr) {
  const filePath = getPersonalDataFilePath(dateStr);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`Error loading personal data for ${dateStr}:`, err.message);
  }
  return { date: dateStr, snapshots: [] };
}

function savePersonalDayData(dateStr, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(getPersonalDataFilePath(dateStr), JSON.stringify(data, null, 2));
}

function runScript(scriptName, args = [], timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    console.log(`[Fetcher] Running ${scriptName} with args: [${args.join(', ')}]`);
    execFile('bash', [scriptPath, ...args], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[Fetcher] ${scriptName} failed:`, error.message);
        if (stderr) console.error(`[Fetcher] ${scriptName} stderr:`, stderr.substring(0, 2000));
        reject(error);
        return;
      }
      try {
        const trimmed = stdout.trim();
        if (!trimmed) { reject(new Error(`${scriptName} returned empty output`)); return; }
        const data = JSON.parse(trimmed);
        console.log(`[Fetcher] ${scriptName} returned ${Array.isArray(data) ? data.length : 0} records`);
        resolve(data);
      } catch (parseErr) {
        console.error(`[Fetcher] ${scriptName} JSON parse error:`, parseErr.message);
        console.error(`[Fetcher] Raw output (first 500 chars):`, stdout.substring(0, 500));
        reject(parseErr);
      }
    });
  });
}

// ── Status ──────────────────────────────────────────────────────
const fetchStatus = {
  isFetching: false,
  lastFetchTime: null,
  lastFetchSuccess: null,
  sources: {
    athena: { status: 'idle', lastSuccess: null, lastError: null, lastTime: null },
    af: { status: 'idle', lastSuccess: null, lastError: null, lastTime: null },
    xmp: { status: 'idle', lastSuccess: null, lastError: null, lastTime: null },
  }
};

function getStatus() { return { ...fetchStatus }; }

const personalFetchStatus = {
  isFetching: false,
  lastFetchTime: null,
  lastFetchSuccess: null,
  sources: {
    xmp: { status: 'idle', lastSuccess: null, lastError: null, lastTime: null },
    af: { status: 'idle', lastSuccess: null, lastError: null, lastTime: null },
    ad: { status: 'idle', lastSuccess: null, lastError: null, lastTime: null },
  }
};

function getPersonalStatus() { return { ...personalFetchStatus }; }

function probeHttpViaProxy(url, proxyHost = '127.0.0.1', proxyPort = 7890, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'GET',
      path: url,
      timeout: timeoutMs,
      headers: { Host: new URL(url).host, 'User-Agent': 'OpenClaw-AF-Healthcheck/1.0' },
    }, (res) => {
      resolve({ ok: true, statusCode: res.statusCode, headers: res.headers });
      res.resume();
    });
    req.on('timeout', () => req.destroy(new Error('proxy probe timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function checkProxyHealth() {
  const now = new Date().toISOString();
  try {
    const result = await probeHttpViaProxy('https://hq1.appsflyer.com/auth/login');
    fetchStatus.proxyHealth = {
      checkedAt: now,
      ok: true,
      detail: `HTTP ${result.statusCode || 'unknown'} via 127.0.0.1:7890`,
    };
    console.log(`[Fetcher] Proxy health OK at ${now}: ${fetchStatus.proxyHealth.detail}`);
    return fetchStatus.proxyHealth;
  } catch (err) {
    fetchStatus.proxyHealth = {
      checkedAt: now,
      ok: false,
      detail: err.message,
    };
    console.error(`[Fetcher] Proxy health failed at ${now}: ${err.message}`);
    return fetchStatus.proxyHealth;
  }
}

// ── Source config ───────────────────────────────────────────────
const SUMMARY_SOURCE_CONFIG = {
  athena: {
    script: 'fetch-revenue.sh',
    parse: item => ({
      product: normalizeProductName(item.product),
      totalRevenue: parseMoney(item.totalRevenue),
      newUserRevenue: parseMoney(item.newUserRevenue),
    }),
  },
  xmp: {
    script: 'fetch-xmp-api.sh',
    parse: item => ({
      product: normalizeProductName(item.product),
      cost: parseMoney(item.cost),
    }),
  },
  af: {
    script: 'fetch-af.sh',
    parse: item => ({
      product: normalizeProductName(item.product),
      installs: parseMoney(item.installs),
      revenueActual: parseMoney(item.revenueActual),
      revenueLTV: parseMoney(item.revenueLTV),
    }),
    filter: item => item.product !== 'Totals' && item.afName !== 'Totals',
    disabled: true, // Replaced by /api/af-summary (DB query)
  },
};

// ── Athena Revenue API ─────────────────────────────────────────
// 敏感信息从环境变量读取（见 config.js），禁止硬编码。
const config = require('./config');
const ATHENA_API_URL = config.athena.apiUrl;
const ATHENA_API_KEY = config.athena.apiKey;

const ATHENA_API_NAME_MAP = {
  'Dora': 'Dora iOS', 'Romi': 'Romi iOS', 'Kira': 'Kira iOS',
  'Dora Android': 'Dora And', 'Romi Android': 'Romi And',
  'Jovia Android': 'Jovia And', 'Kira Android': 'Kira And',
  'Nalo Android': 'Nalo And',
  'GraceChat': 'GraceChat', 'Luma': 'Luma', 'Doni': 'Doni',
};
const ATHENA_API_IGNORE = new Set(['Haven', 'Aura', 'AI Fantasy', 'Lovia', 'Elara']);

function fetchAthenaApiRaw(dateStr) {
  return new Promise((resolve, reject) => {
    const url = dateStr
      ? `${ATHENA_API_URL}?date=${dateStr}`
      : ATHENA_API_URL;
    const req = https.get(url, {
      headers: { 'Authorization': `Bearer ${ATHENA_API_KEY}` },
      timeout: 15000,
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (!json.success) return reject(new Error(`API error: ${JSON.stringify(json)}`));
          resolve(json.data);
        } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Athena API timeout')); });
  });
}

async function fetchAthenaApi(dateStr) {
  const now = new Date();
  fetchStatus.sources.athena.status = 'fetching';
  const ATHENA_MAX_RETRIES = 5;
  const ATHENA_RETRY_DELAY = 10000; // 10s between retries
  let lastErr = null;
  for (let attempt = 1; attempt <= ATHENA_MAX_RETRIES; attempt++) {
    try {
      const data = await fetchAthenaApiRaw(dateStr || null);
      const products = (data.products || [])
        .filter(p => !ATHENA_API_IGNORE.has(p.appName))
        .map(p => {
          const name = ATHENA_API_NAME_MAP[p.appName] || normalizeProductName(p.appName);
          return {
            product: name,
            totalRevenue: parseMoney(p.totalRevenue),
            newUserRevenue: parseMoney(p.newUserRevenue),
          };
        });
      fetchStatus.sources.athena.status = 'success';
      fetchStatus.sources.athena.lastSuccess = now.toISOString();
      fetchStatus.sources.athena.lastTime = now.toISOString();
      if (attempt > 1) console.log(`[Fetcher] Athena API succeeded on attempt ${attempt} for ${dateStr || 'today'}`);
      else console.log(`[Fetcher] Athena API returned ${products.length} products for ${dateStr || 'today'}`);
      return products;
    } catch (err) {
      lastErr = err;
      if (attempt < ATHENA_MAX_RETRIES) {
        console.error(`[Fetcher] Athena API attempt ${attempt}/${ATHENA_MAX_RETRIES} failed: ${err.message}, retrying in ${ATHENA_RETRY_DELAY/1000}s...`);
        await new Promise(r => setTimeout(r, ATHENA_RETRY_DELAY));
      }
    }
  }
  fetchStatus.sources.athena.status = 'error';
  fetchStatus.sources.athena.lastError = lastErr.message;
  fetchStatus.sources.athena.lastTime = now.toISOString();
  console.error(`[Fetcher] Athena API failed after ${ATHENA_MAX_RETRIES} attempts: ${lastErr.message}`);
  return null;
}

async function fetchSummarySource(sourceKey, scriptName, scriptArgs, parseRow) {
  const now = new Date();
  fetchStatus.sources[sourceKey].status = 'fetching';
  try {
    const data = await runScript(scriptName, scriptArgs);
    const parsed = (data || []).map(parseRow);
    fetchStatus.sources[sourceKey].status = 'success';
    fetchStatus.sources[sourceKey].lastSuccess = now.toISOString();
    fetchStatus.sources[sourceKey].lastTime = now.toISOString();
    return parsed;
  } catch (err) {
    fetchStatus.sources[sourceKey].status = 'error';
    fetchStatus.sources[sourceKey].lastError = err.message;
    fetchStatus.sources[sourceKey].lastTime = now.toISOString();
    console.error(`[Fetcher] ${sourceKey} fetch failed:`, err.message);
    return null;
  }
}

// ── Main fetch ──────────────────────────────────────────────────
async function fetchAll() {
  if (fetchStatus.isFetching) {
    console.log('[Fetcher] Already fetching, skipping...');
    return null;
  }

  fetchStatus.isFetching = true;
  const now = new Date();
  const hour = now.getHours();
  let targetDate, scriptArgs;
  if (hour === 0) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    targetDate = formatDate(yesterday);
    scriptArgs = [targetDate, targetDate];
    console.log(`[Fetcher] Midnight fetch: getting yesterday's data (${targetDate})`);
  } else {
    targetDate = formatDate(now);
    scriptArgs = [];
    console.log(`[Fetcher] Hourly fetch: getting today's data (${targetDate})`);
  }

  const snapshot = { time: now.toISOString(), athena: null, af: null, xmp: null };

  // Athena: use API instead of Playwright script
  const athenaDateArg = hour === 0 ? targetDate : null; // null = today realtime
  snapshot.athena = await fetchAthenaApi(athenaDateArg);

  snapshot.xmp = await fetchSummarySource('xmp', 'fetch-xmp-api.sh', scriptArgs,
    SUMMARY_SOURCE_CONFIG.xmp.parse);

  // AF data now comes from DB (/api/af-summary), not Playwright scraping
  // Keep status for UI continuity
  const nowISO = new Date().toISOString();
  fetchStatus.sources.af.status = 'success';
  fetchStatus.sources.af.lastSuccess = nowISO;
  fetchStatus.sources.af.lastTime = nowISO;

  if (snapshot.athena || snapshot.xmp) {
    const dayData = loadDayData(targetDate);
    dayData.snapshots.push(snapshot);
    saveDayData(targetDate, dayData);
    console.log(`[Fetcher] Snapshot saved for ${targetDate} at ${snapshot.time}`);
  }

  fetchStatus.isFetching = false;
  fetchStatus.lastFetchTime = now.toISOString();
  fetchStatus.lastFetchSuccess = !!(snapshot.athena || snapshot.xmp);
  return snapshot;
}

// ── Personal fetch ──────────────────────────────────────────────
async function fetchPersonal() {
  if (personalFetchStatus.isFetching) {
    console.log('[Fetcher] Personal fetch already in progress, skipping...');
    return null;
  }

  personalFetchStatus.isFetching = true;
  const now = new Date();
  const targetDate = formatDate(now);
  console.log(`[Fetcher] Personal fetch: getting data for ${targetDate}`);
  const snapshot = { time: now.toISOString(), xmp: null, af: null, ad: null };

  personalFetchStatus.sources.xmp.status = 'fetching';
  try {
    snapshot.xmp = await runScript('fetch-personal-xmp-api.sh', [], 180000);
    personalFetchStatus.sources.xmp.status = 'success';
    personalFetchStatus.sources.xmp.lastSuccess = now.toISOString();
    personalFetchStatus.sources.xmp.lastTime = now.toISOString();
  } catch (err) {
    personalFetchStatus.sources.xmp.status = 'error';
    personalFetchStatus.sources.xmp.lastError = err.message;
    personalFetchStatus.sources.xmp.lastTime = now.toISOString();
    console.error('[Fetcher] Personal XMP failed:', err.message);
  }

  personalFetchStatus.sources.ad.status = 'fetching';
  try {
    snapshot.ad = await runScript('fetch-personal-ad.sh', [], 180000);
    personalFetchStatus.sources.ad.status = 'success';
    personalFetchStatus.sources.ad.lastSuccess = now.toISOString();
    personalFetchStatus.sources.ad.lastTime = now.toISOString();
  } catch (err) {
    personalFetchStatus.sources.ad.status = 'error';
    personalFetchStatus.sources.ad.lastError = err.message;
    personalFetchStatus.sources.ad.lastTime = now.toISOString();
    console.error('[Fetcher] Personal AD failed:', err.message);
  }

  personalFetchStatus.sources.af.status = 'fetching';
  try {
    snapshot.af = await runScript('fetch-personal-af.sh', [], 180000);
    personalFetchStatus.sources.af.status = 'success';
    personalFetchStatus.sources.af.lastSuccess = now.toISOString();
    personalFetchStatus.sources.af.lastTime = now.toISOString();
  } catch (err) {
    personalFetchStatus.sources.af.status = 'error';
    personalFetchStatus.sources.af.lastError = err.message;
    personalFetchStatus.sources.af.lastTime = now.toISOString();
    console.error('[Fetcher] Personal AF failed:', err.message);
  }

  if (snapshot.xmp || snapshot.af || snapshot.ad) {
    const dayData = loadPersonalDayData(targetDate);
    dayData.snapshots.push(snapshot);
    savePersonalDayData(targetDate, dayData);
    console.log(`[Fetcher] Personal snapshot saved for ${targetDate}`);
  }

  personalFetchStatus.isFetching = false;
  personalFetchStatus.lastFetchTime = now.toISOString();
  personalFetchStatus.lastFetchSuccess = !!(snapshot.xmp || snapshot.af || snapshot.ad);
  return snapshot;
}

// ── Utilities ───────────────────────────────────────────────────
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getAvailableDates() {
  try {
    const files = fs.readdirSync(DATA_DIR);
    return files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

module.exports = {
  fetchAll,
  fetchPersonal,
  getStatus,
  getPersonalStatus,
  checkProxyHealth,
  loadDayData,
  loadPersonalDayData,
  getAvailableDates,
  formatDate,
};
