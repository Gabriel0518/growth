#!/usr/bin/env node
/**
 * Backfill Check — runs daily at 05:30 before UG morning report (06:00)
 * 
 * Checks if the midnight snapshot (00:05 full-day data) for the past 3 days
 * has valid Athena revenue and XMP cost. If either is 0/null, re-fetches.
 * 
 * Only checks midnight snapshots (full-day data), not hourly snapshots.
 * 
 * Retry: one fallback attempt after 5 minutes if the first try fails.
 * 
 * Usage: node dashboard/backfill-check.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');

// Athena API（敏感信息从环境变量读取，禁止硬编码）
const ATHENA_API_URL = process.env.ATHENA_API_URL || 'https://admin-api-prod.sitin.ai/api/open/admin/revenue';
const ATHENA_API_KEY = process.env.ATHENA_API_KEY;
const ATHENA_API_NAME_MAP = {
  'GraceChat': 'GraceChat', 'Dora': 'Dora iOS', 'Dora Android': 'Dora And',
  'Doni': 'Doni', 'Romi': 'Romi iOS', 'Romi Android': 'Romi And',
  'Luma': 'Luma', 'Jovia Android': 'Jovia And',
  'Kira': 'Kira iOS', 'Kira Android': 'Kira And', 'Nalo Android': 'Nalo And',
};
const ATHENA_IGNORE = new Set(['Lovia', 'Vika']);

// XMP script path
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getBeijingNow() {
  return new Date(Date.now() + 8 * 3600 * 1000);
}

// ── Athena API ──

function fetchAthenaRaw(dateStr) {
  return new Promise((resolve, reject) => {
    const url = `${ATHENA_API_URL}?date=${dateStr}`;
    const req = https.get(url, {
      headers: { 'Authorization': `Bearer ${ATHENA_API_KEY}` },
      timeout: 15000,
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (!json.success) return reject(new Error(`API error: ${JSON.stringify(json)}`));
          resolve(json.data);
        } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchAthena(dateStr) {
  const data = await fetchAthenaRaw(dateStr);
  return (data.products || [])
    .filter(p => !ATHENA_IGNORE.has(p.appName))
    .map(p => ({
      product: ATHENA_API_NAME_MAP[p.appName] || p.appName,
      totalRevenue: parseFloat(p.totalRevenue) || 0,
      newUserRevenue: parseFloat(p.newUserRevenue) || 0,
    }));
}

// ── XMP fetch via shell script ──

function fetchXmp(dateStr) {
  const output = execSync(
    `bash ${path.join(SCRIPTS_DIR, 'fetch-xmp-api.sh')} ${dateStr} ${dateStr}`,
    { timeout: 60000, encoding: 'utf8' }
  );
  return JSON.parse(output.trim());
}

// ── Data checking ──

/**
 * Find the midnight snapshot in a day's data.
 * Midnight fetch runs at hour=0 Beijing (UTC 16:xx), storing yesterday's full data.
 */
function findMidnightSnapshot(dayData) {
  if (!dayData.snapshots || dayData.snapshots.length === 0) return null;
  
  // Look for snapshot at UTC 16:xx (= Beijing 00:xx)
  for (const snap of dayData.snapshots) {
    const utcHour = new Date(snap.time).getUTCHours();
    if (utcHour === 16) return snap;
  }
  
  // Fallback: last snapshot if it looks like midnight
  const last = dayData.snapshots[dayData.snapshots.length - 1];
  const lastHour = new Date(last.time).getUTCHours();
  if (lastHour === 16 || lastHour === 15) return last;
  
  return null;
}

function checkDayData(dateStr) {
  const filePath = path.join(DATA_DIR, `${dateStr}.json`);
  const result = { date: dateStr, athenaOk: false, xmpOk: false, exists: false, midnightIdx: -1 };
  
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`[Backfill] ${dateStr}: no data file`);
      return result;
    }
    
    const dayData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    result.exists = true;
    
    const midnightSnap = findMidnightSnapshot(dayData);
    if (!midnightSnap) {
      console.log(`[Backfill] ${dateStr}: no midnight snapshot found`);
      return result;
    }
    
    // Remember index for later update
    result.midnightIdx = dayData.snapshots.indexOf(midnightSnap);
    
    // Check Athena: total revenue > 0?
    const athenaProducts = midnightSnap.athena || [];
    const athenaRevenue = athenaProducts.reduce((sum, p) => sum + (p.totalRevenue || 0), 0);
    result.athenaOk = athenaRevenue > 0;
    
    // Check XMP: total cost > 0?
    const xmpProducts = midnightSnap.xmp || [];
    const xmpCost = xmpProducts.reduce((sum, p) => sum + (p.cost || 0), 0);
    result.xmpOk = xmpCost > 0;
    
    console.log(`[Backfill] ${dateStr}: athena=$${athenaRevenue.toFixed(0)} (${result.athenaOk ? 'OK' : 'ZERO'}), xmp=$${xmpCost.toFixed(0)} (${result.xmpOk ? 'OK' : 'ZERO'})`);
    
    return result;
  } catch (err) {
    console.error(`[Backfill] ${dateStr}: error reading data: ${err.message}`);
    return result;
  }
}

// ── Re-fetch and update ──

async function refetchDay(dateStr, source) {
  console.log(`[Backfill] Re-fetching ${source} for ${dateStr}...`);
  
  const filePath = path.join(DATA_DIR, `${dateStr}.json`);
  let dayData;
  try {
    dayData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    dayData = { date: dateStr, snapshots: [] };
  }
  
  const midnightSnap = findMidnightSnapshot(dayData);
  const midnightIdx = midnightSnap ? dayData.snapshots.indexOf(midnightSnap) : -1;
  const snap = midnightSnap || { time: new Date().toISOString(), athena: null, xmp: null };
  
  let success = false;
  
  if (source === 'athena' || source === 'both') {
    try {
      const athenaData = await fetchAthena(dateStr);
      const totalRev = athenaData.reduce((s, p) => s + (p.totalRevenue || 0), 0);
      if (totalRev > 0) {
        snap.athena = athenaData;
        console.log(`[Backfill] ${dateStr} Athena OK: $${totalRev.toFixed(0)} (${athenaData.length} products)`);
        success = true;
      } else {
        console.log(`[Backfill] ${dateStr} Athena still returns $0`);
      }
    } catch (err) {
      console.error(`[Backfill] ${dateStr} Athena error: ${err.message}`);
    }
  }
  
  if (source === 'xmp' || source === 'both') {
    try {
      const xmpData = fetchXmp(dateStr);
      const totalCost = xmpData.reduce((s, p) => s + (p.cost || 0), 0);
      if (totalCost > 0) {
        snap.xmp = xmpData;
        console.log(`[Backfill] ${dateStr} XMP OK: $${totalCost.toFixed(0)} (${xmpData.length} products)`);
        success = true;
      } else {
        console.log(`[Backfill] ${dateStr} XMP still returns $0`);
      }
    } catch (err) {
      console.error(`[Backfill] ${dateStr} XMP error: ${err.message}`);
    }
  }
  
  if (success) {
    if (midnightIdx >= 0) {
      dayData.snapshots[midnightIdx] = snap;
    } else {
      dayData.snapshots.push(snap);
    }
    fs.writeFileSync(filePath, JSON.stringify(dayData, null, 2));
    console.log(`[Backfill] ${dateStr} data file updated`);
  }
  
  return success;
}

// ── Main ──

async function main() {
  const now = getBeijingNow();
  console.log(`[Backfill] Starting at ${now.toISOString().slice(0, 19).replace('T', ' ')} Beijing`);
  
  // Past 3 days (yesterday, day before, 3 days ago)
  const datesToCheck = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    datesToCheck.push(formatDate(d));
  }
  
  console.log(`[Backfill] Checking: ${datesToCheck.join(', ')}`);
  
  // Check each day
  const needsRefetch = [];
  for (const dateStr of datesToCheck) {
    const check = checkDayData(dateStr);
    if (!check.athenaOk || !check.xmpOk) {
      const source = !check.athenaOk && !check.xmpOk ? 'both'
                   : !check.athenaOk ? 'athena' : 'xmp';
      needsRefetch.push({ date: dateStr, source });
    }
  }
  
  if (needsRefetch.length === 0) {
    console.log('[Backfill] All data OK, nothing to do');
    return;
  }
  
  console.log(`[Backfill] Refetching: ${needsRefetch.map(r => `${r.date}(${r.source})`).join(', ')}`);
  
  // First attempt
  const stillFailing = [];
  for (const { date, source } of needsRefetch) {
    const ok = await refetchDay(date, source);
    if (!ok) stillFailing.push({ date, source });
  }
  
  if (stillFailing.length === 0) {
    console.log('[Backfill] All refetches succeeded');
    return;
  }
  
  // Retry after 5 minutes
  console.log(`[Backfill] ${stillFailing.length} failed, retrying in 5 min...`);
  await sleep(5 * 60 * 1000);
  
  for (const { date, source } of stillFailing) {
    const ok = await refetchDay(date, source);
    if (!ok) {
      console.error(`[Backfill] GIVING UP on ${date} (${source})`);
    }
  }
  
  console.log('[Backfill] Done');
}

main().catch(err => {
  console.error(`[Backfill] Fatal: ${err.message}`);
  process.exit(1);
});
