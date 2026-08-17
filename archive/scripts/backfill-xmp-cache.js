#!/usr/bin/env node
/**
 * Backfill missing XMP campaign cache files for operator daily report
 * 
 * Checks every date from startDate to endDate (or 1st of month to yesterday)
 * If xmp-campaigns-{date}.json is missing, fetches via XMP API and writes cache
 * 
 * Respects 10 QPM rate limit: 3 channels per date = 3 requests, max 3 dates per minute
 * 
 * Usage: node scripts/backfill-xmp-cache.js [startDate] [endDate]
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.XMP_CLIENT_ID;
const CLIENT_SECRET = process.env.XMP_CLIENT_SECRET;
const API_HOST = 'xmp-open.mobvista.com';
const REPORT_PATH = '/v2/media/account/report';
const CHANNELS = ['facebook', 'google', 'tiktok'];
const CHANNEL_SHORT = { facebook: 'FB', google: 'GG', tiktok: 'TT' };
const XMP_CACHE_DIR = path.join(__dirname, '..', 'dashboard', 'data', 'xmp-cache');

const PRODUCT_MAP = {
  'Romi: Make Friends, Have Fun': 'Romi iOS',
  'Dora: Create and connect': 'Dora iOS',
  'Dora: Find Real Companionship': 'Dora And',
  'Doni: Easy Connection': 'Doni',
  'Luma: Make Friends, Have Fun': 'Luma',
  'Jovia: Find Real Love': 'Jovia And',
  'Romi: Swipe, Chat & Connect': 'Romi And',
  'GraceChat': 'GraceChat',
  'Kira: Creative Community': 'Kira iOS',
  'Kira: Find Your Romance': 'Kira And',
};

function makeSign() {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash('md5').update(CLIENT_SECRET + timestamp).digest('hex');
  return { timestamp, sign };
}

function apiRequest(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: API_HOST, path: REPORT_PATH, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchDateCampaigns(date) {
  const allRows = [];
  for (const channel of CHANNELS) {
    let page = 1;
    while (true) {
      const { timestamp, sign } = makeSign();
      const resp = await apiRequest({
        client_id: CLIENT_ID, timestamp, sign,
        start_date: date, end_date: date,
        dimension: ['campaign_name', 'adset_name', 'product_name'],
        module: channel,
        metrics: ['cost', 'impression', 'click'],
        currency: 'USD',
        page, page_size: 1000,
      });
      if (resp.code !== 0) throw new Error(`${channel} error: ${resp.msg}`);
      if (!resp.data || !resp.data.list || resp.data.list.length === 0) break;
      for (const row of resp.data.list) {
        if (row.cost > 0 && row.product_name) {
          allRows.push({
            product: PRODUCT_MAP[row.product_name] || row.product_name,
            campaign: (row.campaign_name || '').trim(),
            adset: (row.adset_name || '').trim(),
            channel: CHANNEL_SHORT[channel] || channel,
            cost: row.cost,
            impressions: row.impression || 0,
            clicks: row.click || 0,
          });
        }
      }
      page++;
      if (page > 50) break;
    }
  }
  return allRows;
}

async function main() {
  let startDate = process.argv[2];
  let endDate = process.argv[3];

  const now = new Date(Date.now() + 8 * 3600 * 1000);
  if (!endDate) {
    const yd = new Date(now);
    yd.setUTCDate(yd.getUTCDate() - 1);
    endDate = yd.toISOString().slice(0, 10);
  }
  if (!startDate) {
    startDate = endDate.slice(0, 8) + '01';
  }

  // Generate date range
  const dates = [];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const d = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  while (d <= end) {
    dates.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
    d.setDate(d.getDate() + 1);
  }

  // Find missing cache files
  fs.mkdirSync(XMP_CACHE_DIR, { recursive: true });
  const missing = dates.filter(dt => {
    const p = path.join(XMP_CACHE_DIR, `xmp-campaigns-${dt}.json`);
    return !fs.existsSync(p);
  });

  if (missing.length === 0) {
    console.error('[XMP Backfill] All cache files present, nothing to do');
    return;
  }

  console.error(`[XMP Backfill] Missing ${missing.length} date(s): ${missing.join(', ')}`);

  const MAX_RETRIES = 2;
  const RETRY_DELAY = 60000; // 1 minute between retries
  const DATE_DELAY = 20000; // 20s between dates (safe for 10 QPM)

  for (let i = 0; i < missing.length; i++) {
    const dt = missing[i];
    let success = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.error(`[XMP Backfill] ${dt} retry ${attempt}/${MAX_RETRIES}, waiting ${RETRY_DELAY / 1000}s...`);
        await sleep(RETRY_DELAY);
      }
      console.error(`[XMP Backfill] Fetching ${dt} (${i + 1}/${missing.length})${attempt > 0 ? ` attempt ${attempt + 1}` : ''}...`);
      try {
        const rows = await fetchDateCampaigns(dt);
        const cacheData = { data: rows, fetchedAt: Date.now(), complete: true };
        const cachePath = path.join(XMP_CACHE_DIR, `xmp-campaigns-${dt}.json`);
        fs.writeFileSync(cachePath, JSON.stringify(cacheData));
        console.error(`[XMP Backfill] ${dt}: ${rows.length} campaigns cached`);
        success = true;
        break;
      } catch (err) {
        console.error(`[XMP Backfill] ${dt} FAILED: ${err.message}`);
      }
    }
    if (!success) {
      console.error(`[XMP Backfill] ${dt} GAVE UP after ${MAX_RETRIES + 1} attempts`);
    }

    // Rate limit: wait 20s between dates (safe margin for 10 QPM)
    if (i < missing.length - 1) {
      await sleep(DATE_DELAY);
    }
  }

  console.error('[XMP Backfill] Done');
}

main().catch(err => {
  console.error('[XMP Backfill] Fatal:', err.message);
  process.exit(1);
});
