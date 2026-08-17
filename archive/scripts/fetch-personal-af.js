// Fetch personal AF dashboard data (苏屹恒的面板)
// Output: JSON array of { product, channel, installs, revenueActual, revenueLTV }
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const envContent = fs.readFileSync('/etc/environment', 'utf8');
const envMap = {};
envContent.split('\n').forEach(line => {
  const m = line.match(/^(\w+)=(.*)$/);
  if (m) envMap[m[1]] = m[2].replace(/^["']|["']$/g, '');
});
const AF_USER = envMap.AF_USER;
const AF_PASS = envMap.AF_PASS;
const PROXY = process.env.AF_PROXY || ''; // empty = direct
const DEBUG_DIR = path.resolve(__dirname, '..', 'output', 'af-debug');
const PROFILE_DIR = path.resolve(__dirname, '..', 'state', 'af-personal-profile');
const RETRY_DELAYS_MS = [5000, 15000, 30000];
const DASHBOARD_URL = 'https://hq1.appsflyer.com/unified-ltv/dashboard#v=NjMxNjgx';

const NAME_MAP = {
  'Doni: Start Real Companionship': 'Doni',
  'Dora: Find Real Companionship': 'Dora And',
  'Romi (iOS)': 'Romi iOS',
  'Dora: Create and connect': 'Dora iOS',
  'Jovia Dating app: Meet & Date': 'Jovia And',
  'Romi: Swipe, Chat & Connect': 'Romi And',
  'Luma: Make Friends, Have Fun': 'Luma',
  'GraceChat(IOS)': 'GraceChat',
  'Kira: Find Your Romance': 'Kira And',
  'Kira: Creative Community': 'Kira iOS',
  'Kira: Face Effects': 'Kira iOS',
};

const CHANNEL_MAP = {
  'googleadwords_int': 'GG',
  'Facebook Ads': 'FB',
  'tiktokglobal_int': 'TT',
};

function parseMoney(val) {
  if (!val || val === 'N/A') return null;
  const cleaned = String(val).replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseNum(val) {
  if (!val || val === 'N/A') return null;
  const cleaned = String(val).replace(/[,\s]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

function ensureDirs() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

function ts() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function saveDebug(page, prefix) {
  try {
    ensureDirs();
    const stamp = ts();
    await page.screenshot({ path: path.join(DEBUG_DIR, `${prefix}-${stamp}.png`), fullPage: true });
    fs.writeFileSync(path.join(DEBUG_DIR, `${prefix}-${stamp}.html`), await page.content(), 'utf8');
  } catch (_) {}
}

function attachNetworkLogging(page, prefix) {
  page.on('requestfailed', req => {
    console.error(`[${prefix}] requestfailed ${req.method()} ${req.url()} -> ${req.failure()?.errorText || 'unknown'}`);
  });
  page.on('response', res => {
    const url = res.url();
    if (url.includes('appsflyer.com/auth/login') || url.includes('appsflyer.com/unified-ltv')) {
      console.error(`[${prefix}] response ${res.status()} ${url}`);
    }
  });
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.error(`[${prefix}] browser console ${msg.type()}: ${msg.text()}`);
    }
  });
}

async function withRetries(task, label, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      if (i > 1) console.error(`[AF personal] Retry ${i}/${retries}: ${label}`);
      return await task(i);
    } catch (err) {
      lastErr = err;
      console.error(`[AF personal] Attempt ${i}/${retries} failed: ${label} -> ${err.message}`);
      if (i < retries) {
        const delay = RETRY_DELAYS_MS[i - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        console.error(`[AF personal] Waiting ${delay}ms before next retry`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function launchPersistentContext() {
  ensureDirs();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    ...(PROXY ? { proxy: { server: PROXY } } : {}),
    args: ['--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Hong_Kong',
    viewport: { width: 1920, height: 1080 },
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  return context;
}

async function isLoggedIn(page) {
  const url = page.url();
  if (url.includes('/auth/login')) return false;
  return await page.locator('input[name="username"]').count().then(c => c === 0).catch(() => true);
}

async function loginIfNeeded(page) {
  await page.goto('https://hq1.appsflyer.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  if (await isLoggedIn(page)) {
    console.error('[AF personal] Reused persisted login state');
    return;
  }

  await page.waitForSelector('input[name="username"]', { timeout: 20000 });
  await page.waitForSelector('input[name="password"]', { timeout: 20000 });
  await page.fill('input[name="username"]', AF_USER);
  await page.fill('input[name="password"]', AF_PASS);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !location.href.includes('/auth/login'), { timeout: 20000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  console.error('[AF personal] Login completed and persisted into personal profile');
}

async function expandMediaSources(page) {
  const mediaSourceNames = ['googleadwords_int', 'Facebook Ads', 'tiktokglobal_int'];
  for (const name of mediaSourceNames) {
    try {
      const el = await page.locator(`text="${name}"`).first();
      await el.waitFor({ timeout: 10000 });
      const box = await el.boundingBox();
      if (box) {
        await page.mouse.click(box.x - 30, box.y + box.height / 2);
        await page.waitForTimeout(3000);
      }
    } catch (e) {
      console.error(`[AF personal] Expand skipped for ${name}: ${e.message}`);
    }
  }
}

async function extractPersonalRows(page) {
  // MUI DataGrid virtualizes rows — only visible rows are in the DOM.
  // We scroll through the grid to collect all rows, then sort by rowIndex
  // and assign parent channels based on ordering (not scroll position).
  const rawData = await page.evaluate(async () => {
    const container = document.querySelector('.MuiDataGrid-virtualScroller');
    if (!container) return [];

    // Map: dataId → { depth, rowIdx, cells }
    const rowMap = new Map();

    function harvestRows() {
      const rows = document.querySelectorAll('.MuiDataGrid-row');
      for (const row of rows) {
        const dataId = row.getAttribute('data-id') || '';
        const rowIdx = parseInt(row.getAttribute('data-rowindex') || '-1', 10);
        const cells = Array.from(row.querySelectorAll('.MuiDataGrid-cell, [role="gridcell"]'))
          .map(c => c.textContent.trim());
        const depth = row.className.includes('depth-0') ? 0
          : row.className.includes('depth-1') ? 1 : -1;
        // Always update (later renders may have fresher data)
        rowMap.set(dataId, { depth, rowIdx, cells });
      }
    }

    // Harvest initial rows
    harvestRows();

    // Scroll down in increments to reveal virtualized rows
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    const step = Math.floor(clientHeight * 0.7);
    let scrollTop = 0;

    while (scrollTop < scrollHeight) {
      scrollTop += step;
      container.scrollTop = scrollTop;
      await new Promise(r => setTimeout(r, 300));
      harvestRows();
    }

    // Final scroll to very bottom
    container.scrollTop = scrollHeight;
    await new Promise(r => setTimeout(r, 300));
    harvestRows();

    // Sort all rows by rowIndex, then assign parent channels by ordering
    const allRows = Array.from(rowMap.values()).sort((a, b) => a.rowIdx - b.rowIdx);

    const results = [];
    let currentChannel = '';
    for (const row of allRows) {
      if (row.depth === 0) {
        currentChannel = row.cells[0] || '';
      } else if (row.depth === 1 && currentChannel) {
        results.push({ channel: currentChannel, cells: row.cells });
      }
    }

    return results;
  });

  const output = [];
  for (const row of rawData) {
    const appName = row.cells[0];
    const channel = CHANNEL_MAP[row.channel];
    const product = NAME_MAP[appName];
    if (!product || !channel) continue;
    output.push({
      product,
      channel,
      installs: parseNum(row.cells[2]),
      revenueActual: parseMoney(row.cells[3]),
      revenueLTV: parseMoney(row.cells[4]),
    });
  }

  return output;
}

async function runOnce() {
  const context = await launchPersistentContext();
  const page = context.pages()[0] || await context.newPage();
  attachNetworkLogging(page, 'AF personal');
  try {
    await loginIfNeeded(page);
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.body.textContent.includes('$') && document.body.textContent.includes('Totals'), { timeout: 30000 });
    await page.waitForTimeout(3000);

    await expandMediaSources(page);
    await page.waitForTimeout(3000);

    const output = await extractPersonalRows(page);
    if (!output.length) throw new Error('Personal AF table parsed 0 rows');
    return output;
  } catch (err) {
    await saveDebug(page, 'af-personal-fail');
    throw err;
  } finally {
    await context.close();
  }
}

async function run() {
  const output = await withRetries(() => runOnce(), 'personal AF dashboard fetch', 3);
  console.log(JSON.stringify(output, null, 2));
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
