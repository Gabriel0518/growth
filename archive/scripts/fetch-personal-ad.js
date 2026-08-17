// Fetch Adjust data (Luma iOS + Romi iOS FB campaigns)
// Output: JSON array of { product, channel, installs, revenueActual, revenueLTV }
const { chromium } = require('playwright');
const fs = require('fs');

const envContent = fs.readFileSync('/etc/environment', 'utf8');
const envMap = {};
envContent.split('\n').forEach(line => {
  const m = line.match(/^(\w+)=(.*)$/);
  if (m) envMap[m[1]] = m[2].replace(/^["']|["']$/g, '');
});
const AD_USER = envMap.AD_USER;
const AD_PASS = envMap.AD_PASS;
// Proxy disabled – direct connection
// const PROXY = 'http://127.0.0.1:7890';

const TARGET_URL = 'https://suite.adjust.com/datascape/report?app_token__in=%22i5kqmwl2p5vk%22%2C%22ummlnbaapqtc%22&utc_offset=%2B08%3A00&reattributed=all&attribution_source=first&ad_spend_mode=network&date_period=today&cohort_maturity=immature&sandbox=false&sdk_signature_enforcement_status=all&fingerprint_status=all&ironsource_mode=ironsource&digital_turbine_mode=digital_turbine&campaign_network__contains__column=%22syh%22&dimensions=app%2Ccampaign_network%2Cadgroup_network%2Ccreative_network&installs__column_heatmap=%23C19CFF&metrics=installs%2Cad_purchase_revenue%2Cad_purchase_d0_revenue_cohort_cal%2Cad_purchase_events%2Cad_purchase_d0_events_cohort_cal%2Cdaus&sort=-installs&table_view=pivot&parent_report_id=390613';

const NAME_MAP = {
  'Luma - iOS': 'Luma',
  'Romi - iOS': 'Romi iOS',
};

function parseMoney(val) {
  if (!val || val === 'N/A' || val === '-') return null;
  const cleaned = String(val).replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseNum(val) {
  if (!val || val === 'N/A' || val === '-') return null;
  const cleaned = String(val).replace(/[,\s]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? null : num;
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'Asia/Shanghai', viewport: { width: 1920, height: 1080 },
  });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  const page = await ctx.newPage();

  // Login
  await page.goto('https://suite.adjust.com/login', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.fill('input[name="email"]', AD_USER);
  await page.fill('input[name="password"]', AD_PASS);
  await page.waitForTimeout(500);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(15000);

  if (page.url().includes('/login')) {
    throw new Error('Adjust login failed');
  }

  // Navigate to report
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return text.includes('Installs') || text.includes('install') || text.includes('Luma') || text.includes('Romi');
  }, { timeout: 30000 });
  await page.waitForTimeout(10000);

  // Extract table: cells = [App, Installs, ad_purchase revenue, 0D ad_purchase revenue, ad_purchase events, 0D events, DAU]
  const rawData = await page.evaluate(() => {
    const rows = document.querySelectorAll('[role="row"]');
    const results = [];
    for (const row of rows) {
      const cells = row.querySelectorAll('[role="cell"], [role="gridcell"]');
      if (cells.length >= 3) {
        const cellTexts = Array.from(cells).map(c => c.textContent.trim());
        results.push(cellTexts);
      }
    }
    return results;
  });

  await browser.close();

  // Parse
  const output = [];
  for (const cells of rawData) {
    const appName = cells[0];
    const product = NAME_MAP[appName];
    if (!product) continue; // Skip Totals row and unknown apps

    output.push({
      product,
      channel: 'FB', // These are all FB campaigns
      installs: parseNum(cells[1]),
      revenueActual: parseMoney(cells[2]),
      revenueLTV: parseMoney(cells[3]),
    });
  }

  console.log(JSON.stringify(output, null, 2));
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
