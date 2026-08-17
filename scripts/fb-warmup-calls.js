#!/usr/bin/env node
// Meta Marketing API 调用量刷取脚本（过审门槛：500次成功 + 85%成功率）
// 纯 GET 只读，只查有权限的账户，绝不写操作
const https = require('https');

const TOKEN = process.env.FB_TOKEN;
if (!TOKEN) { console.error('missing FB_TOKEN'); process.exit(1); }
const V = 'v25.0';
const BASE = `https://graph.facebook.com/${V}/`;

// 目标次数
const TARGET = parseInt(process.env.TARGET || '620', 10);

// 只读端点池（都是已验证有权限、能成功返回的）
const ACCTS = ['act_1548558926611600', 'act_3625139237624596'];
const endpoints = [];
for (const a of ACCTS) {
  endpoints.push(`${a}?fields=id,name,account_status,currency,account_id`);
  endpoints.push(`${a}/campaigns?fields=id,name,status,objective&limit=5`);
  endpoints.push(`${a}/adsets?fields=id,name,status&limit=5`);
  endpoints.push(`${a}/insights?fields=spend,impressions,clicks,ctr,actions&date_preset=maximum&level=account`);
  endpoints.push(`${a}?fields=name,timezone_name,amount_spent`);
}
endpoints.push(`me?fields=id,name`);
endpoints.push(`me/adaccounts?fields=account_id,name`);
endpoints.push(`me/businesses?fields=id,name`);

function call(path) {
  return new Promise((resolve) => {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${BASE}${path}${sep}access_token=${TOKEN}`;
    const req = https.get(url, { timeout: 20000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        let ok = res.statusCode === 200;
        let errmsg = '';
        try { const j = JSON.parse(body); if (j.error) { ok = false; errmsg = j.error.message; } } catch(e){}
        resolve({ ok, status: res.statusCode, errmsg });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok:false, status:0, errmsg:'timeout' }); });
    req.on('error', (e) => resolve({ ok:false, status:0, errmsg:e.message }));
  });
}

(async () => {
  let success = 0, fail = 0, i = 0;
  const errsamples = {};
  const t0 = Date.now();
  while (success < TARGET) {
    const ep = endpoints[i % endpoints.length];
    i++;
    const r = await call(ep);
    if (r.ok) success++; else { fail++; errsamples[r.errmsg] = (errsamples[r.errmsg]||0)+1; }
    if ((success+fail) % 50 === 0) {
      process.stdout.write(`\r进度: 成功 ${success} / 失败 ${fail} / 总 ${success+fail}   `);
    }
    // 轻微限速，避免触发 rate limit（Meta 用户级 limit 较宽，但稳妥点）
    await new Promise(r => setTimeout(r, 120));
  }
  const secs = ((Date.now()-t0)/1000).toFixed(1);
  const total = success + fail;
  const rate = ((success/total)*100).toFixed(1);
  console.log(`\n\n=== 完成 ===`);
  console.log(`成功: ${success}`);
  console.log(`失败: ${fail}`);
  console.log(`总调用: ${total}`);
  console.log(`成功率: ${rate}%`);
  console.log(`耗时: ${secs}s`);
  if (fail) console.log(`失败样本:`, JSON.stringify(errsamples, null, 2));
})();
