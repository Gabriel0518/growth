#!/usr/bin/env node
// Meta pages 权限补刷脚本（pages_show_list / pages_read_engagement / pages_manage_ads）
// 纯 GET 只读。page 相关端点用派生的 page token。
const https = require('https');
const TOKEN = process.env.FB_TOKEN;
if (!TOKEN) { console.error('missing FB_TOKEN'); process.exit(1); }
const V = 'v25.0';
const BASE = `https://graph.facebook.com/${V}/`;
const TARGET = parseInt(process.env.TARGET || '150', 10);
const GAP = parseInt(process.env.GAP || '250', 10);
const PAGES = ['863488183510530','858507510684964','787553424442933','717745171433271'];

function get(path, tok) {
  return new Promise((resolve) => {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${BASE}${path}${sep}access_token=${tok}`;
    https.get(url, { timeout: 20000 }, (res) => {
      let b=''; res.on('data',d=>b+=d);
      res.on('end', () => {
        let ok=res.statusCode===200, errmsg='', json=null;
        try { json=JSON.parse(b); if(json.error){ok=false;errmsg=json.error.message;} } catch(e){}
        resolve({ ok, errmsg, json });
      });
    }).on('error', e=>resolve({ok:false,errmsg:e.message}))
      .on('timeout', function(){ this.destroy(); resolve({ok:false,errmsg:'timeout'}); });
  });
}

(async () => {
  // 先派生每个 page 的 page token
  const pt = {};
  for (const p of PAGES) {
    const r = await get(`${p}?fields=access_token`, TOKEN);
    pt[p] = r.json && r.json.access_token ? r.json.access_token : TOKEN;
  }
  // 端点池：perm 标注 + 用哪个 token
  const eps = [];
  const add = (perm, path, page) => eps.push({ perm, path, page }); // page=null 用 user token
  add('pages_show_list', `me/accounts?fields=id,name,category`, null);
  for (const p of PAGES) {
    add('pages_read_engagement', `${p}?fields=id,name,fan_count,followers_count,about,category,link,talking_about_count`, p);
    add('pages_read_engagement', `${p}/published_posts?fields=id,message,created_time&limit=5`, p);
    add('pages_read_engagement', `${p}/insights?metric=page_post_engagements&period=day&date_preset=last_30d`, p);
    add('pages_read_engagement', `${p}?fields=name,talking_about_count,new_like_count,rating_count`, p);
    add('pages_manage_ads', `${p}/ads_posts?fields=id,message,created_time&limit=5`, p);
    add('pages_manage_ads', `${p}/leadgen_forms?fields=id,name,status&limit=5`, p);
  }

  let success=0, fail=0, i=0; const permOk={}, errs={};
  const t0=Date.now();
  while (success < TARGET) {
    const e = eps[i % eps.length]; i++;
    const tok = e.page ? pt[e.page] : TOKEN;
    const r = await get(e.path, tok);
    if (r.ok) { success++; permOk[e.perm]=(permOk[e.perm]||0)+1; }
    else { fail++; errs[e.errmsg]=(errs[e.errmsg]||0)+1; }
    if ((success+fail)%25===0) process.stdout.write(`\r进度: 成功 ${success} / 失败 ${fail}   `);
    await new Promise(r=>setTimeout(r, GAP));
  }
  const secs=((Date.now()-t0)/1000).toFixed(1);
  const total=success+fail, rate=((success/total)*100).toFixed(1);
  console.log(`\n\n=== pages 补刷完成 ===`);
  console.log(`成功: ${success} / 失败: ${fail} / 总: ${total} / 成功率: ${rate}% / 耗时: ${secs}s`);
  console.log(`每权限覆盖:`, JSON.stringify(permOk));
  if (fail) console.log(`失败样本:`, JSON.stringify(errs, null, 2));
})();
