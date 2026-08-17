const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  
  // Listen for console and network errors
  page.on('response', resp => {
    if (resp.url().includes('login') || resp.url().includes('auth')) {
      console.log('Response:', resp.status(), resp.url());
    }
  });
  
  await page.goto('https://admin.sitin.ai', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.click('text="Login"');
  await page.waitForTimeout(1000);
  
  console.log('DASHBOARD_USER:', process.env.DASHBOARD_USER ? process.env.DASHBOARD_USER.substring(0, 3) + '***' : 'UNDEFINED');
  console.log('DASHBOARD_PASS:', process.env.DASHBOARD_PASS ? '***set***' : 'UNDEFINED');
  
  await page.fill('#basic_username', process.env.DASHBOARD_USER || '');
  await page.fill('#basic_password', process.env.DASHBOARD_PASS || '');
  await page.click('button:has-text("Submit")');
  await page.waitForTimeout(5000);
  
  console.log('URL after submit:', page.url());
  const text = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('Text:', text);
  await browser.close();
})();
