#!/usr/bin/env node
/**
 * Creative (素材) Data Fetcher
 * 
 * Fetches per-creative performance data from two sources:
 *   1. XMP Material Report API → cost, impressions, clicks per creative per channel per day
 *   2. AF/AD postback SQLite    → new user revenue per creative per channel per day
 * 
 * Usage:
 *   node fetch-creative-data.js                  # fetches yesterday
 *   node fetch-creative-data.js 2026-05-11       # fetches specific date
 *   node fetch-creative-data.js --init           # fetches last 3 complete days (first-time init)
 * 
 * Output: writes JSON files to dashboard/data/creative-YYYY-MM-DD.json
 */

const crypto = require('crypto');
const https = require('https');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('better-sqlite3');

// ── XMP API Config（敏感信息从环境变量读取，禁止硬编码）──
const XMP_CLIENT_ID = process.env.XMP_CLIENT_ID;
const XMP_CLIENT_SECRET = process.env.XMP_CLIENT_SECRET;
const XMP_HOST = process.env.XMP_API_HOST || 'xmp-open.mobvista.com';
const XMP_MATERIAL_REPORT_PATH = '/v2/media/material_report/list';
const XMP_ACCOUNT_REPORT_PATH = '/v2/media/account/report';

// ── Postback DB ──
const POSTBACK_DB_PATH = '/home/admin/dataserver/data.db';

// ── Output ──
const DATA_DIR = path.join(__dirname, 'data');

// ── Products (for name extraction, not for filtering) ──
const PRODUCTS = ['Dora', 'Romi', 'Doni', 'Luma', 'Jovia', 'GraceChat', 'Kira', 'Nalo'];
const PRODUCTS_RE = PRODUCTS.join('|');

// ── Channel mapping ──
// XMP module → our channel name
const XMP_CHANNEL_MAP = { facebook: 'FB', tiktok: 'TT' };
// AF channel → our channel name  
const AF_CHANNEL_MAP = {
  'Facebook': 'FB', 'Instagram': 'FB', 'AudienceNetwork': 'FB', 'Off-Facebook': 'FB',
  'TikTok': 'TT', 'Pangle': 'TT', 'tiktok': 'TT',
};

// ══════════════════════════════════════════════════════════
// Creative Name Parser — extract 4 key fields
// ══════════════════════════════════════════════════════════

// Pattern 1: MMDD_Designer_Product_Series_Number (standard)
const RE_STD = new RegExp(
  `(\\d{4})_([A-Z]{2,3})_(?:${PRODUCTS_RE})_(.+?)_(\\d+)(?=[^\\d]|$)`
);

// Pattern 2: MMDD_Product_Designer_Series_Number (alternate, designer after product)
const RE_ALT = new RegExp(
  `(\\d{4})_(?:${PRODUCTS_RE})_([A-Z]{2,3})_(.+?)_(\\d+)(?=[^\\d]|$)`
);

function parseCreativeName(raw) {
  if (!raw) return null;

  // Try standard pattern first, then alternate
  let m = RE_STD.exec(raw);
  if (!m) m = RE_ALT.exec(raw);
  if (!m) return null;

  const [, date, designer, series, number] = m;
  // Clean series: remove trailing _copy, _random-hash, etc.
  const cleanSeries = series
    .replace(/_copy(?:_copy)*$/i, '')
    .replace(/_[A-Za-z0-9]{8}$/, '')  // random 8-char hash suffix
    .trim();

  return {
    date,
    designer,
    series: cleanSeries,
    number,
    key: `${date}_${designer}_${cleanSeries}_${number}`,
  };
}

// ── Old-convention parser that PRESERVES the product segment ──
// Same MMDD_Designer_Product_Series_Number shape as parseCreativeName, but the
// product (previously swallowed by a non-capturing group and lost) is captured
// so the creative panel can carry a product dimension. Returns null on no match.
const RE_STD_P = new RegExp(
  `(\\d{4})_([A-Z]{2,3})_(${PRODUCTS_RE})_(.+?)_(\\d+)(?=[^\\d]|$)`
);
const RE_ALT_P = new RegExp(
  `(\\d{4})_(${PRODUCTS_RE})_([A-Z]{2,3})_(.+?)_(\\d+)(?=[^\\d]|$)`
);

function parseOldCreativeName(raw) {
  if (!raw) return null;
  let date, designer, product, series, number;
  let m = RE_STD_P.exec(raw);
  if (m) {
    [, date, designer, product, series, number] = m;
  } else {
    m = RE_ALT_P.exec(raw);
    if (!m) return null;
    [, date, product, designer, series, number] = m;
  }
  const cleanSeries = series
    .replace(/_copy(?:_copy)*$/i, '')
    .replace(/_[A-Za-z0-9]{8}$/, '')
    .trim();
  return { date, designer, product, series: cleanSeries, number };
}

// Best-effort old-convention product extraction (any segment matching a known
// product). Complements productFromName(), which only knows the AIGC product set
// (no Dora). Used as a fallback for dirty names.
function oldProductFromName(raw) {
  if (!raw) return '';
  const segs = String(raw).split('_');
  const hit = segs.find(s => PRODUCTS.includes(s.trim()));
  return hit ? hit.trim() : '';
}

// Extract the leading YYMMDD → MM-DD (AIGC convention) if present.
function aigcDateFromName(raw) {
  const seg0 = (String(raw || '').split('_')[0] || '');
  const dm = seg0.match(/^(\d{2})(\d{2})(\d{2})$/);
  return dm ? `${dm[2]}-${dm[3]}` : '';
}

// ══════════════════════════════════════════════════════════
// Dynamic creative name parser — NEVER returns null (兜底保留)
//
// Priority:
//   1. AIGC convention (name carries an "AIGC" segment) → AIGC field parse.
//   2. Old convention MMDD_Designer_Product_Series_Number → keep product.
//   3. Anything else (dirty / one-off names) → normalized name + best-effort
//      product, all other fields empty. Still kept — nothing is ever dropped.
//
// NOTE: The full AIGC field breakdown (owner/form/type/creative/actor) is
// derived on the front-end from the display name via parseAigcName(); the fetch
// side only needs the display name, the join key base and the product.
// ══════════════════════════════════════════════════════════
function parseCreativeNameDynamic(raw) {
  const original = raw || '';
  const { matchKey, displayName } = normalizeAigcName(original);

  // 1) AIGC convention
  if (AIGC_RE.test(original)) {
    return {
      key: matchKey,
      name: displayName,
      product: productFromName(original) || '',
      designer: '', series: '', number: '',
      date: aigcDateFromName(original),
      convention: 'aigc',
    };
  }

  // 2) Old convention (product preserved)
  const old = parseOldCreativeName(original);
  if (old) {
    return {
      key: matchKey,
      name: displayName,
      product: old.product || '',
      designer: old.designer, series: old.series, number: old.number,
      date: old.date,
      convention: 'std',
    };
  }

  // 3) Fallback — keep the row regardless
  return {
    key: matchKey,
    name: displayName,
    product: productFromName(original) || oldProductFromName(original) || '',
    designer: '', series: '', number: '',
    date: '',
    convention: 'raw',
  };
}

// ══════════════════════════════════════════════════════════
// XMP Material Report API
// ══════════════════════════════════════════════════════════

function xmpSign() {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash('md5').update(XMP_CLIENT_SECRET + timestamp).digest('hex');
  return { timestamp, sign };
}

function xmpRequest(body, apiPath = XMP_MATERIAL_REPORT_PATH) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: XMP_HOST,
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.code !== 0) reject(new Error(`XMP API error: ${j.msg} (code ${j.code})`));
          else resolve(j.data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('XMP API timeout')); });
    req.write(payload);
    req.end();
  });
}

async function fetchXmpCreativeData(dateStr) {
  const allRows = [];

  // Switched from the material report (md5_file_id aggregation, no product) to
  // the AD-level account/report (report_type:'ad'), the same authoritative source
  // the AIGC pipeline uses. One row per ad carries its own product_name and the
  // operator-authored ad_name, so every creative keeps its real product and the
  // consumption/revenue join key can be product-aware. Unlike the AIGC pipeline
  // there is NO AIGC name filter here — this panel is the full-creative superset.
  for (const module of ['facebook', 'tiktok']) {
    let page = 1;
    while (true) {
      const { timestamp, sign } = xmpSign(); // fresh sign per page (30s TTL)
      const body = {
        client_id: XMP_CLIENT_ID,
        timestamp, sign,
        start_date: dateStr,
        end_date: dateStr,
        report_type: 'ad',
        dimension: ['ad_name', 'product_name'],
        metrics: ['cost', 'impression', 'click'],
        currency: 'USD',
        module,
        page,
        page_size: 1000,
      };

      const data = await xmpRequest(body, XMP_ACCOUNT_REPORT_PATH);
      const list = data.list || [];
      if (list.length === 0) break;

      for (const row of list) {
        const name = row.ad_name;
        if (!name) continue; // only drop truly empty names — never on parse failure

        // Product: prefer the ad's product_name (authoritative), fall back to the
        // dynamic name parse. Reduce to base product (no iOS/And platform suffix).
        const mappedProduct = XMP_PRODUCT_MAP[row.product_name] || row.product_name;
        const parsed = parseCreativeNameDynamic(name);
        const product = baseProduct(mappedProduct) || parsed.product;

        allRows.push({
          name: parsed.name,
          product,
          matchKey: aigcMatchKey(name, product),
          designer: parsed.designer,
          series: parsed.series,
          number: parsed.number,
          date: parsed.date,
          convention: parsed.convention,
          channel: XMP_CHANNEL_MAP[module] || module,
          cost: row.cost || 0,
          impressions: row.impression || 0,
          clicks: row.click || 0,
        });
      }

      if (list.length < 1000) break;
      page++;
      await sleep(3500); // rate limit
    }

    // Wait between channels
    if (module === 'facebook') await sleep(3500);
  }

  return allRows;
}

// ══════════════════════════════════════════════════════════
// AF/AD New User Revenue from SQLite
// ══════════════════════════════════════════════════════════

// Fetch AF/AD new-user revenue keyed by (normalized creative name + base product).
// Mirrors fetchAfAdAigcRevenue but WITHOUT the AIGC name filter — the creative
// panel is the full-creative superset, so every non-organic creative counts.
function fetchAfAdNewUserRevenue(dateStr) {
  const db = sqlite3(POSTBACK_DB_PATH, { readonly: true });

  const [y, m, d] = dateStr.split('-').map(Number);
  const currentTable = `records_${y}${String(m).padStart(2, '0')}`;

  const dateObj = new Date(y, m - 1, d + 1);
  const nextDateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
  const nextTable = `records_${dateObj.getFullYear()}${String(dateObj.getMonth() + 1).padStart(2, '0')}`;

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%'").all().map(r => r.name);

  const results = [];

  // ── AF Purchase Events (ISO timestamps, key = af_ad + product) ──
  const afQuery = (table) => `
    SELECT
      json_extract(payload, '$.af_ad') as ad_name,
      json_extract(payload, '$.af_channel') as af_channel,
      json_extract(payload, '$.bundle_id') as bundle_id,
      json_extract(payload, '$.app_id') as app_id,
      revenue,
      install_time,
      event_time
    FROM ${table}
    WHERE event_name = 'af_purchase'
      AND json_extract(payload, '$.af_ad') IS NOT NULL
      AND json_extract(payload, '$.af_ad') != ''
      AND date(install_time, '+8 hours') = ?
      AND (julianday(event_time) - julianday(install_time)) * 24 < 24
      AND (julianday(event_time) - julianday(install_time)) >= 0
  `;

  const afNextDayQuery = (table) => `
    SELECT
      json_extract(payload, '$.af_ad') as ad_name,
      json_extract(payload, '$.af_channel') as af_channel,
      json_extract(payload, '$.bundle_id') as bundle_id,
      json_extract(payload, '$.app_id') as app_id,
      revenue,
      install_time,
      event_time
    FROM ${table}
    WHERE event_name = 'af_purchase'
      AND json_extract(payload, '$.af_ad') IS NOT NULL
      AND json_extract(payload, '$.af_ad') != ''
      AND date(install_time, '+8 hours') = ?
      AND date(event_time, '+8 hours') = ?
      AND (julianday(event_time) - julianday(install_time)) * 24 < 24
      AND (julianday(event_time) - julianday(install_time)) >= 0
  `;

  // Resolve product from postback app identifiers, falling back to the creative name.
  const productFromRevenue = (bundleId, appId, name) => {
    const mapped = APP_ID_MAP[bundleId] || APP_ID_MAP[appId] ||
      (appId ? APP_ID_MAP['id' + appId] : '') || '';
    return baseProduct(mapped) || productFromName(name) || oldProductFromName(name);
  };

  const pushAf = (row) => {
    const channel = AF_CHANNEL_MAP[row.af_channel];
    if (!channel) return; // skip Google / organic
    const name = row.ad_name;
    if (!name) return;
    const product = productFromRevenue(row.bundle_id, row.app_id, name);
    results.push({ matchKey: aigcMatchKey(name, product), channel, revenue: row.revenue || 0 });
  };

  if (tables.includes(currentTable)) {
    for (const row of db.prepare(afQuery(currentTable)).all(dateStr)) pushAf(row);
    try {
      for (const row of db.prepare(afNextDayQuery(currentTable)).all(dateStr, nextDateStr)) pushAf(row);
    } catch (e) { /* ok */ }
  }
  if (nextTable !== currentTable && tables.includes(nextTable)) {
    try {
      for (const row of db.prepare(afNextDayQuery(nextTable)).all(dateStr, nextDateStr)) pushAf(row);
    } catch (e) { /* ok */ }
  }

  // ── AD (Adjust) Purchase Events (Unix timestamps, key = decoded creative + product) ──
  const adQuery = (table) => `
    SELECT
      json_extract(payload, '$.creative') as creative,
      json_extract(payload, '$.is_organic') as is_organic,
      json_extract(payload, '$.bundle_id') as bundle_id,
      json_extract(payload, '$.app_id') as app_id,
      revenue,
      event_time,
      install_time,
      media_source
    FROM ${table}
    WHERE event_name = 'ad_purchase'
      AND json_extract(payload, '$.is_organic') = '0'
      AND json_extract(payload, '$.creative') IS NOT NULL
      AND json_extract(payload, '$.creative') != ''
      AND date(datetime(install_time, 'unixepoch', '+8 hours')) = ?
      AND (CAST(event_time AS REAL) - CAST(install_time AS REAL)) / 3600.0 < 24
      AND (CAST(event_time AS REAL) - CAST(install_time AS REAL)) >= 0
  `;

  for (const table of [currentTable, nextTable]) {
    if (!tables.includes(table)) continue;
    try {
      const rows = db.prepare(adQuery(table)).all(dateStr);
      for (const row of rows) {
        // Decode URL-encoded creative and strip trailing (id)
        let creative = decodeURIComponent((row.creative || '').replace(/\+/g, ' '));
        creative = creative.replace(/\s*\(\d+\)\s*$/, '');
        if (!creative) continue;
        // AD is iOS-only and mostly FB; default to FB
        const product = productFromRevenue(row.bundle_id, row.app_id, creative);
        results.push({ matchKey: aigcMatchKey(creative, product), channel: 'FB', revenue: row.revenue || 0 });
      }
    } catch (e) { /* ok */ }
  }

  db.close();
  return results;
}

// ══════════════════════════════════════════════════════════
// Aggregation
// ══════════════════════════════════════════════════════════

// Aggregate creative rows by (normalized name + base product) + channel.
// XMP ad-level consumption and postback revenue are both keyed by
// aigcMatchKey(name, product) so the same creative for the same product lines up
// across consumption and revenue while staying product-distinct. Mirrors
// aggregateAigcData but carries the extra dynamic-parse fields for the panel.
function aggregateData(xmpRows, revenueRows) {
  const xmpMap = new Map(); // matchKey::channel → agg
  for (const row of xmpRows) {
    const k = `${row.matchKey}::${row.channel}`;
    if (!xmpMap.has(k)) {
      xmpMap.set(k, {
        name: row.name,
        product: row.product || '',
        matchKey: row.matchKey,
        designer: row.designer || '',
        series: row.series || '',
        number: row.number || '',
        date: row.date || '',
        convention: row.convention || '',
        channel: row.channel,
        cost: 0,
        impressions: 0,
        clicks: 0,
      });
    }
    const agg = xmpMap.get(k);
    if (!agg.product && row.product) agg.product = row.product;
    agg.cost += row.cost;
    agg.impressions += row.impressions;
    agg.clicks += row.clicks;
  }

  const revMap = new Map(); // matchKey::channel → totalRevenue
  for (const row of revenueRows) {
    const k = `${row.matchKey}::${row.channel}`;
    revMap.set(k, (revMap.get(k) || 0) + row.revenue);
  }

  const merged = [];
  for (const [, xmp] of xmpMap) {
    const revKey = `${xmp.matchKey}::${xmp.channel}`;
    merged.push({
      name: xmp.name,
      product: xmp.product,
      designer: xmp.designer,
      series: xmp.series,
      number: xmp.number,
      date: xmp.date,
      channel: xmp.channel,
      cost: xmp.cost,
      impressions: xmp.impressions,
      clicks: xmp.clicks,
      newUserRevenue: revMap.get(revKey) || 0,
    });
  }
  return merged;
}

// ══════════════════════════════════════════════════════════
// AIGC Material Data Pipeline
//
// Independent from the creative pipeline above. Key differences:
//   - Ignores the parseCreativeName() 4-field rule entirely.
//   - Aggregates by a product-stripped key (stripProductKey) so XMP md5-bundle
//     rows and single-product postback revenue collapse to the same material.
//   - Filters to names matching /aigc/i (case-insensitive substring).
//   - Bundle rows (containing ' | ') differ only by product; the product-stripped
//     key of any sub-name is identical, so the first sub-name represents the row.
// ══════════════════════════════════════════════════════════

const AIGC_RE = /aigc/i;

// AIGC product enumeration (base product, platform-agnostic). Material name format:
//   YYMMDD_AIGC_负责人_产品_素材形式_..._演员.ext
const AIGC_PRODUCTS = ['Doni', 'GraceChat', 'Jovia', 'Kira', 'Luma', 'Nalo', 'Romi', 'Vika'];
const AIGC_PRODUCT_SET = new Set(AIGC_PRODUCTS.map(p => p.toLowerCase()));

// ── Product resolution maps (kept in sync with server.js) ──
// XMP report API product_name → our product name (with platform suffix).
const XMP_PRODUCT_MAP = {
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
  'Nalo: Meet, Swipe & Chat': 'Nalo And',
};

// Postback bundle_id / app_id → our product name (with platform suffix).
const APP_ID_MAP = {
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

// Reduce a platform-suffixed product (e.g. 'Romi iOS', 'Dora And') to its base
// product ('Romi', 'Dora'). The AIGC material name carries the base product
// (no platform), and a single video is often run on both iOS and Android, so
// the panel's product dimension is the base product.
function baseProduct(p) {
  if (!p) return '';
  return String(p).replace(/\s+(iOS|And)$/i, '').trim();
}

// Extract the base product directly from an AIGC material/ad name.
// Product sits at the 4th '_' segment (index 3) in the canonical format; fall
// back to the first segment that matches a known product for dirty data.
function productFromName(rawName) {
  if (!rawName) return '';
  let s = String(rawName);
  const m = s.match(/\.(mp4|mov|mpeg|m4v|avi|webm)/i);
  if (m) s = s.slice(0, m.index);
  const segs = s.split('_');
  if (segs.length > 3) {
    const cand = segs[3].trim();
    if (AIGC_PRODUCT_SET.has(cand.toLowerCase())) {
      return AIGC_PRODUCTS.find(p => p.toLowerCase() === cand.toLowerCase());
    }
  }
  const hit = segs.find(seg => AIGC_PRODUCT_SET.has(seg.trim().toLowerCase()));
  return hit ? AIGC_PRODUCTS.find(p => p.toLowerCase() === hit.trim().toLowerCase()) : '';
}

// Normalise an AIGC ad/material name into a stable join key + display name.
// Strips video extension and trailing variant suffixes (_1, _copy, _2 …) so
// XMP ad-level rows and postback creatives for the same material collapse.
// NOTE: product is NOT stripped here — product is tracked as a separate field.
function normalizeAigcName(rawName) {
  if (!rawName) return { matchKey: '', displayName: '' };
  let s = String(rawName);
  const m = s.match(/\.(mp4|mov|mpeg|m4v|avi|webm)/i);
  if (m) s = s.slice(0, m.index);
  // Strip trailing variant suffixes: _copy, _copy_copy, random 8-char hash, trailing _<number>
  s = s.replace(/_copy(?:_copy)*$/i, '')
       .replace(/_[A-Za-z0-9]{8}$/, '')
       .replace(/_\d+$/,'')
       .trim();
  return { matchKey: s.toLowerCase(), displayName: s };
}

// Build the cross-source match key: normalized material name + base product.
function aigcMatchKey(rawName, product) {
  const { matchKey } = normalizeAigcName(rawName);
  return `${matchKey}@@${(product || '').toLowerCase()}`;
}

// Fetch XMP material report (FB + TT), keyed by full raw material name,
// filtered to AIGC names only. No parseCreativeName.
async function fetchXmpAigcData(dateStr) {
  const allRows = [];

  // Use the AD-level report (report_type:'ad') instead of the material report.
  // The material report aggregates by md5_file_id and merges cross-product
  // bundles ('a | b | c'), losing the product. The ad report returns one row
  // per ad with its own product_name, so every creative keeps its real product.
  // ad_name is the operator-authored full creative name (same source/format as
  // the AF/AD postback af_ad / creative fields), enabling product-aware matching.
  for (const module of ['facebook', 'tiktok']) {
    let page = 1;
    while (true) {
      const { timestamp, sign } = xmpSign(); // fresh sign per page (30s TTL)
      const body = {
        client_id: XMP_CLIENT_ID,
        timestamp, sign,
        start_date: dateStr,
        end_date: dateStr,
        report_type: 'ad',
        dimension: ['ad_name', 'product_name'],
        metrics: ['cost', 'impression', 'click'],
        currency: 'USD',
        module,
        page,
        page_size: 1000,
      };

      const data = await xmpRequest(body, XMP_ACCOUNT_REPORT_PATH);
      const list = data.list || [];
      if (list.length === 0) break;

      for (const row of list) {
        const name = row.ad_name;
        if (!name || !AIGC_RE.test(name)) continue; // AIGC filter only

        // Product: prefer the ad's product_name (authoritative), fall back to
        // parsing it out of the creative name. Reduce to base product (no platform).
        const mappedProduct = XMP_PRODUCT_MAP[row.product_name] || row.product_name;
        const product = baseProduct(mappedProduct) || productFromName(name);

        const { matchKey, displayName } = normalizeAigcName(name);

        allRows.push({
          name: displayName,
          product,
          matchKey: aigcMatchKey(name, product),
          channel: XMP_CHANNEL_MAP[module] || module,
          cost: row.cost || 0,
          impressions: row.impression || 0,
          clicks: row.click || 0,
        });
      }

      if (list.length < 1000) break;
      page++;
      await sleep(3500); // rate limit
    }

    if (module === 'facebook') await sleep(3500);
  }

  return allRows;
}

// Fetch AF/AD new-user revenue keyed by full raw creative name, AIGC-filtered.
function fetchAfAdAigcRevenue(dateStr) {
  const db = sqlite3(POSTBACK_DB_PATH, { readonly: true });

  const [y, m, d] = dateStr.split('-').map(Number);
  const currentTable = `records_${y}${String(m).padStart(2, '0')}`;

  const dateObj = new Date(y, m - 1, d + 1);
  const nextDateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
  const nextTable = `records_${dateObj.getFullYear()}${String(dateObj.getMonth() + 1).padStart(2, '0')}`;

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'records_%'").all().map(r => r.name);

  const results = [];

  // ── AF Purchase Events (ISO timestamps, key = af_ad + product) ──
  // bundle_id / app_id identifies the product; APP_ID_MAP → base product.
  const afQuery = (table) => `
    SELECT
      json_extract(payload, '$.af_ad') as ad_name,
      json_extract(payload, '$.af_channel') as af_channel,
      json_extract(payload, '$.bundle_id') as bundle_id,
      json_extract(payload, '$.app_id') as app_id,
      revenue,
      install_time,
      event_time
    FROM ${table}
    WHERE event_name = 'af_purchase'
      AND json_extract(payload, '$.af_ad') IS NOT NULL
      AND json_extract(payload, '$.af_ad') != ''
      AND date(install_time, '+8 hours') = ?
      AND (julianday(event_time) - julianday(install_time)) * 24 < 24
      AND (julianday(event_time) - julianday(install_time)) >= 0
  `;

  const afNextDayQuery = (table) => `
    SELECT
      json_extract(payload, '$.af_ad') as ad_name,
      json_extract(payload, '$.af_channel') as af_channel,
      json_extract(payload, '$.bundle_id') as bundle_id,
      json_extract(payload, '$.app_id') as app_id,
      revenue,
      install_time,
      event_time
    FROM ${table}
    WHERE event_name = 'af_purchase'
      AND json_extract(payload, '$.af_ad') IS NOT NULL
      AND json_extract(payload, '$.af_ad') != ''
      AND date(install_time, '+8 hours') = ?
      AND date(event_time, '+8 hours') = ?
      AND (julianday(event_time) - julianday(install_time)) * 24 < 24
      AND (julianday(event_time) - julianday(install_time)) >= 0
  `;

  // Resolve product from postback app identifiers, falling back to the creative name.
  const productFromRevenue = (bundleId, appId, name) => {
    const mapped = APP_ID_MAP[bundleId] || APP_ID_MAP[appId] ||
      (appId ? APP_ID_MAP['id' + appId] : '') || '';
    return baseProduct(mapped) || productFromName(name);
  };

  const pushAf = (row) => {
    const channel = AF_CHANNEL_MAP[row.af_channel];
    if (!channel) return; // skip Google / organic
    const name = row.ad_name;
    if (!name || !AIGC_RE.test(name)) return;
    const product = productFromRevenue(row.bundle_id, row.app_id, name);
    results.push({ matchKey: aigcMatchKey(name, product), channel, revenue: row.revenue || 0 });
  };

  if (tables.includes(currentTable)) {
    for (const row of db.prepare(afQuery(currentTable)).all(dateStr)) pushAf(row);
    try {
      for (const row of db.prepare(afNextDayQuery(currentTable)).all(dateStr, nextDateStr)) pushAf(row);
    } catch (e) { /* ok */ }
  }
  if (nextTable !== currentTable && tables.includes(nextTable)) {
    try {
      for (const row of db.prepare(afNextDayQuery(nextTable)).all(dateStr, nextDateStr)) pushAf(row);
    } catch (e) { /* ok */ }
  }

  // ── AD (Adjust) Purchase Events (Unix timestamps, key = decoded creative + product) ──
  const adQuery = (table) => `
    SELECT
      json_extract(payload, '$.creative') as creative,
      json_extract(payload, '$.is_organic') as is_organic,
      json_extract(payload, '$.bundle_id') as bundle_id,
      json_extract(payload, '$.app_id') as app_id,
      revenue,
      event_time,
      install_time,
      media_source
    FROM ${table}
    WHERE event_name = 'ad_purchase'
      AND json_extract(payload, '$.is_organic') = '0'
      AND json_extract(payload, '$.creative') IS NOT NULL
      AND json_extract(payload, '$.creative') != ''
      AND date(datetime(install_time, 'unixepoch', '+8 hours')) = ?
      AND (CAST(event_time AS REAL) - CAST(install_time AS REAL)) / 3600.0 < 24
      AND (CAST(event_time AS REAL) - CAST(install_time AS REAL)) >= 0
  `;

  for (const table of [currentTable, nextTable]) {
    if (!tables.includes(table)) continue;
    try {
      const rows = db.prepare(adQuery(table)).all(dateStr);
      for (const row of rows) {
        // Decode URL-encoded creative and strip trailing (id) — same as creative pipeline
        let creative = decodeURIComponent((row.creative || '').replace(/\+/g, ' '));
        creative = creative.replace(/\s*\(\d+\)\s*$/, '');
        if (!creative || !AIGC_RE.test(creative)) continue;
        // AD is iOS-only and mostly FB; default to FB (matches creative pipeline)
        const product = productFromRevenue(row.bundle_id, row.app_id, creative);
        results.push({ matchKey: aigcMatchKey(creative, product), channel: 'FB', revenue: row.revenue || 0 });
      }
    } catch (e) { /* ok */ }
  }

  db.close();
  return results;
}

// Aggregate AIGC rows by (normalized material name + base product) + channel.
// XMP ad-level consumption and postback revenue are both keyed by
// aigcMatchKey(name, product), so the same creative for the same product
// lines up across consumption and revenue while staying product-distinct.
function aggregateAigcData(xmpRows, revenueRows) {
  const xmpMap = new Map(); // matchKey::channel → agg
  for (const row of xmpRows) {
    const k = `${row.matchKey}::${row.channel}`;
    if (!xmpMap.has(k)) {
      xmpMap.set(k, {
        name: row.name,
        product: row.product || '',
        matchKey: row.matchKey,
        channel: row.channel,
        cost: 0,
        impressions: 0,
        clicks: 0,
      });
    }
    const agg = xmpMap.get(k);
    if (!agg.product && row.product) agg.product = row.product;
    agg.cost += row.cost;
    agg.impressions += row.impressions;
    agg.clicks += row.clicks;
  }

  const revMap = new Map(); // matchKey::channel → totalRevenue
  for (const row of revenueRows) {
    const k = `${row.matchKey}::${row.channel}`;
    revMap.set(k, (revMap.get(k) || 0) + row.revenue);
  }

  const merged = [];
  for (const [, xmp] of xmpMap) {
    const revKey = `${xmp.matchKey}::${xmp.channel}`;
    merged.push({
      name: xmp.name,
      product: xmp.product,
      channel: xmp.channel,
      cost: xmp.cost,
      impressions: xmp.impressions,
      clicks: xmp.clicks,
      newUserRevenue: revMap.get(revKey) || 0,
    });
  }
  return merged;
}

async function fetchAndSaveAigcDate(dateStr) {
  console.log(`[aigc] Fetching data for ${dateStr}...`);

  console.log(`[aigc]   XMP ad-level report...`);
  const xmpRows = await fetchXmpAigcData(dateStr);
  console.log(`[aigc]   XMP: ${xmpRows.length} AIGC rows`);

  console.log(`[aigc]   AF/AD new user revenue...`);
  const revenueRows = fetchAfAdAigcRevenue(dateStr);
  console.log(`[aigc]   Revenue: ${revenueRows.length} AIGC events`);

  const aggregated = aggregateAigcData(xmpRows, revenueRows);
  console.log(`[aigc]   Aggregated: ${aggregated.length} AIGC material-channel combos`);

  const output = {
    date: dateStr,
    fetchedAt: new Date().toISOString(),
    creatives: aggregated,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, `aigc-${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[aigc]   Saved to ${outPath}`);

  return output;
}

// ══════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function todayBeijing() {
  const now = new Date(Date.now() + 8 * 3600000);
  return now.toISOString().slice(0, 10);
}

function prevDate(dateStr, n = 1) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d - n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

async function fetchAndSaveDate(dateStr) {
  console.log(`[creative] Fetching data for ${dateStr}...`);
  
  // 1. Fetch XMP creative data
  console.log(`[creative]   XMP material report...`);
  const xmpRows = await fetchXmpCreativeData(dateStr);
  console.log(`[creative]   XMP: ${xmpRows.length} rows`);
  
  // 2. Fetch AF/AD new user revenue
  console.log(`[creative]   AF/AD new user revenue...`);
  const revenueRows = fetchAfAdNewUserRevenue(dateStr);
  console.log(`[creative]   Revenue: ${revenueRows.length} events`);
  
  // 3. Aggregate
  const aggregated = aggregateData(xmpRows, revenueRows);
  console.log(`[creative]   Aggregated: ${aggregated.length} creative-channel combos`);
  
  // 4. Save
  const output = {
    date: dateStr,
    fetchedAt: new Date().toISOString(),
    creatives: aggregated,
  };
  
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const outPath = path.join(DATA_DIR, `creative-${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[creative]   Saved to ${outPath}`);
  
  return output;
}

async function main() {
  const args = process.argv.slice(2);

  // AIGC mode: node fetch-creative-data.js --aigc [date]
  if (args.includes('--aigc')) {
    const rest = args.filter(a => a !== '--aigc');
    if (rest.includes('--init')) {
      const today = todayBeijing();
      const dates = [prevDate(today, 3), prevDate(today, 2), prevDate(today, 1)];
      console.log(`[aigc] Init mode: fetching ${dates.join(', ')}`);
      for (const dd of dates) {
        await fetchAndSaveAigcDate(dd);
        await sleep(5000);
      }
    } else {
      const dateArg = rest[0] || prevDate(todayBeijing(), 1);
      await fetchAndSaveAigcDate(dateArg);
    }
    console.log('[aigc] Done.');
    return;
  }

  if (args.includes('--init')) {
    // Init mode: fetch last 3 complete days
    const today = todayBeijing();
    const dates = [prevDate(today, 3), prevDate(today, 2), prevDate(today, 1)];
    console.log(`[creative] Init mode: fetching ${dates.join(', ')}`);
    for (const d of dates) {
      await fetchAndSaveDate(d);
      await sleep(5000); // breathing room between days
    }
  } else if (args[0]) {
    // Specific date
    await fetchAndSaveDate(args[0]);
  } else {
    // Default: yesterday
    const yesterday = prevDate(todayBeijing(), 1);
    await fetchAndSaveDate(yesterday);
  }
  
  console.log('[creative] Done.');
}

// Export for use by server.js
module.exports = { fetchAndSaveDate, fetchAndSaveAigcDate, parseCreativeName, parseCreativeNameDynamic, prevDate, todayBeijing };

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('[creative] Fatal error:', err);
    process.exit(1);
  });
}
