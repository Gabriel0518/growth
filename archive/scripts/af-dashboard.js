const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AF_USER = process.env.AF_USER;
const AF_PASS = process.env.AF_PASS;
const PROXY = process.env.AF_PROXY || ''; // empty = direct
const DEBUG_DIR = path.resolve(__dirname, '..', 'output', 'af-debug');
const PROFILE_DIR = path.resolve(__dirname, '..', 'state', 'af-summary-profile');
const RETRY_DELAYS_MS = [5000, 15000, 30000];

const NAME_MAP = {
  'Doni: Start Real Companionship': 'Doni',
  'Dora: Find Real Companionship': 'Dora And',
  'Romi (iOS)': 'Romi iOS',
  'Dora: Create and connect': 'Dora iOS',
  'Jovia Dating app: Meet & Date': 'Jovia And',
  'Romi: Swipe, Chat & Connect': 'Romi And',
  'Luma: Make Friends, Have Fun': 'Luma',
  'GraceChat(IOS)': 'GraceChat',
  'Kira: Creative Community': 'Kira iOS',
  'Kira: Find Your Romance': 'Kira And',
  'Kira: Face Effects': 'Kira iOS',
};

function buildDashUrl(startDate, endDate) {
  const appIds = 'com.doni.appa,com.doramatch.app,com.qiga.vio,com.romiandroid.appmatch,id1658972379,id6746109957,id6746466099,id6746782904,id6759697686,com.meraki.kira';
  const q = Buffer.from(JSON.stringify({ view_type: 'unified', date: [startDate, endDate], isSsot: false, isPerWidget: false })).toString('base64');
  return `https://hq1.appsflyer.com/unified-ltv/dashboard#appIds=${appIds}&q=${q}&v=NTQwMTg1`;
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
      if (i > 1) console.error(`[AF] Retry ${i}/${retries}: ${label}`);
      return await task(i);
    } catch (err) {
      lastErr = err;
      console.error(`[AF] Attempt ${i}/${retries} failed: ${label} -> ${err.message}`);
      if (i < retries) {
        const delay = RETRY_DELAYS_MS[i - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        console.error(`[AF] Waiting ${delay}ms before next retry`);
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
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
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
    console.error('[AF] Reused persisted login state');
    return;
  }

  await page.waitForSelector('input[name="username"]', { timeout: 20000 });
  await page.waitForSelector('input[name="password"]', { timeout: 20000 });
  await page.fill('input[name="username"]', AF_USER);
  await page.fill('input[name="password"]', AF_PASS);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !location.href.includes('/auth/login'), { timeout: 20000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  console.error('[AF] Login completed and persisted into profile');
}

async function runOnce(startDate, endDate) {
  const context = await launchPersistentContext();
  const page = context.pages()[0] || await context.newPage();
  attachNetworkLogging(page, 'AF');
  try {
    await loginIfNeeded(page);
    const dashUrl = buildDashUrl(startDate, endDate);
    await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('tr, [class*="row"]');
      let dollarRows = 0;
      rows.forEach(r => { if (r.textContent.includes('$')) dollarRows++; });
      return dollarRows >= 3;
    }, { timeout: 30000 });

    const tableData = await page.evaluate(() => {
      const results = [];
      const rows = document.querySelectorAll('tr, [class*="row"]');
      rows.forEach(row => {
        const text = row.textContent.trim();
        if (text.includes('$') && text.length < 500) {
          const cells = row.querySelectorAll('td, [class*="cell"], [role="cell"], [role="gridcell"]');
          if (cells.length >= 3) results.push(Array.from(cells).map(c => c.textContent.trim()));
        }
      });
      return results;
    });

    const output = [];
    for (const cells of tableData) {
      let appName = '', installs = '', revenueActual = '', revenueLTV = '';
      for (const cell of cells) {
        const trimmed = cell.trim();
        if (!trimmed) continue;
        if (!appName && trimmed.match(/[a-zA-Z]/) && !trimmed.startsWith('$') && !trimmed.match(/^[\d,]+$/)) appName = trimmed;
        if (!installs && !revenueActual && trimmed.match(/^[\d,]+$/) && appName) installs = trimmed;
        if (!revenueActual && trimmed.startsWith('$')) revenueActual = trimmed;
        else if (revenueActual && !revenueLTV && trimmed.startsWith('$')) revenueLTV = trimmed;
      }
      if (!appName || !revenueActual) continue;
      output.push({ product: NAME_MAP[appName] || appName, afName: appName, installs: installs || '0', revenueActual, revenueLTV: revenueLTV || 'N/A' });
    }

    if (!output.length) throw new Error('AF table parsed 0 rows');
    return output;
  } catch (err) {
    await saveDebug(page, 'af-dashboard-fail');
    throw err;
  } finally {
    await context.close();
  }
}

async function run() {
  let startDate, endDate;
  if (process.argv[2] && process.argv[3]) {
    startDate = process.argv[2];
    endDate = process.argv[3];
  } else {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    startDate = endDate = `${yyyy}-${mm}-${dd}`;
  }
  if (!AF_USER || !AF_PASS) {
    console.error('AF_USER and AF_PASS must be set in environment');
    process.exit(1);
  }
  const output = await withRetries(() => runOnce(startDate, endDate), 'AF dashboard fetch', 3);
  console.log(JSON.stringify(output, null, 2));
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
