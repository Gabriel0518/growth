// Fetch personal XMP report "syh" (苏屹恒的消耗数据)
// Output: JSON array of { product, channel, cost, cpm, cpc }
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const envContent = fs.readFileSync('/etc/environment', 'utf8');
const envMap = {};
envContent.split('\n').forEach(line => {
  const m = line.match(/^(\w+)=(.*)$/);
  if (m) envMap[m[1]] = m[2].replace(/^["']|["']$/g, '');
});
const XMP_USER = envMap.XMP_USER;
const XMP_PASS = envMap.XMP_PASS;
// Proxy disabled – direct connection
// const PROXY = 'http://127.0.0.1:7890';
const DEBUG_DIR = path.resolve(__dirname, '..', 'output', 'xmp-debug');
const RETRY_DELAYS_MS = [5000, 15000, 30000];

const NAME_MAP = {
  'Dora: Create and connect': 'Dora iOS',
  'Doni: Easy Connection': 'Doni',
  'Dora: Find Real Companionship': 'Dora And',
  'Jovia: Find Real Love': 'Jovia And',
  'Luma: Make Friends, Have Fun': 'Luma',
  'Romi: Make Friends, Have Fun': 'Romi iOS',
  'Romi: Swipe, Chat & Connect': 'Romi And',
  'GraceChat': 'GraceChat',
  'Kira: Find Your Romance': 'Kira And',
  'Kira: Creative Community': 'Kira iOS',
  'Kira: Face Effects': 'Kira iOS',
};

const CHANNEL_MAP = {
  'Meta': 'FB',
  'TikTok': 'TT',
  'Google': 'GG',
};

// All known channel names on XMP for row validation
const KNOWN_CHANNELS = new Set(Object.keys(CHANNEL_MAP));

function parseMoney(val) {
  if (!val || val === '-' || val === 'N/A') return null;
  const cleaned = String(val).replace(/[USD$,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function ensureDebugDir() { fs.mkdirSync(DEBUG_DIR, { recursive: true }); }
function ts() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function saveDebug(page, prefix) {
  try {
    ensureDebugDir();
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
    if (url.includes('xmp.mobvista.com/m/login') || url.includes('xmp.mobvista.com/m/report')) {
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
      if (i > 1) console.error(`[XMP personal] Retry ${i}/${retries}: ${label}`);
      return await task(i);
    } catch (err) {
      lastErr = err;
      console.error(`[XMP personal] Attempt ${i}/${retries} failed: ${label} -> ${err.message}`);
      if (i < retries) {
        const delay = RETRY_DELAYS_MS[i - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        console.error(`[XMP personal] Waiting ${delay}ms before next retry`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function launchContext() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1920, height: 1080 },
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  return { browser, ctx };
}

async function login(page) {
  await page.goto('https://xmp.mobvista.com/m/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input[type="text"]', { timeout: 20000 });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 });
  await page.fill('input[type="text"]', XMP_USER);
  await page.fill('input[type="password"]', XMP_PASS);
  await page.locator('button:has-text("Log in")').click();
  await page.waitForFunction(() => !location.href.includes('/login'), { timeout: 25000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
}

async function openReportOne(page) {
  await page.goto('https://xmp.mobvista.com/m/report/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body && document.body.innerText.includes('My Reports'), { timeout: 30000 });

  const myReports = page.locator('text="My Reports"').first();
  await myReports.waitFor({ timeout: 15000 });
  await myReports.click();

  await page.waitForFunction(() => {
    const text = document.body ? document.body.innerText : '';
    return text.includes('My Reports') && text.toLowerCase().includes('syh');
  }, { timeout: 15000 }).catch(() => {});

  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('span, li, a, div'));
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };

    const clean = s => (s || '').replace(/\s+/g, ' ').trim();

    const exact = candidates.find(el => {
      const text = clean(el.textContent).toLowerCase();
      return text === 'syh' && visible(el) && el.childElementCount === 0;
    });
    if (exact) {
      exact.click();
      return { ok: true, mode: 'exact', text: clean(exact.textContent) };
    }

    const loose = candidates.find(el => {
      const text = clean(el.textContent).toLowerCase();
      return text.includes('syh') && visible(el);
    });
    if (loose) {
      loose.click();
      return { ok: true, mode: 'loose', text: clean(loose.textContent) };
    }

    return { ok: false };
  });

  if (!clicked || !clicked.ok) {
    throw new Error('Could not click personal XMP report "syh"');
  }

  console.error(`[XMP personal] Report click mode=${clicked.mode} text=${clicked.text}`);

  await page.waitForFunction(() => {
    const validChannels = ['Meta', 'TikTok', 'Google'];
    const rows = Array.from(document.querySelectorAll('tr'));
    return rows.some(row => {
      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
      if (cells.length < 5) return false;
      const product = cells[0] || '';
      const channel = cells[1] || '';
      const cost = cells[2] || '';
      return /[a-zA-Z]/.test(product)
        && !product.includes('Summary')
        && !product.includes('Product')
        && validChannels.includes(channel)
        && /\d/.test(cost);
    });
  }, { timeout: 30000 });

  await page.waitForTimeout(3000);
}

async function extractData(page) {
  const rawData = await page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const validChannels = ['Meta', 'TikTok', 'Google'];
    const isValidRow = (cells) => {
      if (!cells || cells.length < 5) return false;
      const product = cells[0] || '';
      const channel = cells[1] || '';
      const cost = cells[2] || '';
      return /[a-zA-Z]/.test(product)
        && !product.includes('Summary')
        && !product.includes('Product')
        && validChannels.includes(channel)
        && /\d/.test(cost);
    };

    const results = [];
    const pushIfValid = (cells) => {
      const normalized = cells.map(clean).filter(v => v !== '');
      if (isValidRow(normalized)) results.push(normalized.slice(0, 5));
    };

    for (const row of document.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td, th')).map(el => el.textContent || '');
      pushIfValid(cells);
    }

    if (!results.length) {
      for (const row of document.querySelectorAll('[role="row"]')) {
        const cells = Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"], td, th, .cell')).map(el => el.textContent || '');
        pushIfValid(cells);
      }
    }

    if (!results.length) {
      const text = clean(document.body ? document.body.innerText : '');
      const regex = /([A-Za-z][A-Za-z0-9: ',&]+?)\s+(Meta|TikTok|Google)\s+([\d,.]+\s*USD)\s+([\d,.]+\s*USD)\s+([\d,.]+\s*USD)/g;
      let m;
      while ((m = regex.exec(text)) !== null) {
        results.push([m[1].trim(), m[2], m[3], m[4], m[5]]);
      }
    }

    return Array.from(new Map(results.map(r => [r.join('||'), r])).values());
  });

  console.error(`[XMP personal] Extracted raw candidate rows: ${rawData.length}`);
  if (rawData.length) {
    console.error('[XMP personal] Sample row:', JSON.stringify(rawData[0]));
  }

  const output = [];
  const unmappedProducts = new Set();
  const unmappedChannels = new Set();
  for (const cells of rawData) {
    const rawProduct = cells[0].replace(/&/g, '&').trim();
    const rawChannel = cells[1];
    const product = NAME_MAP[rawProduct];
    const channel = CHANNEL_MAP[rawChannel];

    if (!product) {
      unmappedProducts.add(rawProduct);
      continue;
    }
    if (!channel) {
      unmappedChannels.add(rawChannel);
      continue;
    }

    output.push({
      product,
      channel,
      cost: parseMoney(cells[2]),
      cpm: parseMoney(cells[3]),
      cpc: parseMoney(cells[4]),
    });
  }

  if (unmappedProducts.size) {
    console.error(`[XMP personal] WARNING: Unmapped product names: ${[...unmappedProducts].join(', ')}`);
  }
  if (unmappedChannels.size) {
    console.error(`[XMP personal] WARNING: Unmapped channel names: ${[...unmappedChannels].join(', ')}`);
  }

  if (!output.length) {
    throw new Error(`Personal XMP parsed ${rawData.length} candidate rows but 0 mapped rows`);
  }

  return output;
}

async function runOnce() {
  const { browser, ctx } = await launchContext();
  const page = await ctx.newPage();
  attachNetworkLogging(page, 'XMP personal');
  try {
    await login(page);
    if (page.url().includes('/login')) {
      throw new Error('XMP login failed');
    }
    await openReportOne(page);
    const output = await extractData(page);
    return output;
  } catch (err) {
    await saveDebug(page, 'xmp-personal-fail');
    throw err;
  } finally {
    await browser.close();
  }
}

async function run() {
  const output = await withRetries(() => runOnce(), 'personal XMP dashboard fetch', 3);
  console.log(JSON.stringify(output, null, 2));
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
