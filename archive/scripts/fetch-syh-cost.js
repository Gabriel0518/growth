const { chromium } = require('playwright');

const USER = process.env.XMP_USER;
const PASS = process.env.XMP_PASS;

if (!USER || !PASS) {
  console.error('Missing XMP_USER or XMP_PASS in environment');
  process.exit(1);
}

const BASE_URL = 'https://xmp.mobvista.com';
const CAMPAIGN_URL = `${BASE_URL}/ads_manage/summary/campaign`;

async function login(page) {
  await page.goto(BASE_URL + '/login', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  const allInputs = await page.$$('input');
  const visibleInputs = [];
  for (const inp of allInputs) {
    const visible = await inp.evaluate(e => e.offsetParent !== null);
    if (visible) visibleInputs.push(inp);
  }

  console.log(`Found ${visibleInputs.length} visible inputs`);

  if (visibleInputs.length >= 2) {
    await visibleInputs[0].click();
    await page.waitForTimeout(200);
    await page.keyboard.type(USER, { delay: 30 });
    await page.waitForTimeout(500);

    await visibleInputs[1].click();
    await page.waitForTimeout(200);
    await page.keyboard.type(PASS, { delay: 30 });
    await page.waitForTimeout(500);

    const loginBtn = await page.$('button:has-text("Log in"), button:has-text("登录")');
    if (loginBtn) {
      await loginBtn.click();
      console.log('Clicked login button');
    }

    await page.waitForTimeout(8000);
    await page.waitForLoadState('networkidle');

    const url = page.url();
    console.log('Current URL after login:', url);
    if (url.includes('/login')) {
      console.error('Still on login page - credentials may be wrong');
    } else {
      console.log('Logged in successfully');
    }
  }
}

async function closeTutorial(page) {
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(500);
    const dismissed = await page.evaluate(() => {
      if (window.driverObj && typeof window.driverObj.destroy === 'function') {
        window.driverObj.destroy();
        return 'api';
      }
      const popover = document.getElementById('driver-popover-content') || document.querySelector('.driver-popover');
      if (popover) {
        const closeBtn = popover.querySelector('.driver-popover-close-btn');
        const buttons = popover.querySelectorAll('button');
        if (closeBtn) { closeBtn.click(); return 'close'; }
        for (const btn of buttons) {
          const text = btn.textContent.trim();
          if (['跳过', 'Skip', '关闭', 'Close', '完成', 'Done', '知道了', 'Got it'].includes(text)) {
            btn.click();
            return 'skip-' + text;
          }
        }
        for (const btn of buttons) {
          const text = btn.textContent.trim();
          if (['下一步', 'Next', '下一个'].includes(text)) {
            btn.click();
            return 'next';
          }
        }
        popover.remove();
        document.querySelectorAll('.driver-overlay, svg.driver-overlay').forEach(el => el.remove());
        return 'removed';
      }
      return null;
    });
    if (!dismissed) break;
    console.log(`Tutorial step dismissed: ${dismissed}`);
    if (dismissed === 'api' || dismissed === 'removed') break;
  }
  await page.evaluate(() => {
    document.querySelectorAll('.driver-popover, .driver-overlay, #driver-popover-content, svg.driver-overlay').forEach(el => el.remove());
    document.body.style.pointerEvents = '';
  });
  await page.waitForTimeout(500);
}

async function searchSyh(page) {
  // Navigate to campaign page
  await page.goto(CAMPAIGN_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);
  console.log('Navigated to:', page.url());

  await closeTutorial(page);

  // Find the campaign search input (广告系列 search box)
  // Look for input with placeholder containing "搜索" or "广告系列"
  const searchInput = await page.$('input[placeholder*="搜索"], input[placeholder*="广告系列"], input[placeholder*="Search"]');

  if (searchInput) {
    await searchInput.click();
    await page.waitForTimeout(300);
    await page.keyboard.type('syh', { delay: 50 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    console.log('Searched for "syh"');
  } else {
    // Fallback: try to find the filter/search area by the label "广告系列"
    console.log('Primary search input not found, trying alternative...');
    const inputs = await page.$$('input');
    for (const inp of inputs) {
      const placeholder = await inp.getAttribute('placeholder').catch(() => '');
      const visible = await inp.evaluate(e => e.offsetParent !== null);
      if (visible) {
        console.log(`  Input placeholder: "${placeholder}"`);
      }
    }
    // Try clicking the filter dropdown for 广告系列
    const filterBtn = await page.$('text=广告系列');
    if (filterBtn) {
      await filterBtn.click();
      await page.waitForTimeout(1000);
    }
    // Now try the search input again
    const retryInput = await page.$('input[placeholder*="搜索"], input[placeholder*="请输入"]');
    if (retryInput) {
      await retryInput.click();
      await page.waitForTimeout(300);
      await page.keyboard.type('syh', { delay: 50 });
      await page.waitForTimeout(500);
      await page.keyboard.press('Enter');
      console.log('Searched for "syh" via fallback');
    }
  }

  await page.waitForTimeout(5000);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
}

async function extractSyhCost(page) {
  // Extract the summary row's cost (花费) value
  // The summary row (汇总) is typically the first data row showing totals
  const cost = await page.evaluate(() => {
    // Strategy 1: Look for the summary row "汇总" and get the cost column
    const allCells = document.querySelectorAll('td, div[class*="cell"], span');
    let summaryRow = null;

    // Find element containing "汇总"
    for (const cell of allCells) {
      if (cell.textContent.trim() === '汇总') {
        summaryRow = cell.closest('tr') || cell.closest('[class*="row"]') || cell.parentElement;
        break;
      }
    }

    if (summaryRow) {
      // Look for USD value in the summary row
      const rowText = summaryRow.textContent || '';
      const usdMatches = [...rowText.matchAll(/([\d,]+\.?\d*)\s*USD/g)];
      if (usdMatches.length > 0) {
        // First USD match should be the cost (花费)
        return usdMatches[0][1] + ' USD';
      }
    }

    // Strategy 2: Walk through all text looking for a summary cost pattern
    // The page shows "汇总" row with cost as the first numeric column
    const body = document.body.textContent || '';
    // Look for pattern near "汇总"
    const summaryIdx = body.indexOf('汇总');
    if (summaryIdx !== -1) {
      const after = body.substring(summaryIdx, summaryIdx + 200);
      const match = after.match(/([\d,]+\.?\d*)\s*USD/);
      if (match) return match[1] + ' USD';
    }

    return null;
  });

  return cost;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await login(page);
  await searchSyh(page);

  // Take debug screenshot
  await page.screenshot({ path: '/tmp/xmp-syh-debug.png', fullPage: false });
  console.log('Debug screenshot saved to /tmp/xmp-syh-debug.png');

  const cost = await extractSyhCost(page);

  await browser.close();

  if (cost) {
    console.log('\n---RESULT---');
    console.log(cost);
  } else {
    console.error('Failed to extract syh cost');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
