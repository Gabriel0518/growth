#!/usr/bin/env node
// Meta Marketing API 调用量刷取脚本 v2（新 App: marketing API / app_id 1708296213710928）
// 过审门槛：500次成功 + 85%成功率。纯 GET 只读，覆盖每个已授权权限。
const https = require('https');

const TOKEN = process.env.FB_TOKEN;
if (!TOKEN) { console.error('missing FB_TOKEN'); process.exit(1); }
const V = 'v25.0';
const BASE = `https://graph.facebook.com/${V}/`;
const TARGET = parseInt(process.env.TARGET || '520', 10);
const GAP = parseInt(process.env.GAP || '250', 10); // ms between calls (慢节奏保成功率)

const BM = '1522249045620600';
// 已授权可读的活跃广告账户（account_status:1）
const ACCTS = [
  'act_2330833744085551','act_1535514137864339','act_646387524897026',
  'act_1952356011993971','act_753530227720860','act_3785379568423345',
  'act_1028408289302328','act_1961805801882902','act_1438154001310965',
  'act_1496773118725495','act_893651390194241','act_33928024120177945',
];

// 每个端点标注它主要演示哪个权限（用于覆盖统计）
const endpoints = [];
const add = (perm, path) => endpoints.push({ perm, path });

for (const a of ACCTS) {
  // ads_read: 账户元数据 + 各层级实体
  add('ads_read', `${a}?fields=id,name,account_status,currency,amount_spent,spend_cap,timezone_name`);
  add('ads_read', `${a}/campaigns?fields=id,name,status,objective,daily_budget&limit=5`);
  add('ads_read', `${a}/adsets?fields=id,name,status,daily_budget,optimization_goal&limit=5`);
  add('ads_read', `${a}/ads?fields=id,name,status,effective_status&limit=5`);
  // read_insights: 账户级洞察（多个 date_preset 增加多样性）
  add('read_insights', `${a}/insights?fields=spend,impressions,clicks,ctr,cpc&date_preset=maximum&level=account`);
  add('read_insights', `${a}/insights?fields=spend,impressions,reach&date_preset=last_30d&level=account`);
  add('read_insights', `${a}/insights?fields=spend,actions&date_preset=last_7d&level=account`);
  // ads_management: 读自定义受众（写权限的只读演示，绝不写）
  add('ads_management', `${a}/customaudiences?fields=id,name,approximate_count_lower_bound&limit=5`);
  add('ads_management', `${a}?fields=spend_cap,funding_source_details`);
}
// business_management
add('business_management', `me/businesses?fields=id,name,verification_status`);
add('business_management', `${BM}?fields=id,name,created_time,verification_status`);
add('business_management', `${BM}/owned_ad_accounts?fields=account_id,name,account_status&limit=25`);
add('business_management', `${BM}/client_ad_accounts?fields=account_id,name&limit=25`);
// identity
add('public_profile', `me?fields=id,name`);
add('ads_read', `me/adaccounts?fields=account_id,name,account_status&limit=25`);

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
  const permOk = {}; // 每权限成功计数
  const t0 = Date.now();
  while (success < TARGET) {
    const ep = endpoints[i % endpoints.length];
    i++;
    const r = await call(ep.path);
    if (r.ok) { success++; permOk[ep.perm] = (permOk[ep.perm]||0)+1; }
    else { fail++; errsamples[r.errmsg] = (errsamples[r.errmsg]||0)+1; }
    if ((success+fail) % 25 === 0) {
      process.stdout.write(`\r进度: 成功 ${success} / 失败 ${fail} / 总 ${success+fail}   `);
    }
    await new Promise(r => setTimeout(r, GAP));
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
  console.log(`\n每权限成功次数覆盖:`);
  console.log(JSON.stringify(permOk, null, 2));
  if (fail) console.log(`\n失败样本:`, JSON.stringify(errsamples, null, 2));
})();
