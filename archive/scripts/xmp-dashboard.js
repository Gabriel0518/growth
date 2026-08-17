const { chromium } = require('playwright');

const USER = process.env.XMP_USER;
const PASS = process.env.XMP_PASS;

if (!USER || !PASS) {
  console.error('Missing XMP_USER or XMP_PASS in environment');
  process.exit(1);
}

// Optional date range: node xmp-dashboard.js [startDate] [endDate]
// Format: YYYY-MM-DD. Inclusive on both ends - use same date for single day.
const ARG_START_DATE = process.argv[2] || null;
const ARG_END_DATE = process.argv[3] || null;

// Product name mapping: XMP name → our short name
const PRODUCT_MAP = {
  'Romi: Make Friends, Have Fun': 'Romi',
  'Dora: Create and connect': 'Dora',
  'Dora: Find Real Companionship': 'Dora And',
  'Doni: Easy Connection': 'Doni',
  'Luma: Make Friends, Have Fun': 'Luma',
  'Jovia: Find Real Love': 'Jovia And',
  'Romi: Swipe, Chat & Connect': 'Romi And',
  'GraceChat': 'GraceChat',
  'Kira: Creative Community': 'Kira iOS',
  'Kira: Find Your Romance': 'Kira And',
};

const TARGET_PRODUCTS = new Set(Object.keys(PRODUCT_MAP));

const BASE_URL = 'https://xmp.mobvista.com';
const DATA_URL = `${BASE_URL}/ads_manage/summary/product`;

async function login(page) {
  await page.goto(BASE_URL + '/login', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Debug: list all inputs on the page
  const inputDebug = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    return Array.from(inputs).map((i, idx) => ({
      idx,
      type: i.type,
      placeholder: i.placeholder,
      name: i.name,
      id: i.id,
      className: i.className.substring(0, 60),
      visible: i.offsetParent !== null,
    }));
  });
  console.log('Login page inputs:', JSON.stringify(inputDebug));

  // Try filling by placeholder text
  const emailInput = await page.$('input[placeholder="Please enter"]:first-of-type');
  
  // If that doesn't work, get all visible inputs
  const allInputs = await page.$$('input');
  const visibleInputs = [];
  for (const inp of allInputs) {
    const visible = await inp.evaluate(e => e.offsetParent !== null);
    if (visible) visibleInputs.push(inp);
  }
  
  console.log(`Found ${visibleInputs.length} visible inputs`);
  
  if (visibleInputs.length >= 2) {
    // Use keyboard typing instead of fill (more reliable for React/Vue inputs)
    await visibleInputs[0].click();
    await page.waitForTimeout(200);
    await page.keyboard.type(USER, { delay: 30 });
    await page.waitForTimeout(500);
    
    await visibleInputs[1].click();
    await page.waitForTimeout(200);
    await page.keyboard.type(PASS, { delay: 30 });
    await page.waitForTimeout(500);
    
    // Click "Log in" button
    const loginBtn = await page.$('button:has-text("Log in"), button:has-text("登录")');
    if (loginBtn) {
      await loginBtn.click();
      console.log('Clicked login button');
    }
    
    await page.waitForTimeout(8000);
    await page.waitForLoadState('networkidle');
    
    // Check if still on login page
    const url = page.url();
    console.log('Current URL after login:', url);
    if (url.includes('/login')) {
      console.error('Still on login page - credentials may be wrong');
      await page.screenshot({ path: '/tmp/xmp-login-fail.png' });
    } else {
      console.log('Logged in successfully');
    }
  } else {
    console.log('Login inputs not found');
  }
}

async function closeTutorial(page) {
  // XMP uses driver.js for tutorials. The overlay intercepts all pointer events.
  // Strategy: use page.evaluate to directly manipulate DOM and dismiss the tour.
  
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(500);
    
    const dismissed = await page.evaluate(() => {
      // Try to call driver.js API to dismiss
      if (window.driverObj && typeof window.driverObj.destroy === 'function') {
        window.driverObj.destroy();
        return 'api';
      }
      
      // Find and click buttons inside the popover via JS (bypasses overlay)
      const popover = document.getElementById('driver-popover-content') || document.querySelector('.driver-popover');
      if (popover) {
        // Look for close button, skip button, or any dismiss button
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
        
        // If only "下一步/Next" available, click it to progress through the tour
        for (const btn of buttons) {
          const text = btn.textContent.trim();
          if (['下一步', 'Next', '下一个'].includes(text)) {
            btn.click();
            return 'next';
          }
        }
        
        // Last resort: remove everything
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
  
  // Final cleanup - make sure no driver.js elements remain
  await page.evaluate(() => {
    document.querySelectorAll('.driver-popover, .driver-overlay, #driver-popover-content, svg.driver-overlay').forEach(el => el.remove());
    // Also remove any pointer-events blocking style
    document.body.style.pointerEvents = '';
  });
  await page.waitForTimeout(500);
  
  console.log('Tutorial popups closed');
}

async function setDateRange(page, startDate, endDate) {
  // XMP uses iView date range picker - single readonly input 
  // Value format: "YYYY-MM-DD - YYYY-MM-DD", placeholder: "请选择时间段"
  // Since it's readonly, we need to click to open the calendar, then pick dates.
  // Alternative: directly set via JS and trigger Vue reactivity.
  
  const dateValue = `${startDate} - ${endDate}`;
  
  const success = await page.evaluate((dateVal) => {
    // Find the date input
    const inputs = document.querySelectorAll('input[placeholder="请选择时间段"]');
    const input = Array.from(inputs).find(i => i.offsetParent !== null);
    if (!input) return 'no input found';
    
    // Try to get Vue instance and set value directly
    const vueEl = input.__vue__ || input.closest('[class*="ivu"]')?.__vue__;
    if (vueEl) {
      // iView DatePicker stores dates internally
      // Navigate up to find the DatePicker component
      let comp = vueEl;
      for (let i = 0; i < 10; i++) {
        if (comp && (comp.$options?.name === 'DatePicker' || comp.handleChange || comp.dates)) {
          break;
        }
        comp = comp.$parent;
      }
    }
    
    // Simpler approach: set the native value and dispatch input event
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(input, dateVal);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    
    return 'set via native';
  }, dateValue);
  
  console.log(`Date input setter: ${success}`);
  
  // The native setter might not trigger Vue reactivity.
  // Fallback: click the input to open calendar, then use the calendar UI.
  // Let's click the input first.
  const dateInput = await page.locator('input[placeholder="请选择时间段"]').first();
  await dateInput.click({ force: true });
  await page.waitForTimeout(1000);
  
  // Take screenshot to see calendar state
  await page.screenshot({ path: '/tmp/xmp-calendar.png' });
  
  // iView calendar should now be open. We need to:
  // 1. Clear current selection by triple-clicking and typing new date
  // Or use keyboard: select all, type new value
  await dateInput.press('Control+a');
  await page.waitForTimeout(200);
  await dateInput.pressSequentially(dateValue, { delay: 30 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  
  // Verify the date was changed
  const currentVal = await dateInput.inputValue().catch(() => 'unknown');
  console.log(`Date input value after set: ${currentVal}`);
  
  if (currentVal.includes(startDate)) {
    console.log(`Date range set: ${startDate} → ${endDate}`);
  } else {
    console.log('Date may not have been set correctly, taking screenshot');
    await page.screenshot({ path: '/tmp/xmp-date-after.png' });
  }
}

async function extractData(page) {
  // Close tutorial first
  await closeTutorial(page);
  
  await page.waitForTimeout(3000);
  
  // Extract data using a more targeted approach:
  // Find <a> or text elements with product names, then find the cost in the same table row
  const data = await page.evaluate(() => {
    const results = [];
    
    const productPatterns = [
      'Romi: Make Friends, Have Fun',
      'Dora: Create and connect',
      'Dora: Find Real Companionship',
      'Doni: Easy Connection',
      'Luma: Make Friends, Have Fun',
      'Jovia: Find Real Love',
      'Romi: Swipe, Chat & Connect',
      'GraceChat',
      'Kira: Creative Community',
      'Kira: Find Your Romance',
    ];
    
    // Find links (<a>) containing product names - XMP shows products as clickable links
    const links = document.querySelectorAll('a');
    
    for (const prod of productPatterns) {
      for (const link of links) {
        const text = link.textContent?.trim();
        if (text !== prod) continue;
        
        // Found the product link. Walk up to find the table row element.
        // Look for the nearest ancestor that represents a row (contains USD values).
        // But stop early - we want the SMALLEST container that has exactly one USD cost
        // which is the row for this specific product.
        let row = link.parentElement;
        let found = false;
        
        for (let i = 0; i < 15 && row; i++) {
          const rowText = row.textContent || '';
          
          // This row should contain the product name and USD values
          // but should NOT contain other product names (that would mean we went too far up)
          if (!rowText.includes(prod)) { row = row.parentElement; continue; }
          
          const containsOtherProducts = productPatterns.some(p => 
            p !== prod && rowText.includes(p)
          );
          
          // Also check it doesn't contain "汇总" (summary row)
          if (containsOtherProducts || rowText.includes('汇总')) {
            // We went too far up, use the previous level
            break;
          }
          
          // Check if this level has USD values
          const usdMatches = [...rowText.matchAll(/([\d,]+\.?\d*)\s*USD/g)];
          if (usdMatches.length > 0) {
            // First USD value in the row = 花费 (cost)
            results.push({
              xmpName: prod,
              cost: usdMatches[0][1] + ' USD',
            });
            found = true;
            break;
          }
          
          row = row.parentElement;
        }
        
        if (found) break;
      }
    }
    
    return results;
  });
  
  return data;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  
  await login(page);
  
  // Navigate to product summary page
  await page.goto(DATA_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);
  console.log('Navigated to:', page.url());
  
  // Close tutorial popups first
  await closeTutorial(page);

  // Set date range if provided
  if (ARG_START_DATE && ARG_END_DATE) {
    await setDateRange(page, ARG_START_DATE, ARG_END_DATE);
  }

  // Wait for table to load
  await page.waitForTimeout(3000);
  
  // Take a debug screenshot
  await page.screenshot({ path: '/tmp/xmp-debug.png', fullPage: false });
  console.log('Debug screenshot saved to /tmp/xmp-debug.png');
  
  // Try to extract data
  const data = await extractData(page);
  
  // Map to our product names
  const results = data.map(item => ({
    product: PRODUCT_MAP[item.xmpName] || item.xmpName,
    xmpName: item.xmpName,
    cost: item.cost,
  }));

  await browser.close();

  console.log('\n---RESULTS_JSON---');
  console.log(JSON.stringify(results, null, 2));
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
