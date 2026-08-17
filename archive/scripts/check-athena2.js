const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('https://admin.sitin.ai', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.click('text="Login"');
  await page.waitForTimeout(1000);
  await page.fill('#basic_username', process.env.DASHBOARD_USER);
  await page.fill('#basic_password', process.env.DASHBOARD_PASS);
  await page.click('button:has-text("Submit")');
  await page.waitForTimeout(5000);
  await page.waitForLoadState('networkidle');
  console.log('URL after login:', page.url());
  const text = await page.evaluate(() => document.body.innerText.substring(0, 300));
  console.log('Text:', text);
  await browser.close();
})();
