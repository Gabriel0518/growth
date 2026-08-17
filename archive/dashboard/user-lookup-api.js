#!/usr/bin/env node
/**
 * 用户归因查询 API (独立服务)
 * 端口: 9090
 * 认证: Bearer Token
 * 
 * POST /api/user-lookup
 * Body: { "user_ids": ["7554791", "6855524", ...] }
 * Header: Authorization: Bearer <token>
 * 
 * 返回: { results: [ { userId, product, adPlatform, mediaSource, campaign, adset, ad, ... } ] }
 */

const http = require('http');
const path = require('path');
const sqlite3 = require('better-sqlite3');

const PORT = 9090;
const API_TOKEN = 'eac789931c07730b9f592cd2d0cb55aff74bc579ddee048f868442e2fa5136a4';
const POSTBACK_DB_PATH = path.resolve('/home/admin/dataserver/data.db');

// ── Product name mapping ──────────────────────────────────────
const LTV_APP_IDS = {
  'com.doramatch.app': 'Dora And',
  'id6746109957': 'Dora iOS',
  'id6746782904': 'Romi iOS',
  'com.qiga.vio': 'Jovia And',
  'com.doni.appa': 'Doni',
  'com.romiandroid.appmatch': 'Romi And',
  'id1658972379': 'GraceChat',
  'id6759697686': 'Kira iOS',
  'com.meraki.kira': 'Kira And',
  'com.cavalier.nalo': 'Nalo And',
  '6746109957': 'Dora iOS',
  '6746782904': 'Romi iOS',
  '1658972379': 'GraceChat',
  '6759697686': 'Kira iOS',
  '6746466099': 'Luma',
  'com.circleconnect.dora': 'Dora iOS',
  'com.chatsbridgeconnect.romi': 'Romi iOS',
  'com.odyssey.luma': 'Luma',
  'id6746466099': 'Luma',
};

// ── Media source classification ───────────────────────────────
const MEDIA_SOURCE_MAP = {
  'Facebook Ads': 'FB', 'Facebook+Installs': 'FB', 'Facebook Installs': 'FB',
  'Instagram+Installs': 'FB', 'Instagram Installs': 'FB',
  'Off-Facebook+Installs': 'FB', 'Social_facebook': 'FB', 'facebook': 'FB',
  'Facebook+web': 'FB', 'Facebook web': 'FB',
  'googleadwords_int': 'GG', 'Google Ads ACI': 'GG', 'Google+Ads+ACI': 'GG',
  'tiktokglobal_int': 'TT', 'TikTok+SAN': 'TT', 'TikTok SAN': 'TT',
  'organic': 'Organic', 'Organic': 'Organic', 'restricted': 'Organic',
  'Unattributed': 'Organic', 'Untrusted Devices': 'Organic',
};

function mapMediaSource(src) {
  if (!src) return '';
  if (MEDIA_SOURCE_MAP[src]) return MEDIA_SOURCE_MAP[src];
  const s = src.toLowerCase();
  if (s.includes('w2a') || s.includes('web')) return 'FB';
  return src;
}

function classifyAdPlatform(payload) {
  const chLower = (payload.af_channel || '').toLowerCase();
  // af_channel level
  if (['facebook', 'instagram', 'audiencenetwork', 'threads', 'graphic'].includes(chLower) ||
      chLower.startsWith('social_facebook')) return 'FB';
  if (chLower.startsWith('aci_')) return 'GG';
  if (chLower === 'tiktok') return 'TT';
  // media_source level
  const mapped = mapMediaSource(payload.media_source || '');
  if (mapped === 'FB') return 'FB';
  if (mapped === 'GG') return 'GG';
  if (mapped === 'TT') return 'TT';
  return mapped || '';
}

// ── Database ──────────────────────────────────────────────────
function getDb() {
  const db = new sqlite3(POSTBACK_DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  return db;
}

function lookupUsers(userIds) {
  const db = getDb();
  try {
    const results = [];
    const stmt = db.prepare(`
      SELECT user_id, payload, event_time, install_time, app_id
      FROM user_lookup
      WHERE user_id = ?
      ORDER BY event_time ASC
    `);

    for (const uid of userIds) {
      const numId = parseInt(uid, 10);
      if (isNaN(numId)) continue;

      const rows = stmt.all(numId);
      // Group by product, keep earliest record
      const byProduct = {};
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload);
          const product = LTV_APP_IDS[payload.app_id] || payload.bundle_id || payload.app_id || row.app_id;
          if (!byProduct[product]) {
            const mediaSource = payload.af_channel || payload.media_source || '';
            const adPlatform = classifyAdPlatform(payload);
            byProduct[product] = {
              userId: numId,
              product,
              appId: payload.app_id || row.app_id,
              adPlatform,
              mediaSource,
              campaign: (payload.campaign || '').trim(),
              adset: (payload.af_adset || '').trim(),
              ad: (payload.af_ad || '').trim(),
              eventTime: payload.event_time || row.event_time || '',
              installTime: payload.install_time || row.install_time || '',
              triggerCount: 0,
            };
          }
          byProduct[product].triggerCount++;
        } catch (_) { /* skip */ }
      }

      for (const rec of Object.values(byProduct)) {
        results.push(rec);
      }
    }
    return results;
  } finally {
    db.close();
  }
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Auth check
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== API_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized. Use header: Authorization: Bearer <token>' }));
    return;
  }

  // Route: POST /api/user-lookup
  if (req.method === 'POST' && req.url === '/api/user-lookup') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        let userIds = data.user_ids || data.userIds || data.ids || [];
        if (typeof userIds === 'string') userIds = [userIds];
        if (!Array.isArray(userIds) || userIds.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '请提供 user_ids 数组，如 {"user_ids": ["7554791", "6855524"]}' }));
          return;
        }
        if (userIds.length > 200) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '单次查询上限 200 个用户 ID' }));
          return;
        }
        // Validate: each id should be 5-10 digit number
        const validIds = userIds.filter(id => /^\d{5,10}$/.test(String(id)));
        if (validIds.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '未提供有效的用户 ID（5-10 位数字）' }));
          return;
        }

        const results = lookupUsers(validIds);
        const notFound = validIds.filter(id => !results.some(r => String(r.userId) === String(id)));

        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-';
        console.log(`[Query] ${new Date().toISOString()} POST ip=${clientIp} ids=[${validIds.join(',')}] hit=${results.length}/${validIds.length}`);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          total: results.length,
          queried: validIds.length,
          notFoundCount: notFound.length,
          notFoundIds: notFound,
          results,
        }, null, 2));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'JSON 解析失败: ' + e.message }));
      }
    });
    return;
  }

  // Route: GET /api/user-lookup?ids=7554791,6855524
  if (req.method === 'GET' && req.url.startsWith('/api/user-lookup')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const idsParam = url.searchParams.get('ids') || url.searchParams.get('user_ids') || '';
    const userIds = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (userIds.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '请提供 ids 参数，如 ?ids=7554791,6855524' }));
      return;
    }
    if (userIds.length > 200) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '单次查询上限 200 个用户 ID' }));
      return;
    }
    const validIds = userIds.filter(id => /^\d{5,10}$/.test(id));
    if (validIds.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未提供有效的用户 ID（5-10 位数字）' }));
      return;
    }

    const results = lookupUsers(validIds);
    const notFound = validIds.filter(id => !results.some(r => String(r.userId) === String(id)));

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-';
    console.log(`[Query] ${new Date().toISOString()} GET ip=${clientIp} ids=[${validIds.join(',')}] hit=${results.length}/${validIds.length}`);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      total: results.length,
      queried: validIds.length,
      notFoundCount: notFound.length,
      notFoundIds: notFound,
      results,
    }, null, 2));
    return;
  }

  // Health check
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'user-lookup-api', port: PORT }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[User Lookup API] Running on http://0.0.0.0:${PORT}`);
  console.log(`[User Lookup API] Token: ${API_TOKEN.slice(0, 8)}...`);
});
