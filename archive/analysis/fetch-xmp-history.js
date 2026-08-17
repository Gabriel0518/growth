#!/usr/bin/env node
/**
 * Batch fetch XMP campaign-level cost data for analysis.
 * Respects 10 QPM limit (3 channels per date = 3 requests per date).
 * Saves each date to analysis/xmp-history/YYYY-MM-DD.json
 * 
 * Usage: node analysis/fetch-xmp-history.js [startDate] [endDate]
 * Default: 2026-03-30 to 2026-05-27
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.XMP_CLIENT_ID;
const CLIENT_SECRET = process.env.XMP_CLIENT_SECRET;
const API_HOST = process.env.XMP_API_HOST || 'xmp-open.mobvista.com';
const REPORT_PATH = '/v2/media/account/report';

const CHANNELS = ['facebook', 'google', 'tiktok'];
const CHANNEL_SHORT = { facebook: 'FB', google: 'GG', tiktok: 'TT' };

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
  'Nalo: Find Your Story': 'Nalo And',
};

const OUTPUT_DIR = path.join(__dirname, 'xmp-history');
// Also check dashboard XMP cache for dates we already have
const DASHBOARD_CACHE_DIR = path.join(__dirname, '..', 'dashboard', 'data', 'xmp-cache');

function makeSign() {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash('md5').update(CLIENT_SECRET + timestamp).digest('hex');
  return { timestamp, sign };
}

function apiRequest(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: API_HOST,
      path: REPORT_PATH,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => buf += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`Parse error: ${buf.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

async function fetchChannelForDate(date, channel) {
  const allRows = [];
  let page = 1;
  while (true) {
    const { timestamp, sign } = makeSign();
    const resp = await apiRequest({
      client_id: CLIENT_ID, timestamp, sign,
      start_date: date, end_date: date,
      dimension: ['campaign_name', 'product_name'],
      module: channel,
      metrics: ['cost', 'impression', 'click'],
      currency: 'USD',
      page, page_size: 1000,
    });

    if (resp.code !== 0) {
      if (resp.code === 429 || resp.code === 400001 || (resp.msg && (resp.msg.includes('rate') || resp.msg.includes('frequently')))) {
        console.error(`  Rate limited on ${channel} page ${page} (code ${resp.code}), waiting 90s...`);
        await new Promise(r => setTimeout(r, 90000));
        continue; // retry same page
      }
      throw new Error(`[XMP API] ${channel} page ${page}: ${resp.msg} (code ${resp.code})`);
    }

    if (!resp.data || !resp.data.list || resp.data.list.length === 0) break;

    for (const row of resp.data.list) {
      if (row.cost > 0 || row.impression > 0) {
        allRows.push({
          product: PRODUCT_MAP[row.product_name] || row.product_name,
          campaign: (row.campaign_name || '').trim(),
          channel: CHANNEL_SHORT[channel] || channel,
          cost: row.cost || 0,
          impressions: row.impression || 0,
          clicks: row.click || 0,
        });
      }
    }
    page++;
    if (page > 50) break;
  }
  return allRows;
}

function getDateRange(start, end) {
  const dates = [];
  let d = new Date(start + 'T00:00:00+08:00');
  const endD = new Date(end + 'T00:00:00+08:00');
  while (d <= endD) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function alreadyHave(date) {
  // Check our own output (must have actual data)
  const ownFile = path.join(OUTPUT_DIR, `${date}.json`);
  if (fs.existsSync(ownFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(ownFile, 'utf8'));
      if (d.data && d.data.length > 0) return true;
    } catch(e) {}
  }
  // Check dashboard cache
  const cacheFile = path.join(DASHBOARD_CACHE_DIR, `xmp-campaigns-${date}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (d.data && d.data.length > 0) return true;
    } catch(e) {}
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2);
  const startDate = args[0] || '2026-03-30';
  const endDate = args[1] || '2026-05-27';
  
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  
  const allDates = getDateRange(startDate, endDate);
  const toFetch = allDates.filter(d => !alreadyHave(d));
  
  console.log(`Date range: ${startDate} → ${endDate} (${allDates.length} days)`);
  console.log(`Already cached: ${allDates.length - toFetch.length}`);
  console.log(`To fetch: ${toFetch.length}`);
  console.log(`Estimated time: ~${Math.ceil(toFetch.length * 3 / 8)} minutes (3 requests/date, ~8 QPM safe rate)\n`);
  
  let requestCount = 0;
  let lastRequestTime = 0;
  
  for (let i = 0; i < toFetch.length; i++) {
    const date = toFetch[i];
    console.log(`[${i+1}/${toFetch.length}] Fetching ${date}...`);
    
    const allRows = [];
    for (const channel of CHANNELS) {
      // Rate limit: ensure >= 12s between requests (~5 QPM, very safe under 10 QPM)
      // XMP caches identical params for 30min, so we also need different timestamps
      const elapsed = Date.now() - lastRequestTime;
      if (elapsed < 12000) {
        await sleep(12000 - elapsed);
      }
      
      try {
        const rows = await fetchChannelForDate(date, channel);
        allRows.push(...rows);
        requestCount++;
        lastRequestTime = Date.now();
        process.stdout.write(`  ${CHANNEL_SHORT[channel]}: ${rows.length} campaigns  `);
      } catch (e) {
        console.error(`  ${CHANNEL_SHORT[channel]}: ERROR - ${e.message}`);
      }
    }
    
    // Save
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${date}.json`),
      JSON.stringify({ date, data: allRows, fetchedAt: new Date().toISOString() }, null, 2)
    );
    console.log(`\n  → Saved ${allRows.length} campaigns total. (${requestCount} API calls so far)`);
  }
  
  console.log(`\nDone! ${requestCount} total API calls for ${toFetch.length} dates.`);
}

main().catch(e => { console.error(e); process.exit(1); });
