#!/usr/bin/env node
// 临时详情脚本：复用 tt-parallel-track 逻辑，输出 top campaign 差异明细
const { execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const WS = path.join(__dirname, '..');
let date = process.argv[2];
if (!date) { const n = new Date(Date.now() + 8 * 3600 * 1000); date = n.toISOString().slice(0, 10); }

const XMP_CLIENT_ID = 'd607c5992ba7c40f19d9834da9b425e6';
const XMP_CLIENT_SECRET = '5520f711776d92ab13e8683c72e0fd30';
const XMP_HOST = 'xmp-open.mobvista.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function xmpReq(body) {
  return new Promise((resolve, reject) => {
    const p = JSON.stringify(body);
    const r = https.request({ hostname: XMP_HOST, path: '/v2/media/account/report', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(p) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('non-JSON')); } });
    });
    r.on('error', reject); r.setTimeout(45000, () => r.destroy(new Error('timeout'))); r.write(p); r.end();
  });
}
async function xmpTtCampaigns(d) {
  const rows = []; let page = 1;
  while (true) {
    const ts = Math.floor(Date.now() / 1000);
    const sign = crypto.createHash('md5').update(XMP_CLIENT_SECRET + ts).digest('hex');
    const resp = await xmpReq({ client_id: XMP_CLIENT_ID, timestamp: ts, sign, start_date: d, end_date: d,
      dimension: ['campaign_name', 'product_name'], module: 'tiktok', metrics: ['cost'], currency: 'USD', page, page_size: 1000 });
    if (resp.code !== 0) throw new Error('XMP ' + resp.msg);
    const list = resp.data && resp.data.list || [];
    for (const r of list) if (r.cost > 0) rows.push({ campaign: (r.campaign_name || '').trim(), cost: r.cost });
    if (list.length < 1000) break; page++; if (page > 50) break; await sleep(6500);
  }
  return rows;
}

(async () => {
  const out = execFileSync('node', ['scripts/fetch-tiktok.js', date, date], { cwd: WS, maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
  const tt = JSON.parse(out.toString());
  const xmp = await xmpTtCampaigns(date);
  const byC = rows => { const m = {}; for (const r of rows) { const k = (r.campaign || '').trim(); m[k] = (m[k] || 0) + r.cost; } return m; };
  const tm = byC(tt), xm = byC(xmp);
  const keys = new Set([...Object.keys(tm), ...Object.keys(xm)]);
  const diffs = [];
  for (const k of keys) {
    const t = tm[k] || 0, x = xm[k] || 0, d = t - x;
    if (Math.abs(d) > 0.01) diffs.push({ k, t, x, d });
  }
  diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const onlyTT = diffs.filter(o => (xm[o.k] || 0) === 0);
  const onlyXMP = diffs.filter(o => (tm[o.k] || 0) === 0);
  console.log(`差异 campaign 数=${diffs.length}`);
  console.log(`仅TT有(XMP缺)=${onlyTT.length}  仅XMP有(TT缺)=${onlyXMP.length}`);
  console.log('\n=== Top 20 差异 (TT - XMP) ===');
  for (const o of diffs.slice(0, 20)) {
    const tag = (xm[o.k] || 0) === 0 ? '[仅TT]' : (tm[o.k] || 0) === 0 ? '[仅XMP]' : '';
    console.log(`${o.d >= 0 ? '+' : ''}${o.d.toFixed(2)}  TT=${o.t.toFixed(2)} XMP=${o.x.toFixed(2)} ${tag} ${o.k}`);
  }
})();
