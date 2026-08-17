const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1600, height: 1200 } });
  try {
    // 登录
    await page.goto('http://127.0.0.1:8081/login', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'd3dkJdSXvkuuYZoqg_5O4Q');
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1500);
    // 进个人面板（postback personal）
    const btn = await page.$('#pb-personal-entry');
    if (btn) { await btn.click(); await page.waitForTimeout(2500); }
    // 展开第一个可展开的渠道行看 campaign/adset 层
    const exp = await page.$('.pbp-ch-expandable');
    if (exp) { await exp.click(); await page.waitForTimeout(1500); }
    await page.screenshot({ path: 'output/personal-panel-verify.png', fullPage: false });
    // 抓表头文本 + 是否有红三角
    const head = await page.$$eval('.pbp-detail-table thead th, .pb-channel-table thead th', els => els.map(e=>e.textContent.trim()).filter(Boolean).slice(0,12));
    const flags = await page.$$eval('.tt-reject-flag', els => els.length);
    const budgetCells = await page.$$eval('.pbp-detail-table tbody td.col-num, .pb-channel-table tbody td.col-num', els => els.slice(0,20).map(e=>e.textContent.trim()));
    console.log('表头:', JSON.stringify(head));
    console.log('红三角数量:', flags);
    console.log('前排数值单元格:', JSON.stringify(budgetCells));
  } catch (e) {
    console.error('ERR:', e.message);
  } finally { await b.close(); }
})();
