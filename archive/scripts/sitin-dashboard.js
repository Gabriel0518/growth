const { chromium } = require('playwright');

const USER = process.env.DASHBOARD_USER;
const PASS = process.env.DASHBOARD_PASS;

if (!USER || !PASS) {
  console.error('Missing DASHBOARD_USER or DASHBOARD_PASS in environment');
  process.exit(1);
}

// Product config: display name → { menuText, urlKey }
// menuText: exact text in the sidebar menu
// urlKey: ?key= param to navigate directly (null = use menuText click only)
const PRODUCTS = [
  { name: 'GraceChat',  menuText: 'GraceChat',  urlKey: null },
  { name: 'Dora',       menuText: 'Dora',        urlKey: null },
  { name: 'Dora And',   menuText: 'Dora And',    urlKey: null },
  { name: 'Luma',       menuText: 'Luma',        urlKey: null },
  { name: 'Doni',       menuText: 'Doni',        urlKey: null },
  { name: 'Romi',       menuText: 'Romi',        urlKey: null },
  { name: 'Romi And',   menuText: 'Romi And',    urlKey: null },
  { name: 'Jovia And',  menuText: 'Jovia And',   urlKey: null },
  { name: 'Kira',       menuText: 'Kira',        urlKey: 'kira-growth' },
  { name: 'Kira And',   menuText: 'Kira And',    urlKey: null },
];

// Optional date range from CLI args: node sitin-dashboard.js [startDate] [endDate]
// Format: YYYY-MM-DD. If omitted, uses dashboard default (today).
// NOTE: The date picker is INCLUSIVE on both ends. To query a single day,
// use the SAME date for start and end, e.g. 2026-03-24 2026-03-24.
const ARG_START_DATE = process.argv[2] || null;
const ARG_END_DATE = process.argv[3] || null;

const BASE_URL = 'https://admin.sitin.ai';
const DATA_URL = `${BASE_URL}/data-analysis`;

async function login(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  
  // Click Login button in top right
  const loginBtn = await page.$('text="Login"');
  if (loginBtn) {
    await loginBtn.click();
    await page.waitForTimeout(1000);
  }
  
  // Fill the login form
  await page.fill('#basic_username', USER);
  await page.fill('#basic_password', PASS);
  
  // Click Submit
  const submitBtn = await page.$('button:has-text("Submit")');
  if (submitBtn) {
    await submitBtn.click();
  }
  
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle');
  console.log('Logged in successfully');
}

async function extractData(page) {
  // Wait for the Paying Users section to load
  await page.waitForTimeout(2000);
  
  // Extract Overall Total and New Users Total from the Paying Users section
  const data = await page.evaluate(() => {
    const text = document.body.innerText;
    
    // Find the Paying Users section
    // The layout shows: Overall (Total: $X, Payments: Y) | Subscriptions | Coins | New Users (Payments: Y, Total: $X)
    
    let totalRevenue = 'N/A';
    let newUserRevenue = 'N/A';
    
    // Look for cards/sections in the Paying Users area
    // Try finding by the card structure
    const allElements = document.querySelectorAll('div, span, p');
    
    let overallCard = null;
    let newUsersCard = null;
    
    for (const el of allElements) {
      const t = el.textContent?.trim();
      // Find the Overall card - it contains "Overall" and "Total:" but not other section keywords
      if (t && el.childElementCount <= 10) {
        if (t.startsWith('Overall') && t.includes('Total:') && t.includes('Payments:') && !t.includes('Subscriptions')) {
          overallCard = el;
        }
        if (t.startsWith('New Users') && t.includes('Total:') && !t.includes('Overall')) {
          newUsersCard = el;
        }
      }
    }
    
    if (overallCard) {
      const match = overallCard.textContent.match(/Total:\s*\$?([\d,]+\.?\d*)/);
      if (match) totalRevenue = '$' + match[1];
    }
    
    if (newUsersCard) {
      const match = newUsersCard.textContent.match(/Total:\s*\$?([\d,]+\.?\d*)/);
      if (match) newUserRevenue = '$' + match[1];
    }
    
    return { totalRevenue, newUserRevenue };
  });
  
  return data;
}

async function setDateRange(page, startDate, endDate) {
  // The date range picker has two input fields for start and end dates
  // Format: YYYY-MM-DD
  const dateInputs = await page.$$('.ant-picker-input input');
  
  if (dateInputs.length >= 2) {
    // Clear and fill start date
    await dateInputs[0].click({ clickCount: 3 });
    await dateInputs[0].fill(startDate);
    await page.waitForTimeout(500);
    
    // Clear and fill end date
    await dateInputs[1].click({ clickCount: 3 });
    await dateInputs[1].fill(endDate);
    await page.waitForTimeout(500);
    
    // Press Enter to close any date picker popup
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    
    // Click the Search button
    const searchBtn = await page.$('button:has-text("Search")');
    if (searchBtn) {
      await searchBtn.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000);
      console.log(`Date range set: ${startDate} → ${endDate}`);
    } else {
      console.error('Search button not found');
    }
  } else {
    console.error(`Expected 2 date inputs, found ${dateInputs.length}`);
  }
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  
  await login(page);
  
  // Navigate to data analysis page
  await page.goto(DATA_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Set custom date range if provided
  if (ARG_START_DATE && ARG_END_DATE) {
    await setDateRange(page, ARG_START_DATE, ARG_END_DATE);
  }

  const results = [];

  for (const product of PRODUCTS) {
    try {
      // Navigate directly via URL if urlKey is provided, otherwise click sidebar
      if (product.urlKey) {
        await page.goto(`${DATA_URL}?key=${product.urlKey}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(2000);
      } else {
        const menuItem = await page.$(`.ant-menu-item:has-text("${product.menuText}")`);
        if (!menuItem) {
          console.error(`Product menu item not found: ${product.name}`);
          results.push({ product: product.name, totalRevenue: 'N/A', newUserRevenue: 'N/A' });
          continue;
        }
        await menuItem.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);
      }

      // Re-apply date range after switching product (page may reset)
      if (ARG_START_DATE && ARG_END_DATE) {
        await setDateRange(page, ARG_START_DATE, ARG_END_DATE);
      }

      const data = await extractData(page);
      results.push({ product: product.name, ...data });
      console.log(`${product.name}: Total=${data.totalRevenue}, NewUsers=${data.newUserRevenue}`);

    } catch (err) {
      console.error(`Error for ${product.name}: ${err.message}`);
      results.push({ product: product.name, totalRevenue: 'Error', newUserRevenue: 'Error' });
    }
  }

  await browser.close();

  // Output JSON
  console.log('\n---RESULTS_JSON---');
  console.log(JSON.stringify(results, null, 2));
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
