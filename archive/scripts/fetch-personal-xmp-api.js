#!/usr/bin/env node
/**
 * XMP Open API - Personal (syh) Cost Fetcher
 * Replaces the Playwright-based fetch-personal-xmp.js
 * 
 * Output: JSON array of { product, channel, cost, cpm, cpc }
 * Compatible with the old Playwright version's output format.
 */

const crypto = require('crypto');
const https = require('https');

const CLIENT_ID = process.env.XMP_CLIENT_ID;
const CLIENT_SECRET = process.env.XMP_CLIENT_SECRET;
const API_HOST = 'xmp-open.mobvista.com';
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
};

// Operator code to match in campaign names for personal report
const PERSONAL_CODE = 'syh';

function makeSign() {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash('md5').update(CLIENT_SECRET + timestamp).digest('hex');
  return { timestamp, sign };
}

function apiRequest(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: API_HOST,
      path: REPORT_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function fetchChannel(channel, date) {
  const results = [];
  let page = 1;

  while (true) {
    const { timestamp, sign } = makeSign();
    const resp = await apiRequest({
      client_id: CLIENT_ID,
      timestamp,
      sign,
      start_date: date,
      end_date: date,
      dimension: ['campaign_name', 'product_name'],
      module: channel,
      metrics: ['cost', 'cpm', 'cpc'],
      currency: 'USD',
      page,
      page_size: 1000,
    });

    if (resp.code !== 0) {
      throw new Error(`[XMP personal API] ${channel} page ${page} error: ${resp.msg} (code ${resp.code})`);
    }
    if (!resp.data || !resp.data.list || resp.data.list.length === 0) break;

    for (const row of resp.data.list) {
      // Filter: only campaigns containing the personal code, and cost > 0
      if (row.cost > 0 && row.campaign_name && row.campaign_name.toLowerCase().includes(PERSONAL_CODE)) {
        const product = PRODUCT_MAP[row.product_name] || row.product_name;
        results.push({
          product,
          channel: CHANNEL_SHORT[channel] || channel,
          cost: row.cost,
          cpm: row.cpm || null,
          cpc: row.cpc || null,
        });
      }
    }

    page++;
    if (page > 50) break;
  }

  return results;
}

async function main() {
  // Determine date (Beijing time)
  let date;
  if (process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2])) {
    date = process.argv[2];
  } else {
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    date = now.toISOString().slice(0, 10);
  }
  // XMP API data timezone is Beijing (UTC+8), pass Beijing date directly
  // If 00:00-08:00 Beijing time, the API may reject — caller handles empty result

  console.error(`[XMP personal API] Fetching personal (${PERSONAL_CODE}) data for ${date}`);

  const allResults = [];
  for (const channel of CHANNELS) {
    const rows = await fetchChannel(channel, date);
    allResults.push(...rows);
    console.error(`[XMP personal API] ${channel}: ${rows.length} personal campaigns`);
  }

  // Aggregate by product + channel (combine multiple campaigns)
  const map = {};
  for (const row of allResults) {
    const key = `${row.product}|${row.channel}`;
    if (!map[key]) {
      map[key] = { product: row.product, channel: row.channel, cost: 0, cpm: null, cpc: null };
    }
    map[key].cost += row.cost;
    // cpm/cpc: use weighted average would be ideal but we just take the last non-null
    if (row.cpm != null) map[key].cpm = row.cpm;
    if (row.cpc != null) map[key].cpc = row.cpc;
  }

  const output = Object.values(map).sort((a, b) => b.cost - a.cost);
  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error('[XMP personal API] Fatal:', err.message);
  process.exit(1);
});
