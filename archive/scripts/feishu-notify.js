#!/usr/bin/env node
/**
 * 给屹恒发飞书私信（失败/成功通知）。用法：
 *   node scripts/feishu-notify.js "消息文本"
 *   echo "文本" | node scripts/feishu-notify.js
 */
const https = require('https');
const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const FEISHU_API = 'https://open.feishu.cn/open-apis';
const NOTIFY_OPEN_ID = 'ou_b2467dac5ff1d686fb48ccf1fbaa0c0d';

function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const opt = { method, hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', ...headers } };
    if (bodyStr) opt.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const r = https.request(opt, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    r.on('error', reject); if (bodyStr) r.write(bodyStr); r.end();
  });
}

async function main() {
  let text = process.argv.slice(2).join(' ');
  if (!text && !process.stdin.isTTY) { text = require('fs').readFileSync(0, 'utf8').trim(); }
  if (!text) { console.error('no message'); process.exit(1); }
  const tok = await req('POST', `${FEISHU_API}/auth/v3/tenant_access_token/internal`, { app_id: APP_ID, app_secret: APP_SECRET });
  if (!tok.tenant_access_token) { console.error('token failed', JSON.stringify(tok)); process.exit(1); }
  const res = await req('POST', `${FEISHU_API}/im/v1/messages?receive_id_type=open_id`,
    { receive_id: NOTIFY_OPEN_ID, msg_type: 'text', content: JSON.stringify({ text }) },
    { Authorization: `Bearer ${tok.tenant_access_token}` });
  if (res.code !== 0) { console.error('send failed', JSON.stringify(res)); process.exit(1); }
  console.log('notified');
}
main().catch(e => { console.error(e.message); process.exit(1); });
