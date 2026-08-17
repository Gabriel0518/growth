// ===== State =====
let correctionMode = false; // false=原始收入, true=修正收入
let correctionFactors = {}; // { product: number | { fb: number, other: number } }
let isRangeMode = false; // true when viewing multi-day range
let eltvMultipliers = {}; // { product: { FB: { d180: number }, GG: {...}, TT: {...} } }

// ===== Loading Overlay =====
let _loadingCount = 0;
function showLoading() {
  _loadingCount++;
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = 'flex';
}
function hideLoading() {
  _loadingCount = Math.max(0, _loadingCount - 1);
  if (_loadingCount === 0) {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
  }
}
function resetLoading() {
  _loadingCount = 0;
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = 'none';
}

async function fetchCorrectionFactors(sDate, eDate, signal) {
  try {
    const resp = await fetch(`/api/correction-factors?startDate=${sDate}&endDate=${eDate}`, signal ? { signal } : {});
    if (resp.ok) {
      const data = await resp.json();
      isRangeMode = sDate !== eDate;
      if (data.dailyFactors) {
        // Multi-day: store dailyFactors for reference (not used directly—backend pre-computes corrected values)
        correctionFactors = {};
      } else {
        correctionFactors = data.factors || {};
      }
    }
  } catch (e) { if (e.name !== 'AbortError') console.warn('Failed to fetch correction factors', e); }
}

async function fetchEltvMultipliers(eDate, signal) {
  try {
    const resp = await fetch(`/api/eltv-multipliers?date=${eDate}`, signal ? { signal } : {});
    if (resp.ok) {
      const data = await resp.json();
      eltvMultipliers = data.multipliers || {};
    }
  } catch (e) { console.warn('Failed to fetch eLTV multipliers', e); }
}

function getEltvMultiplier(product, channel) {
  const m = eltvMultipliers[product];
  if (!m) return null;
  // Per-channel lookup
  if (channel && m[channel] && m[channel].d180) return m[channel].d180;
  // Fallback: try all channels, return first valid (for backward compat / aggregate views)
  for (const ch of ['FB', 'GG', 'TT']) {
    if (m[ch] && m[ch].d180) return m[ch].d180;
  }
  // Legacy flat structure compat
  if (m.d180) return m.d180;
  return null;
}

function getEltvRecords(product, channel) {
  const m = eltvMultipliers[product];
  if (!m) return null;
  if (channel && m[channel] && m[channel].records != null) return m[channel].records;
  if (m.records != null) return m.records;
  return null;
}

function getEltvD1Span(product, channel) {
  const m = eltvMultipliers[product];
  if (!m) return 0;
  if (channel && m[channel] && m[channel].d1Span != null) return m[channel].d1Span;
  if (m.d1Span != null) return m.d1Span;
  return 0;
}

function getEltvConfidence(product, channel) {
  const m = eltvMultipliers[product];
  if (!m) return null;
  const entry = (channel && m[channel]) ? m[channel] : m;
  if (!entry || !entry.d180) return null;
  const conf = entry.confidence;
  if (conf === 'green') return { label: '可信', color: 'var(--green)' };
  if (conf === 'yellow') return { label: '供参考', color: 'var(--yellow)' };
  return { label: '不可信', color: 'var(--red)' };
}

// iOS FB sources (for determining which factor to use)
const FB_CHANNELS = new Set(['FB']);

function getCorrectionFactor(product, channel) {
  const f = correctionFactors[product];
  if (f == null) return 1;
  if (typeof f === 'number') return f; // Android: single factor
  // iOS: { fb, other }
  if (channel && FB_CHANNELS.has(channel)) return f.fb || 1;
  return f.other || 1;
}

function applyCorrection(value, product, channel, correctedValue) {
  if (!correctionMode) return value;
  // In range mode, use pre-computed corrected value from backend
  if (isRangeMode && correctedValue != null) return correctedValue;
  return value * getCorrectionFactor(product, channel);
}

let startDate = todayStr();
let endDate = todayStr();
let currentPanel = 'summary';
let dayData = null;
let prevDayData = null;
let afSummaryData = null;     // AF data from DB (/api/af-summary)
let prevAfSummaryData = null; // Yesterday AF data
let personalPrevDayData = null;
let personalDayData = null;
let sortField = null;
let sortDir = 'desc';
let personalSortField = null;
let personalSortDir = 'desc';
let trendChart = null;
let personalTrendChart = null;
let rbiChart = null;        // 收入来源图 (revenue-by-install) chart instance
let _rbiAbort = null;       // AbortController for the in-flight revenue-by-install request
let summaryStatusPollTimer = null;
let personalStatusPollTimer = null;
let personalPanelRevealTimer = null;

const urlParams = new URLSearchParams(window.location.search);

function apiUrl(path) {
  return path;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmt(val) {
  if (val == null || isNaN(val)) return '--';
  return '$' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(val) {
  if (val == null || isNaN(val)) return '--';
  return val.toFixed(1) + '%';
}

function fmtDelta(val) {
  if (val == null || isNaN(val) || val === 0) return '';
  const sign = val > 0 ? '+' : '';
  return sign + '$' + Math.abs(val).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDeltaPct(val) {
  if (val == null || isNaN(val) || val === 0) return '';
  const sign = val > 0 ? '+' : '';
  return sign + val.toFixed(1) + '%';
}

function fmtTime(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function fmtShortTime(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  return d.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });
}

async function fetchData(sDate, eDate) {
  const resp = await fetch(apiUrl(`/api/data?startDate=${sDate}&endDate=${eDate}`));
  return resp.json();
}

async function fetchStatus() {
  const resp = await fetch(apiUrl('/api/status'));
  return resp.json();
}

async function triggerRefresh() {
  const resp = await fetch(apiUrl('/api/refresh'), { method: 'POST' });
  return resp.json();
}

async function fetchPersonalData(date) {
  const resp = await fetch(apiUrl(`/api/personal/data?date=${date}`));
  return resp.json();
}

async function fetchAfSummary(sDate, eDate) {
  try {
    const resp = await fetch(apiUrl(`/api/af-summary?startDate=${sDate}&endDate=${eDate}`));
    if (!resp.ok) return null;
    return resp.json();
  } catch { return null; }
}

let channelSummaryData = null;
async function fetchChannelSummary(sDate, eDate) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
    const resp = await fetch(apiUrl(`/api/channel-summary?startDate=${sDate}&endDate=${eDate}`), { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return resp.json();
  } catch { return null; }
}

async function fetchPersonalStatus() {
  const resp = await fetch(apiUrl('/api/personal/status'));
  return resp.json();
}

async function triggerPersonalRefresh() {
  const resp = await fetch(apiUrl('/api/personal/refresh'), { method: 'POST' });
  return resp.json();
}

const PRODUCTS = ['GraceChat', 'Dora iOS', 'Dora And', 'Doni', 'Romi iOS', 'Romi And', 'Luma', 'Jovia And', 'Kira iOS', 'Kira And', 'Nalo And'];

function snapshotHasData(snap) {
  // 判断一个 snapshot 是否有实际数据（至少一个 source 非空且有记录）
  if (!snap) return false;
  const hasAthena = Array.isArray(snap.athena) && snap.athena.length > 0;
  const hasAf = Array.isArray(snap.af) && snap.af.length > 0;
  const hasXmp = Array.isArray(snap.xmp) && snap.xmp.length > 0;
  const hasPersonalAf = Array.isArray(snap.af) && snap.af.length > 0;
  const hasAd = Array.isArray(snap.ad) && snap.ad.length > 0;
  return hasAthena || hasAf || hasXmp || hasAd;
}

function findSameTimeSnapshot(targetDayData, currentTimeISO) {
  if (!targetDayData || !targetDayData.snapshots || targetDayData.snapshots.length === 0) return null;
  const current = new Date(currentTimeISO);
  const currentMinutes = current.getHours() * 60 + current.getMinutes();

  // 只选取昨天时间点 <= 当前时刻 且有实际数据的 snapshots，取其中时间最接近（最大）的
  let bestSnapshot = null;
  let bestMinutes = -1;
  for (const snap of targetDayData.snapshots) {
    if (!snapshotHasData(snap)) continue;
    const snapDate = new Date(snap.time);
    const snapMinutes = snapDate.getHours() * 60 + snapDate.getMinutes();
    // 只取 <= 当前时刻的快照
    if (snapMinutes > currentMinutes) continue;
    // 取时间最靠近当前时刻的（即 snapMinutes 最大的）
    if (snapMinutes > bestMinutes) {
      bestMinutes = snapMinutes;
      bestSnapshot = snap;
    }
  }
  return bestSnapshot;
}

function findYesterdaySameTimeSnapshot(currentTimeISO) {
  return findSameTimeSnapshot(prevDayData, currentTimeISO);
}

function findPersonalYesterdaySameTimeSnapshot(currentTimeISO) {
  return findSameTimeSnapshot(personalPrevDayData, currentTimeISO);
}

// ===== Hourly Breakdown (通用：支持 athena / af / xmp) =====

/**
 * 各数据源的 snapshot 提取配置
 */
const SOURCE_CONFIGS = {
  athena: {
    filter: s => Array.isArray(s.athena) && s.athena.length > 0,
    extract: s => ({
      totalRevenue:   s.athena.reduce((sum, a) => sum + (a.totalRevenue   || 0), 0),
      newUserRevenue: s.athena.reduce((sum, a) => sum + (a.newUserRevenue || 0), 0),
    }),
  },
  af: {
    filter: s => Array.isArray(s.af) && s.af.length > 0,
    extract: s => ({
      revenueActual: s.af.reduce((sum, a) => sum + (a.revenueActual || 0), 0),
      revenueLTV:    s.af.reduce((sum, a) => sum + (a.revenueLTV    || 0), 0),
    }),
  },
  xmp: {
    filter: s => Array.isArray(s.xmp) && s.xmp.length > 0,
    extract: s => ({
      cost: s.xmp.reduce((sum, x) => sum + (x.cost || 0), 0),
    }),
  },
};

function getSourceSnapshots(source) {
  if (!dayData || !dayData.snapshots) return [];
  const cfg = SOURCE_CONFIGS[source];
  return dayData.snapshots.filter(cfg.filter).map(s => ({ time: s.time, ...cfg.extract(s) }));
}

function getYesterdaySourceSnapshots(source) {
  if (!prevDayData || !prevDayData.snapshots) return [];
  const cfg = SOURCE_CONFIGS[source];
  return prevDayData.snapshots.filter(cfg.filter).map(s => ({ time: s.time, ...cfg.extract(s) }));
}

function findPrevHourSnap(snaps, refTimeISO) {
  const refMs = new Date(refTimeISO).getTime();
  const minGapMs = 30 * 60 * 1000;
  let best = null;
  for (const s of snaps) {
    const ms = new Date(s.time).getTime();
    if (ms >= refMs - minGapMs) continue;
    if (!best || ms > new Date(best.time).getTime()) best = s;
  }
  return best;
}

function timeToMinutes(isoStr) {
  const d = new Date(isoStr);
  const parts = d.toLocaleString('en-US', {
    timeZone: 'Asia/Shanghai', hour: 'numeric', minute: 'numeric', hour12: false,
  }).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function findYesterdayMatchingPair(todayToISO, field, yesterdaySnaps) {
  if (!yesterdaySnaps || yesterdaySnaps.length < 2) return null;
  const toMins = timeToMinutes(todayToISO);
  let prevTo = null;
  let bestDiff = Infinity;
  for (const s of yesterdaySnaps) {
    const diff = Math.abs(timeToMinutes(s.time) - toMins);
    if (diff < bestDiff) { bestDiff = diff; prevTo = s; }
  }
  if (!prevTo) return null;
  const prevFrom = findPrevHourSnap(yesterdaySnaps, prevTo.time);
  if (!prevFrom) return null;
  return { from: prevFrom.time, to: prevTo.time, delta: prevTo[field] - prevFrom[field] };
}

function buildHourlyPairs(source, field) {
  const snaps = getSourceSnapshots(source);
  if (snaps.length < 2) return [];
  const yesterdaySnaps = getYesterdaySourceSnapshots(source);
  const pairs = [];
  let cursor = snaps[snaps.length - 1];
  for (let i = 0; i < 6; i++) {
    const prev = findPrevHourSnap(snaps, cursor.time);
    if (!prev) break;
    const delta = cursor[field] - prev[field];
    const yoy = findYesterdayMatchingPair(cursor.time, field, yesterdaySnaps);
    pairs.push({ from: prev.time, to: cursor.time, delta, yoy });
    cursor = prev;
  }
  return pairs;
}

function fmtDeltaMoney(val) {
  if (val == null || isNaN(val)) return '--';
  const abs = Math.abs(val);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val > 0.005) return `+$${str}`;
  if (val < -0.005) return `-$${str}`;
  return `$${str}`;
}

function deltaClass(val) {
  if (val == null || isNaN(val)) return 'neutral';
  if (val > 0.005) return 'positive';
  if (val < -0.005) return 'negative';
  return 'neutral';
}

function renderHourlyPanel(panelId, source, field) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const pairs = buildHourlyPairs(source, field);
  if (pairs.length === 0) {
    panel.innerHTML = '<div class="hourly-empty">暂无足够数据</div>';
    return;
  }
  let html = '';
  for (const p of pairs) {
    const fromTime = fmtShortTime(p.from);
    const toTime = fmtShortTime(p.to);
    const dStr = fmtDeltaMoney(p.delta);
    let todayCls;
    if (p.yoy == null) {
      todayCls = deltaClass(p.delta);
    } else {
      todayCls = (p.delta >= p.yoy.delta - 0.005) ? 'positive' : 'negative';
    }
    html += `<div class="hourly-row"><span class="h-time">${fromTime} → ${toTime}</span><span class="h-val ${todayCls}">${dStr}</span></div>`;
    if (p.yoy) {
      const yFromTime = fmtShortTime(p.yoy.from);
      const yToTime = fmtShortTime(p.yoy.to);
      html += `<div class="hourly-row is-yoy"><span class="h-time h-yoy-label">昨日 ${yFromTime} → ${yToTime}</span><span class="h-val neutral">${fmtDeltaMoney(p.yoy.delta)}</span></div>`;
    } else {
      html += `<div class="hourly-row is-yoy"><span class="h-time h-yoy-label">昨日 --</span><span class="h-val neutral">--</span></div>`;
    }
  }
  panel.innerHTML = html;
}

// 面板配置：card key → { source, field }
const EXPAND_CARD_CONFIG = {
  'athena':     { source: 'athena', field: 'totalRevenue' },
  'athena-new': { source: 'athena', field: 'newUserRevenue' },
  'af':         { source: 'af',     field: 'revenueActual' },
  'af-ltv':     { source: 'af',     field: 'revenueLTV' },
  'xmp':        { source: 'xmp',    field: 'cost' },
};

function setupExpandBtns() {
  Object.keys(EXPAND_CARD_CONFIG).forEach(key => {
    const btn = document.getElementById(`expand-btn-${key}`);
    const panel = document.getElementById(`hourly-panel-${key}`);
    if (!btn || !panel) return;
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = panel.style.display !== 'none';
      if (isOpen) {
        panel.style.display = 'none';
        newBtn.classList.remove('open');
      } else {
        const { source, field } = EXPAND_CARD_CONFIG[key];
        renderHourlyPanel(`hourly-panel-${key}`, source, field);
        panel.style.display = 'block';
        newBtn.classList.add('open');
      }
    });
  });
}



function buildProductRow(product, snapshot) {
  const athena = (snapshot.athena || []).find(a => a.product === product);
  const xmp = (snapshot.xmp || []).find(x => x.product === product);
  const athenaTotal = athena ? athena.totalRevenue : null;
  const athenaNew = athena ? athena.newUserRevenue : null;
  const afP = afSummaryData && afSummaryData.products ? afSummaryData.products[product] : null;
  const afActual = afP ? afP.revenueActual : null;
  const afLTV = afP ? afP.revenueLTV : null;
  const afInstalls = afP ? afP.installs : null;
  const xmpCost = xmp ? xmp.cost : null;
  const cpi = (xmpCost != null && afInstalls != null && afInstalls > 0) ? (xmpCost / afInstalls) : null;
  const roi = (athenaNew != null && xmpCost != null && xmpCost > 0) ? (athenaNew / xmpCost * 100) : null;
  return { product, athenaTotal, athenaNew, afActual, afLTV, afInstalls, xmpCost, cpi, roi };
}

function setDelta(id, val, type) {
  const el = document.getElementById(id);
  if (!el) return;
  if (val == null || isNaN(val)) {
    el.textContent = '';
    el.className = 'card-delta';
    return;
  }
  if (Math.abs(val) < 0.005) {
    el.textContent = '无变化';
    el.className = 'card-delta neutral';
    return;
  }
  const text = type === 'pct' ? fmtDeltaPct(val) : fmtDelta(val);
  el.textContent = text;
  el.className = 'card-delta ' + (val > 0 ? 'positive' : 'negative');
}

function missingWarnHtml(missingDates) {
  if (!missingDates || missingDates.length === 0) return '';
  const tip = `缺失 ${missingDates.length} 天数据：${missingDates.join(', ')}`;
  return ` <span class="missing-warn" title="${tip}">⚠️</span>`;
}

function render() {
  if (!dayData || !dayData.snapshots || dayData.snapshots.length === 0) {
    document.getElementById('product-tbody').innerHTML = '<tr><td colspan="9" class="empty-msg">暂无数据，等待首次抓取...</td></tr>';
    ['val-athena', 'val-athena-new', 'val-af', 'val-af-ltv', 'val-xmp', 'val-roi'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '--';
    });
    ['delta-athena', 'delta-athena-new', 'delta-af', 'delta-af-ltv', 'delta-xmp', 'delta-roi'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = '';
        el.className = 'card-delta';
      }
    });
    return;
  }

  const latest = dayData.snapshots[dayData.snapshots.length - 1];
  const isRange = dayData.isRange;
  if (isRange) {
    document.getElementById('last-update').textContent = `日期范围：${dayData.startDate} → ${dayData.endDate}`;
  } else {
    document.getElementById('last-update').textContent = '最后更新：' + fmtTime(latest.time);
  }

  // 如果增量面板已展开，刷新内容
  Object.keys(EXPAND_CARD_CONFIG).forEach(key => {
    const panel = document.getElementById(`hourly-panel-${key}`);
    if (panel && panel.style.display !== 'none') {
      const { source, field } = EXPAND_CARD_CONFIG[key];
      renderHourlyPanel(`hourly-panel-${key}`, source, field);
    }
  });

  let rows = PRODUCTS.map(p => buildProductRow(p, latest));
  if (sortField) {
    rows.sort((a, b) => {
      let va = a[sortField];
      let vb = b[sortField];
      if (sortField === 'product') {
        va = va || '';
        vb = vb || '';
        return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      va = va == null ? -Infinity : va;
      vb = vb == null ? -Infinity : vb;
      return sortDir === 'asc' ? va - vb : vb - va;
    });
  }

  const totalAthena = rows.reduce((s, r) => s + (r.athenaTotal || 0), 0);
  const totalAthenaNew = rows.reduce((s, r) => s + (r.athenaNew || 0), 0);
  const totalAF = rows.reduce((s, r) => s + (r.afActual || 0), 0);
  const totalAFLTV = rows.reduce((s, r) => s + (r.afLTV || 0), 0);
  const totalXMP = rows.reduce((s, r) => s + (r.xmpCost || 0), 0);
  const totalROI = totalXMP > 0 ? (totalAthenaNew / totalXMP * 100) : null;

  document.getElementById('val-athena').innerHTML = fmt(totalAthena);
  document.getElementById('val-athena-new').innerHTML = fmt(totalAthenaNew);
  document.getElementById('val-af').innerHTML = fmt(totalAF);
  document.getElementById('val-af-ltv').innerHTML = fmt(totalAFLTV);
  document.getElementById('val-xmp').innerHTML = fmt(totalXMP);
  document.getElementById('val-roi').textContent = totalROI != null ? fmtPct(totalROI) : '--';

  // Missing data warnings for range mode
  const warn = missingWarnHtml(dayData.missingDates);
  if (warn) {
    ['val-athena', 'val-athena-new', 'val-xmp'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML += warn;
    });
  }
  // AF missing dates (from afSummaryData)
  const afWarn = missingWarnHtml(afSummaryData && afSummaryData.missingDates);
  if (afWarn) {
    ['val-af', 'val-af-ltv'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML += afWarn;
    });
  }

  // Range mode: hide deltas and hourly expand buttons
  if (isRange) {
    ['delta-athena', 'delta-athena-new', 'delta-af', 'delta-af-ltv', 'delta-xmp', 'delta-roi'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = ''; el.className = 'card-delta'; }
    });
    ['athena', 'athena-new', 'af', 'af-ltv', 'xmp', 'roi'].forEach(key => {
      const hintEl = document.getElementById('delta-hint-' + key);
      if (hintEl) hintEl.textContent = '';
    });
    // Hide hourly expand buttons in range mode
    Object.keys(EXPAND_CARD_CONFIG).forEach(key => {
      const btn = document.getElementById(`expand-btn-${key}`);
      const panel = document.getElementById(`hourly-panel-${key}`);
      if (btn) btn.style.display = 'none';
      if (panel) panel.style.display = 'none';
    });
  } else {
    // Show hourly expand buttons in single-day mode
    Object.keys(EXPAND_CARD_CONFIG).forEach(key => {
      const btn = document.getElementById(`expand-btn-${key}`);
      if (btn) btn.style.display = '';
    });

  const yesterdayMatch = findYesterdaySameTimeSnapshot(latest.time);
  if (yesterdayMatch) {
    const prevRows = PRODUCTS.map(p => buildProductRow(p, yesterdayMatch));
    const prevTotalAthena = prevRows.reduce((s, r) => s + (r.athenaTotal || 0), 0);
    const prevTotalAthenaNew = prevRows.reduce((s, r) => s + (r.athenaNew || 0), 0);
    // For AF deltas, use prevAfSummaryData (DB query) instead of snapshot
    let prevTotalAF = 0, prevTotalAFLTV = 0;
    if (prevAfSummaryData && prevAfSummaryData.products) {
      for (const p of Object.values(prevAfSummaryData.products)) {
        prevTotalAF += (p.revenueActual || 0);
        prevTotalAFLTV += (p.revenueLTV || 0);
      }
    }
    const prevTotalXMP = prevRows.reduce((s, r) => s + (r.xmpCost || 0), 0);
    const prevTotalROI = prevTotalXMP > 0 ? (prevTotalAthenaNew / prevTotalXMP * 100) : null;
    setDelta('delta-athena', totalAthena - prevTotalAthena, 'money');
    setDelta('delta-athena-new', totalAthenaNew - prevTotalAthenaNew, 'money');
    setDelta('delta-af', totalAF - prevTotalAF, 'money');
    setDelta('delta-af-ltv', totalAFLTV - prevTotalAFLTV, 'money');
    setDelta('delta-xmp', totalXMP - prevTotalXMP, 'money');
    setDelta('delta-roi', (totalROI != null && prevTotalROI != null) ? totalROI - prevTotalROI : null, 'pct');
    const matchTime = fmtShortTime(yesterdayMatch.time);
    ['athena', 'athena-new', 'af', 'af-ltv', 'xmp', 'roi'].forEach(key => {
      const hintEl = document.getElementById('delta-hint-' + key);
      if (hintEl) hintEl.textContent = `vs 昨日 ${matchTime}`;
    });
  }
  } // end single-day else block

  const tbody = document.getElementById('product-tbody');
  tbody.innerHTML = rows.map(r => {
    const roiClass = r.roi != null ? (r.roi >= 100 ? 'roi-positive' : 'roi-negative') : 'val-na';
    return `<tr>
      <td>${r.product}</td>
      <td>${r.athenaTotal != null ? fmt(r.athenaTotal) : '<span class="val-na">--</span>'}</td>
      <td>${r.athenaNew != null ? fmt(r.athenaNew) : '<span class="val-na">--</span>'}</td>
      <td>${r.afActual != null ? fmt(r.afActual) : '<span class="val-na">--</span>'}</td>
      <td>${r.afLTV != null ? fmt(r.afLTV) : '<span class="val-na">--</span>'}</td>
      <td>${r.afInstalls != null ? Math.round(r.afInstalls).toLocaleString() : '<span class="val-na">--</span>'}</td>
      <td>${r.xmpCost != null ? fmt(r.xmpCost) : '<span class="val-na">--</span>'}</td>
      <td>${r.cpi != null ? fmt(r.cpi) : '<span class="val-na">--</span>'}</td>
      <td class="${roiClass}">${r.roi != null ? fmtPct(r.roi) : '<span class="val-na">--</span>'}</td>
    </tr>`;
  }).join('');

  // Trend chart: hide in range mode
  const chartSection = document.querySelector('.chart-section');
  if (isRange) {
    if (chartSection) chartSection.style.display = 'none';
    if (trendChart) { trendChart.destroy(); trendChart = null; }
  } else {
    if (chartSection) chartSection.style.display = '';
    renderTrendChart();
  }

  // Channel summary table
  renderChannelSummary();
}

const CHANNEL_ORDER = ['FB', 'GG', 'TT'];
const CHANNEL_LABELS = { FB: 'Facebook', GG: 'Google', TT: 'TikTok' };
const _channelExpanded = {}; // Track expanded state per channel

function renderChannelSummary() {
  const tbody = document.getElementById('channel-tbody');
  if (!tbody) return;
  if (channelSummaryData === null) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">\u52a0\u8f7d\u4e2d...</td></tr>';
    return;
  }
  if (!channelSummaryData || !channelSummaryData.channels) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">\u6682\u65e0\u6570\u636e</td></tr>';
    return;
  }
  const chs = channelSummaryData.channels;
  const d7Inc = channelSummaryData.d7Incomplete || [];
  const hasD7Warning = d7Inc.length > 0;
  const xmpMiss = channelSummaryData.xmpMissingDates || [];
  const hasXmpWarning = xmpMiss.length > 0;

  // XMP backfill button HTML generator
  function xmpBackfillBtn() {
    if (!hasXmpWarning) return '';
    const estMinutes = Math.ceil(xmpMiss.length * 10 / 60);
    const estText = xmpMiss.length <= 6 ? `~${xmpMiss.length * 10}\u79d2` : `~${estMinutes}\u5206\u949f`;
    return ` <button class="xmp-backfill-btn" onclick="showXmpBackfillModal()" title="\u7f3a\u5c11${xmpMiss.length}\u5929XMP\u7f13\u5b58">\u26a0\ufe0f ${xmpMiss.length}\u5929</button>`;
  }

  // Compute totals
  let totalCost = 0, totalRevenue = 0, totalInstalls = 0, totalNewUserRevenue = 0, totalD7Revenue = 0;
  for (const ch of CHANNEL_ORDER) {
    const d = chs[ch];
    if (!d) continue;
    totalCost += d.cost || 0;
    totalRevenue += d.revenue || 0;
    totalInstalls += d.installs || 0;
    totalNewUserRevenue += d.newUserRevenue || 0;
    totalD7Revenue += d.d7Revenue || 0;
  }

  const rows = [];
  for (const ch of CHANNEL_ORDER) {
    const d = chs[ch];
    if (!d) { rows.push(`<tr><td>${CHANNEL_LABELS[ch] || ch}</td><td colspan="5" class="val-na">--</td></tr>`); continue; }
    const roasClass = d.newUserRoas != null ? (d.newUserRoas >= 30 ? 'roi-positive' : 'roi-negative') : 'val-na';
    const d7Class = d.d7Roas != null ? (d.d7Roas >= 100 ? 'roi-positive' : 'roi-negative') : 'val-na';
    const d7Warn = hasD7Warning ? ' <span class="d7-warn" title="\u90e8\u5206\u65e5\u671f\u672a\u6ee17\u5929">*</span>' : '';
    const hasProducts = d.products && Object.keys(d.products).length > 0;
    const isExpanded = !!_channelExpanded[ch];
    const arrow = hasProducts ? `<span class="ch-arrow ${isExpanded ? 'expanded' : ''}" onclick="toggleChannelProducts('${ch}')">${isExpanded ? '\u25bc' : '\u25b6'}</span> ` : '';
    const rowClick = hasProducts ? ` onclick="toggleChannelProducts('${ch}')" style="cursor:pointer"` : '';
    rows.push(`<tr class="ch-row" data-channel="${ch}"${rowClick}>
      <td class="ch-label ch-${ch.toLowerCase()}">${arrow}${CHANNEL_LABELS[ch] || ch}</td>
      <td>${fmt(d.cost)}</td>
      <td>${fmt(d.revenue)}</td>
      <td>${d.cpi != null ? fmt(d.cpi) : '<span class="val-na">--</span>'}</td>
      <td class="${roasClass}">${d.newUserRoas != null ? fmtPct(d.newUserRoas) : '<span class="val-na">--</span>'}</td>
      <td class="${d7Class}">${d.d7Roas != null ? fmtPct(d.d7Roas) + d7Warn : '<span class="val-na">--</span>'}</td>
    </tr>`);
    // Product detail rows (shown when expanded)
    if (hasProducts && isExpanded) {
      const sortedProducts = Object.entries(d.products).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
      for (const [prod, pd] of sortedProducts) {
        const pRoasClass = pd.newUserRoas != null ? (pd.newUserRoas >= 30 ? 'roi-positive' : 'roi-negative') : 'val-na';
        const pD7Class = pd.d7Roas != null ? (pd.d7Roas >= 100 ? 'roi-positive' : 'roi-negative') : 'val-na';
        const pD7Warn = hasD7Warning ? ' <span class="d7-warn">*</span>' : '';
        rows.push(`<tr class="ch-product-row" data-channel="${ch}">
          <td class="ch-product-label">${prod}</td>
          <td>${fmt(pd.cost)}</td>
          <td>${fmt(pd.revenue)}</td>
          <td>${pd.cpi != null ? fmt(pd.cpi) : '<span class="val-na">--</span>'}</td>
          <td class="${pRoasClass}">${pd.newUserRoas != null ? fmtPct(pd.newUserRoas) : '<span class="val-na">--</span>'}</td>
          <td class="${pD7Class}">${pd.d7Roas != null ? fmtPct(pd.d7Roas) + pD7Warn : '<span class="val-na">--</span>'}</td>
        </tr>`);
      }
    }
  }

  // Total row
  const totalCPI = totalInstalls > 0 ? totalCost / totalInstalls : null;
  const totalNewRoas = totalCost > 0 ? totalNewUserRevenue / totalCost * 100 : null;
  const totalD7Roas = totalCost > 0 ? totalD7Revenue / totalCost * 100 : null;
  const totalRoasClass = totalNewRoas != null ? (totalNewRoas >= 30 ? 'roi-positive' : 'roi-negative') : 'val-na';
  const totalD7Class = totalD7Roas != null ? (totalD7Roas >= 100 ? 'roi-positive' : 'roi-negative') : 'val-na';
  const d7Warn = hasD7Warning ? ' <span class="d7-warn" title="\u90e8\u5206\u65e5\u671f\u672a\u6ee17\u5929">*</span>' : '';
  const totalCostWarn = xmpBackfillBtn();
  rows.push(`<tr class="total-row">
    <td>\u5408\u8ba1</td>
    <td>${fmt(totalCost)}${totalCostWarn}</td>
    <td>${fmt(totalRevenue)}</td>
    <td>${totalCPI != null ? fmt(totalCPI) : '<span class="val-na">--</span>'}</td>
    <td class="${totalRoasClass}">${totalNewRoas != null ? fmtPct(totalNewRoas) : '<span class="val-na">--</span>'}</td>
    <td class="${totalD7Class}">${totalD7Roas != null ? fmtPct(totalD7Roas) + d7Warn : '<span class="val-na">--</span>'}</td>
  </tr>`);

  tbody.innerHTML = rows.join('');
}

function toggleChannelProducts(ch) {
  _channelExpanded[ch] = !_channelExpanded[ch];
  renderChannelSummary();
}

// ── XMP Backfill Modal ──
function showXmpBackfillModal() {
  if (!channelSummaryData || !channelSummaryData.xmpMissingDates) return;
  const dates = channelSummaryData.xmpMissingDates;
  const estSeconds = dates.length * 15;
  const estText = estSeconds < 60 ? `~${estSeconds}\u79d2` : `~${Math.ceil(estSeconds / 60)} \u5206\u949f`;

  // Remove existing modal if any
  let modal = document.getElementById('xmp-backfill-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'xmp-backfill-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content xmp-backfill-content">
      <h3>\u26a0\ufe0f \u7f3a\u5c11 ${dates.length} \u5929 XMP \u7f13\u5b58</h3>
      <div class="xmp-date-list">
        ${dates.map(d => `<div class="xmp-date-item" id="xmp-date-${d}"><span class="xmp-date-icon">\u2b1c</span> ${d}</div>`).join('')}
      </div>
      <div class="xmp-backfill-info">
        <p>\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u4e00\u952e\u8865\u5168\u7f13\u5b58\uff0c\u9884\u8ba1\u7b49\u5f85 <strong>${estText}</strong></p>
        <p class="xmp-backfill-note">\u6bcf\u4e2a\u65e5\u671f\u4f1a\u786e\u8ba4 FB/GG/TT \u4e09\u6e20\u9053\u5168\u90e8\u8865\u5168\uff0c\u9047\u5230\u9650\u9891\u81ea\u52a8\u91cd\u8bd5\uff08\u6700\u591a2\u6b21\uff0c\u6bcf\u6b21\u7b4960s\uff09</p>
      </div>
      <div class="xmp-backfill-actions">
        <button id="xmp-backfill-start" class="btn-primary" onclick="startXmpBackfill()">\ud83d\ude80 \u5f00\u59cb\u8865\u5168</button>
        <button class="btn-secondary" onclick="closeXmpBackfillModal()">\u5173\u95ed</button>
      </div>
      <div id="xmp-backfill-progress" class="xmp-backfill-progress" style="display:none">
        <div class="progress-bar-container"><div id="xmp-progress-bar" class="progress-bar"></div></div>
        <span id="xmp-progress-text">0/${dates.length}</span>
      </div>
    </div>
  `;
  modal.addEventListener('click', e => { if (e.target === modal) closeXmpBackfillModal(); });
  document.body.appendChild(modal);
}

function closeXmpBackfillModal() {
  const modal = document.getElementById('xmp-backfill-modal');
  if (modal) modal.remove();
}

async function startXmpBackfill() {
  if (!channelSummaryData || !channelSummaryData.xmpMissingDates) return;
  const dates = channelSummaryData.xmpMissingDates;
  const btn = document.getElementById('xmp-backfill-start');
  const progress = document.getElementById('xmp-backfill-progress');
  if (btn) btn.disabled = true;
  if (btn) btn.textContent = '\u2708\ufe0f \u8865\u5168\u4e2d...';
  if (progress) progress.style.display = 'flex';

  try {
    const resp = await fetch(apiUrl('/api/xmp-backfill'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dates }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const dateEl = document.getElementById(`xmp-date-${msg.date}`);
          const iconEl = dateEl?.querySelector('.xmp-date-icon');
          if (msg.status === 'fetching' && iconEl) {
            iconEl.textContent = '\u23f3';
          } else if (msg.status === 'retrying' && iconEl) {
            iconEl.textContent = '\ud83d\udd04';
            if (dateEl) {
              let retry = dateEl.querySelector('.retry-note');
              if (!retry) { retry = document.createElement('span'); retry.className = 'retry-note'; dateEl.appendChild(retry); }
              const missing = msg.missingChannels ? ` (${msg.missingChannels.join('/')})` : '';
              retry.textContent = ` \u91cd\u8bd5${msg.attempt}/${msg.maxRetries}${missing}`;
            }
          } else if (msg.status === 'done' && iconEl) {
            iconEl.textContent = '\u2705';
            const retry = dateEl?.querySelector('.retry-note');
            if (retry) retry.remove();
          } else if (msg.status === 'partial' && iconEl) {
            iconEl.textContent = '\u26a0\ufe0f';
            const retry = dateEl?.querySelector('.retry-note');
            if (retry) retry.textContent = ' \u90e8\u5206\u6e20\u9053\u672a\u8865\u5168';
          } else if (msg.status === 'error' && iconEl) {
            iconEl.textContent = '\u274c';
          }
          // Update progress bar
          const pct = msg.total > 0 ? (msg.completed / msg.total * 100) : 0;
          const bar = document.getElementById('xmp-progress-bar');
          const text = document.getElementById('xmp-progress-text');
          if (bar) bar.style.width = pct + '%';
          if (text) text.textContent = `${msg.completed}/${msg.total}`;

          if (msg.status === 'complete') {
            if (btn) btn.textContent = '\u2705 \u5b8c\u6210';
            // Auto-refresh channel summary after backfill
            const sDate = document.getElementById('startDate')?.value;
            const eDate = document.getElementById('endDate')?.value;
            if (sDate && eDate) {
              const newData = await fetchChannelSummary(sDate, eDate);
              if (newData) {
                channelSummaryData = newData;
                renderChannelSummary();
              }
            }
            // Close modal after 1.5s
            setTimeout(closeXmpBackfillModal, 1500);
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    if (btn) { btn.textContent = '\u274c \u5931\u8d25'; btn.disabled = false; }
    console.error('Backfill error:', err);
  }
}


function mergePersonalData(snapshot) {
  const map = {};
  if (snapshot.xmp) {
    for (const item of snapshot.xmp) {
      const key = `${item.product}|${item.channel}`;
      if (!map[key]) map[key] = { product: item.product, channel: item.channel };
      map[key].cost = item.cost;
      map[key].cpm = item.cpm;
      map[key].cpc = item.cpc;
    }
  }
  if (snapshot.af) {
    for (const item of snapshot.af) {
      const key = `${item.product}|${item.channel}`;
      if (!map[key]) map[key] = { product: item.product, channel: item.channel };
      map[key].installs = item.installs;
      map[key].revenueActual = item.revenueActual;
      map[key].revenueLTV = item.revenueLTV;
    }
  }
  if (snapshot.ad) {
    for (const item of snapshot.ad) {
      const key = `${item.product}|${item.channel}`;
      if (!map[key]) map[key] = { product: item.product, channel: item.channel };
      map[key].installs = item.installs;
      map[key].revenueActual = item.revenueActual;
      map[key].revenueLTV = item.revenueLTV;
    }
  }
  const rows = Object.values(map);
  for (const r of rows) {
    r.name = `${r.product} ${r.channel}`;
    r.cpi = (r.cost != null && r.installs != null && r.installs > 0) ? (r.cost / r.installs) : null;
    r.newUserRoas = (r.revenueLTV != null && r.cost != null && r.cost > 0) ? (r.revenueLTV / r.cost * 100) : null;
  }
  return rows;
}

function renderPersonal() {
  if (!personalDayData || !personalDayData.snapshots || personalDayData.snapshots.length === 0) {
    document.getElementById('personal-tbody').innerHTML = '<tr><td colspan="9" class="empty-msg">暂无数据，等待首次抓取...</td></tr>';
    ['p-val-cost', 'p-val-actual', 'p-val-ltv', 'p-val-roi'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '--';
    });
    ['p-delta-cost', 'p-delta-actual', 'p-delta-ltv', 'p-delta-roi'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = '';
        el.className = 'card-delta';
      }
    });
    ['cost', 'actual', 'ltv', 'roi'].forEach(key => {
      const hintEl = document.getElementById('p-delta-hint-' + key);
      if (hintEl) hintEl.textContent = '';
    });
    return;
  }

  const latest = personalDayData.snapshots[personalDayData.snapshots.length - 1];
  document.getElementById('last-update').textContent = '最后更新：' + fmtTime(latest.time);
  let rows = mergePersonalData(latest);

  if (personalSortField) {
    rows.sort((a, b) => {
      let va = a[personalSortField];
      let vb = b[personalSortField];
      if (personalSortField === 'name') {
        va = va || ''; vb = vb || '';
        return personalSortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      va = va == null ? -Infinity : va;
      vb = vb == null ? -Infinity : vb;
      return personalSortDir === 'asc' ? va - vb : vb - va;
    });
  }

  const totalCost = rows.reduce((s, r) => s + (r.cost || 0), 0);
  const totalActual = rows.reduce((s, r) => s + (r.revenueActual || 0), 0);
  const totalLTV = rows.reduce((s, r) => s + (r.revenueLTV || 0), 0);
  const totalNewUserRoas = totalCost > 0 ? (totalLTV / totalCost * 100) : null;

  document.getElementById('p-val-cost').textContent = totalCost > 0 ? fmt(totalCost) : '--';
  document.getElementById('p-val-actual').textContent = totalActual > 0 ? fmt(totalActual) : '--';
  document.getElementById('p-val-ltv').textContent = totalLTV > 0 ? fmt(totalLTV) : '--';
  document.getElementById('p-val-roi').textContent = totalNewUserRoas != null ? fmtPct(totalNewUserRoas) : '--';

  const yesterdayMatch = findPersonalYesterdaySameTimeSnapshot(latest.time);
  if (yesterdayMatch) {
    const prevRows = mergePersonalData(yesterdayMatch);
    const prevTotalCost = prevRows.reduce((s, r) => s + (r.cost || 0), 0);
    const prevTotalActual = prevRows.reduce((s, r) => s + (r.revenueActual || 0), 0);
    const prevTotalLTV = prevRows.reduce((s, r) => s + (r.revenueLTV || 0), 0);
    const prevTotalNewUserRoas = prevTotalCost > 0 ? (prevTotalLTV / prevTotalCost * 100) : null;
    setDelta('p-delta-cost', totalCost - prevTotalCost, 'money');
    setDelta('p-delta-actual', totalActual - prevTotalActual, 'money');
    setDelta('p-delta-ltv', totalLTV - prevTotalLTV, 'money');
    setDelta('p-delta-roi', (totalNewUserRoas != null && prevTotalNewUserRoas != null) ? totalNewUserRoas - prevTotalNewUserRoas : null, 'pct');
    const matchTime = fmtShortTime(yesterdayMatch.time);
    ['cost', 'actual', 'ltv', 'roi'].forEach(key => {
      const hintEl = document.getElementById('p-delta-hint-' + key);
      if (hintEl) hintEl.textContent = `vs 昨日 ${matchTime}`;
    });
  } else {
    ['p-delta-cost', 'p-delta-actual', 'p-delta-ltv', 'p-delta-roi'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.textContent = '';
        el.className = 'card-delta';
      }
    });
    ['cost', 'actual', 'ltv', 'roi'].forEach(key => {
      const hintEl = document.getElementById('p-delta-hint-' + key);
      if (hintEl) hintEl.textContent = '';
    });
  }

  const tbody = document.getElementById('personal-tbody');
  tbody.innerHTML = rows.map(r => {
    const roasClass = r.newUserRoas != null ? (r.newUserRoas >= 100 ? 'roi-positive' : 'roi-negative') : 'val-na';
    return `<tr>
      <td>${r.name || '--'}</td>
      <td>${r.cost != null ? fmt(r.cost) : '<span class="val-na">--</span>'}</td>
      <td>${r.cpm != null ? fmt(r.cpm) : '<span class="val-na">--</span>'}</td>
      <td>${r.cpc != null ? fmt(r.cpc) : '<span class="val-na">--</span>'}</td>
      <td>${r.installs != null ? r.installs.toLocaleString() : '<span class="val-na">--</span>'}</td>
      <td>${r.cpi != null ? fmt(r.cpi) : '<span class="val-na">--</span>'}</td>
      <td>${r.revenueActual != null ? fmt(r.revenueActual) : '<span class="val-na">--</span>'}</td>
      <td>${r.revenueLTV != null ? fmt(r.revenueLTV) : '<span class="val-na">--</span>'}</td>
      <td class="${roasClass}">${r.newUserRoas != null ? fmtPct(r.newUserRoas) : '<span class="val-na">--</span>'}</td>
    </tr>`;
  }).join('');

  renderPersonalTrendChart();
}

function renderTrendChart() {
  if (!dayData || !dayData.snapshots || dayData.snapshots.length === 0) {
    if (trendChart) { trendChart.destroy(); trendChart = null; }
    return;
  }

  function getLocalHour(isoStr) {
    const d = new Date(isoStr);
    const localDate = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const parts = d.toLocaleString('en-US', {
      timeZone: 'Asia/Shanghai', hour: 'numeric', minute: 'numeric', hour12: false
    }).split(':');
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (dayData.date && localDate > dayData.date) return 24;
    return h + m / 60;
  }

  const athenaPoints = [];
  const athenaNewPoints = [];
  const afPoints = [];
  const afLtvPoints = [];
  const xmpPoints = [];

  dayData.snapshots.forEach(s => {
    const hour = getLocalHour(s.time);
    if (s.athena) {
      athenaPoints.push({ x: hour, y: s.athena.reduce((sum, a) => sum + (a.totalRevenue || 0), 0) });
      athenaNewPoints.push({ x: hour, y: s.athena.reduce((sum, a) => sum + (a.newUserRevenue || 0), 0) });
    }
    if (s.af) {
      afPoints.push({ x: hour, y: s.af.reduce((sum, a) => sum + (a.revenueActual || 0), 0) });
      afLtvPoints.push({ x: hour, y: s.af.reduce((sum, a) => sum + (a.revenueLTV || 0), 0) });
    }
    if (s.xmp) xmpPoints.push({ x: hour, y: s.xmp.reduce((sum, x) => sum + (x.cost || 0), 0) });
  });

  const ctx = document.getElementById('trend-chart').getContext('2d');
  if (trendChart) { trendChart.destroy(); }
  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        { label: '雅典娜总收入', data: athenaPoints, borderColor: '#00d4ff', backgroundColor: 'rgba(0,212,255,0.1)', borderWidth: 2, tension: 0, fill: false, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: '#00d4ff', pointBorderColor: '#00d4ff', showLine: true, spanGaps: true },
        { label: '雅典娜新用户收入', data: athenaNewPoints, borderColor: '#66e3ff', backgroundColor: 'rgba(102,227,255,0.1)', borderWidth: 2, tension: 0, fill: false, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: '#66e3ff', pointBorderColor: '#66e3ff', showLine: true, spanGaps: true },
        { label: 'AF Actual', data: afPoints, borderColor: '#00ff88', backgroundColor: 'rgba(0,255,136,0.1)', borderWidth: 2, tension: 0, fill: false, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: '#00ff88', pointBorderColor: '#00ff88', showLine: true, spanGaps: true },
        { label: 'AF LTV', data: afLtvPoints, borderColor: '#7dffb9', backgroundColor: 'rgba(125,255,185,0.1)', borderWidth: 2, tension: 0, fill: false, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: '#7dffb9', pointBorderColor: '#7dffb9', showLine: true, spanGaps: true },
        { label: 'XMP 消耗', data: xmpPoints, borderColor: '#ff4444', backgroundColor: 'rgba(255,68,68,0.1)', borderWidth: 2, tension: 0, fill: false, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: '#ff4444', pointBorderColor: '#ff4444', showLine: true, spanGaps: true },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { labels: { color: '#8888aa', font: { size: 12 } } },
        tooltip: {
          callbacks: {
            title: function(items) {
              if (!items.length) return '';
              const h = items[0].raw.x;
              const hh = Math.floor(h);
              const mm = Math.round((h - hh) * 60);
              return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
            },
            label: function(ctx) { return ctx.dataset.label + ': ' + fmt(ctx.raw.y); }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: 24,
          ticks: {
            color: '#555577',
            font: { size: 11 },
            stepSize: 1,
            callback: function(value) {
              if (value % 2 === 0) return String(value).padStart(2, '0') + ':00';
              return '';
            }
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
          title: { display: true, text: '时间', color: '#555577' }
        },
        y: {
          ticks: {
            color: '#555577',
            font: { size: 11 },
            callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0))
          },
          grid: { color: 'rgba(255,255,255,0.06)' }
        }
      }
    }
  });
}

function renderPersonalTrendChart() {
  if (!personalDayData || !personalDayData.snapshots || personalDayData.snapshots.length === 0) {
    if (personalTrendChart) { personalTrendChart.destroy(); personalTrendChart = null; }
    return;
  }

  function getLocalHour(isoStr) {
    const d = new Date(isoStr);
    const localDate = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    const parts = d.toLocaleString('en-US', {
      timeZone: 'Asia/Shanghai', hour: 'numeric', minute: 'numeric', hour12: false
    }).split(':');
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (personalDayData.date && localDate > personalDayData.date) return 24;
    return h + m / 60;
  }

  const costPoints = [];
  const actualPoints = [];
  const ltvPoints = [];
  personalDayData.snapshots.forEach(s => {
    const hour = getLocalHour(s.time);
    const rows = mergePersonalData(s);
    const totalCost = rows.reduce((sum, r) => sum + (r.cost || 0), 0);
    const totalActual = rows.reduce((sum, r) => sum + (r.revenueActual || 0), 0);
    const totalLtv = rows.reduce((sum, r) => sum + (r.revenueLTV || 0), 0);
    if (totalCost > 0) costPoints.push({ x: hour, y: totalCost });
    if (totalActual > 0) actualPoints.push({ x: hour, y: totalActual });
    if (totalLtv > 0) ltvPoints.push({ x: hour, y: totalLtv });
  });

  const ctx = document.getElementById('personal-trend-chart').getContext('2d');
  if (personalTrendChart) { personalTrendChart.destroy(); }
  personalTrendChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        { label: '总消耗', data: costPoints, borderColor: '#ff4444', backgroundColor: 'rgba(255,68,68,0.1)', borderWidth: 2, tension: 0, fill: false, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: '#ff4444', pointBorderColor: '#ff4444', showLine: true, spanGaps: true },
        { label: 'Actual 收入', data: actualPoints, borderColor: '#00ff88', backgroundColor: 'rgba(0,255,136,0.1)', borderWidth: 2, tension: 0, fill: false, pointRadius: 5, pointHoverRadius: 7, pointBackgroundColor: '#00ff88', pointBorderColor: '#00ff88', showLine: true, spanGaps: true },
        { label: 'LTV 收入', data: ltvPoints, borderColor: '#7dffb9', backgroundColor: 'rgba(125,255,185,0.1)', borderWidth: 2, tension: 0, fill: false, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: '#7dffb9', pointBorderColor: '#7dffb9', showLine: true, spanGaps: true },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { labels: { color: '#8888aa', font: { size: 12 } } },
        tooltip: {
          callbacks: {
            title: function(items) {
              if (!items.length) return '';
              const h = items[0].raw.x;
              const hh = Math.floor(h);
              const mm = Math.round((h - hh) * 60);
              return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
            },
            label: function(ctx) { return ctx.dataset.label + ': ' + fmt(ctx.raw.y); }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: 24,
          ticks: {
            color: '#555577',
            font: { size: 11 },
            stepSize: 1,
            callback: function(value) {
              if (value % 2 === 0) return String(value).padStart(2, '0') + ':00';
              return '';
            }
          },
          grid: { color: 'rgba(255,255,255,0.04)' },
          title: { display: true, text: '时间', color: '#555577' }
        },
        y: {
          ticks: {
            color: '#555577',
            font: { size: 11 },
            callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0))
          },
          grid: { color: 'rgba(255,255,255,0.06)' }
        }
      }
    }
  });
}

function updateStatusBarVisibility() {
  const summaryBar = document.getElementById('status-bar-summary');
  const personalBar = document.getElementById('status-bar-personal');
  const creativeBar = document.getElementById('status-bar-creative');
  const aigcBar = document.getElementById('status-bar-aigc');
  if (summaryBar) summaryBar.style.display = currentPanel === 'summary' ? 'flex' : 'none';
  if (personalBar) personalBar.style.display = currentPanel === 'personal' ? 'flex' : 'none';
  if (creativeBar) creativeBar.style.display = currentPanel === 'creative' ? 'flex' : 'none';
  if (aigcBar) aigcBar.style.display = currentPanel === 'aigc' ? 'flex' : 'none';
  // Postback panel doesn't need a status bar (data is live from DB)
}

async function updateStatus() {
  try {
    const status = await fetchStatus();
    const sourceMap = { athena: '雅典娜', af: 'AF', xmp: 'XMP' };
    Object.keys(sourceMap).forEach(src => {
      const el = document.getElementById(`status-${src}`);
      const info = status.sources[src];
      if (!el || !info) return;
      let text = `${sourceMap[src]}：`;
      if (info.status === 'fetching') text += '抓取中...';
      else if (info.status === 'success') text += '✓ ' + fmtShortTime(info.lastSuccess);
      else if (info.status === 'error') text += '✗ 失败';
      else text += '待抓取';
      el.innerHTML = `<span class="status-dot ${info.status || 'idle'}"></span> ${text}`;
    });
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const mins = Math.round((nextHour - now) / 1000 / 60);
    document.getElementById('status-next').textContent = status.isFetching ? '正在抓取中...' : `下次抓取：约 ${mins} 分钟后`;
    const btn = document.getElementById('btn-refresh-summary');
    if (btn) {
      btn.disabled = !!status.isFetching;
      btn.classList.toggle('spinning', !!status.isFetching);
    }
  } catch (err) {
    console.error('Status update failed:', err);
  }
}

async function updatePersonalStatus() {
  try {
    const status = await fetchPersonalStatus();
    const sourceMap = { xmp: 'XMP', af: 'AF', ad: 'AD' };
    Object.keys(sourceMap).forEach(src => {
      const el = document.getElementById(`personal-status-${src}`);
      const info = status.sources[src];
      if (!el || !info) return;
      let text = `${sourceMap[src]}：`;
      if (info.status === 'fetching') text += '抓取中...';
      else if (info.status === 'success') text += '✓ ' + fmtShortTime(info.lastSuccess);
      else if (info.status === 'error') text += '✗ 失败';
      else text += '待抓取';
      el.innerHTML = `<span class="status-dot ${info.status || 'idle'}"></span> ${text}`;
    });
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const mins = Math.round((nextHour - now) / 1000 / 60);
    document.getElementById('personal-status-next').textContent = status.isFetching ? '正在抓取中...' : `下次抓取：约 ${mins} 分钟后`;
    const btn = document.getElementById('btn-refresh-personal');
    if (btn) {
      btn.disabled = !!status.isFetching;
      btn.classList.toggle('spinning', !!status.isFetching);
    }
  } catch (err) {
    console.error('Personal status update failed:', err);
  }
}

function revealPersonalAccess() {
  const pbBtn = document.getElementById('postback-panel-entry');
  const pbpBtn = document.getElementById('pb-personal-entry');
  if (currentPanel !== 'summary') return;

  // Check if already unlocked via session
  fetch(apiUrl('/api/panel-access')).then(r => r.json()).then(data => {
    if (data.unlocked) {
      showPanelButtons();
    } else {
      showPasswordOverlay();
    }
  }).catch(() => showPasswordOverlay());

  function showPanelButtons() {
    if (pbBtn) pbBtn.style.display = 'inline-flex';
    if (pbpBtn) pbpBtn.style.display = 'inline-flex';
    if (personalPanelRevealTimer) clearTimeout(personalPanelRevealTimer);
    personalPanelRevealTimer = setTimeout(() => {
      if (pbBtn) pbBtn.style.display = 'none';
      if (pbpBtn) pbpBtn.style.display = 'none';
    }, 5000);
  }

  function showPasswordOverlay() {
    // Show password overlay
    let overlay = document.getElementById('panel-lock-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'panel-lock-overlay';
      overlay.innerHTML = `
        <div class="panel-lock-dialog">
          <div class="panel-lock-icon">🔒</div>
          <input type="password" id="panel-lock-input" placeholder="输入密码" maxlength="10" autocomplete="off" />
          <div id="panel-lock-error" class="panel-lock-error"></div>
        </div>
      `;
      document.body.appendChild(overlay);

      // Style the overlay
      const style = document.createElement('style');
      style.textContent = `
        #panel-lock-overlay {
          position: fixed; top: 0; left: 0; width: 100%; height: 100%;
          background: rgba(0,0,0,0.7);
          display: flex; align-items: center; justify-content: center;
          z-index: 9999; animation: lockFadeIn 0.2s ease;
        }
        @keyframes lockFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .panel-lock-dialog {
          background: #1e1e2e; border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px; padding: 32px 28px; text-align: center;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4); min-width: 260px;
        }
        .panel-lock-icon { font-size: 36px; margin-bottom: 16px; }
        #panel-lock-input {
          width: 160px; padding: 10px 14px; font-size: 18px; text-align: center;
          border: 1px solid rgba(255,255,255,0.2); border-radius: 8px;
          background: rgba(255,255,255,0.05); color: #e0e0e0;
          outline: none; letter-spacing: 4px; transition: border-color 0.2s;
        }
        #panel-lock-input:focus { border-color: rgba(100,180,255,0.5); }
        .panel-lock-error {
          color: #ff6b6b; font-size: 13px; margin-top: 10px; min-height: 18px;
        }
        #panel-lock-input.shake {
          animation: lockShake 0.4s ease;
        }
        @keyframes lockShake {
          0%, 100% { transform: translateX(0); }
          20%, 60% { transform: translateX(-6px); }
          40%, 80% { transform: translateX(6px); }
        }
      `;
      document.head.appendChild(style);
    }

    overlay.style.display = 'flex';
    const input = document.getElementById('panel-lock-input');
    const errorEl = document.getElementById('panel-lock-error');
    input.value = '';
    errorEl.textContent = '';
    input.classList.remove('shake');
    setTimeout(() => input.focus(), 100);

    function cleanup() {
      overlay.style.display = 'none';
      input.removeEventListener('keydown', onKey);
      overlay.removeEventListener('click', onOverlayClick);
    }

    function onKey(e) {
      if (e.key === 'Escape') { cleanup(); return; }
      if (e.key === 'Enter') {
        fetch(apiUrl('/api/panel-access'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: input.value }),
        }).then(r => r.json()).then(data => {
          if (data.ok) {
            cleanup();
            showPanelButtons();
          } else {
            errorEl.textContent = '密码错误';
            input.value = '';
            input.classList.remove('shake');
            void input.offsetWidth;
            input.classList.add('shake');
          }
        }).catch(() => {
          errorEl.textContent = '请求失败';
        });
      }
    }

    function onOverlayClick(e) {
      if (e.target === overlay) cleanup();
    }

    input.addEventListener('keydown', onKey);
    overlay.addEventListener('click', onOverlayClick);
  }
}

// ===== Postback Panel =====
let postbackData = null;

async function fetchPostbackData(sDate, eDate) {
  const resp = await fetch(apiUrl(`/api/postback/data?startDate=${sDate}&endDate=${eDate}`));
  return resp.json();
}

function renderPostback() {
  const countEl = document.getElementById('pb-val-count');
  const revEl = document.getElementById('pb-val-revenue');
  const listEl = document.getElementById('postback-product-list');
  const adCountEl = document.getElementById('pb-ad-val-count');
  const adRevEl = document.getElementById('pb-ad-val-revenue');
  const adListEl = document.getElementById('postback-ad-product-list');

  // Handle both old format (products/totals) and new format (af/ad)
  const afData = postbackData.af || { products: postbackData.products || [], totals: postbackData.totals || { count: 0, revenue: 0 } };
  const adData = postbackData.ad || { products: [], totals: { count: 0, revenue: 0 } };

  // Render AF section
  if (!afData.products || afData.products.length === 0) {
    countEl.textContent = '--';
    revEl.textContent = '--';
    listEl.innerHTML = '<div class="pb-no-data">该日暂无 af_purchase 数据</div>';
  } else {
    countEl.textContent = afData.totals.count.toLocaleString();
    revEl.textContent = fmt(afData.totals.revenue);
    listEl.innerHTML = renderProductList(afData.products, 'af');
  }

  // Render AD section
  if (!adData.products || adData.products.length === 0) {
    adCountEl.textContent = '--';
    adRevEl.textContent = '--';
    adListEl.innerHTML = '<div class="pb-no-data">该日暂无 ad_purchase 数据</div>';
  } else {
    adCountEl.textContent = adData.totals.count.toLocaleString();
    adRevEl.textContent = fmt(adData.totals.revenue);
    adListEl.innerHTML = renderProductList(adData.products, 'ad');
  }
}

function renderProductList(products, prefix) {
  let html = '';
  for (const product of products) {
    const pId = prefix + '_' + product.product.replace(/[^a-zA-Z0-9]/g, '_');
    const channelMaxRevenue = Math.max(...product.channels.map(c => c.revenue), 1);

    html += `<div class="pb-product-card">
      <div class="pb-product-header" onclick="togglePostbackProduct('${pId}')">
        <span class="pb-product-name">${product.product}</span>
        <div class="pb-product-stats">
          <span class="pb-stat"><span class="pb-stat-value">${product.count.toLocaleString()}</span><span class="pb-stat-label">笔</span></span>
          <span class="pb-stat"><span class="pb-stat-value">${fmt(product.revenue)}</span></span>
          <span class="pb-expand-arrow" id="pb-arrow-${pId}">▾</span>
        </div>
      </div>
      <div class="pb-channel-table" id="pb-channels-${pId}">
        <table>
          <thead><tr><th>渠道</th><th>笔数</th><th>金额</th><th>占比</th></tr></thead>
          <tbody>`;

    for (const ch of product.channels) {
      const pct = product.revenue > 0 ? (ch.revenue / product.revenue * 100) : 0;
      const barW = Math.max(2, Math.round(ch.revenue / channelMaxRevenue * 60));
      html += `<tr>
        <td>${ch.channel}</td>
        <td>${ch.count.toLocaleString()}</td>
        <td><span class="pb-revenue-bar" style="width:${barW}px"></span>${fmt(ch.revenue)}</td>
        <td>${pct.toFixed(1)}%</td>
      </tr>`;
    }

    html += `</tbody></table></div></div>`;
  }
  return html;
}

function togglePostbackProduct(pId) {
  const table = document.getElementById('pb-channels-' + pId);
  const arrow = document.getElementById('pb-arrow-' + pId);
  if (!table) return;
  const isOpen = table.classList.contains('open');
  table.classList.toggle('open', !isOpen);
  if (arrow) arrow.classList.toggle('open', !isOpen);
}

async function loadPostbackData(sDate, eDate) {
  showLoading();
  try {
    postbackData = await fetchPostbackData(sDate, eDate);
    renderPostback();
  } catch (err) {
    console.error('Failed to load postback data:', err);
    document.getElementById('postback-product-list').innerHTML = '<div class="pb-no-data">加载失败: ' + err.message + '</div>';
  } finally {
    hideLoading();
  }
}

// ===== Postback Personal Panel (API 个人数据) =====
let pbPersonalData = null;

const OPERATOR_LABELS = {
  'syh': '苏屹恒',
  'zm1': '张苗',
  'wcx': '武春香',
  'zmf': '张梦凡',
  'mcy': '马崇岩',
  'lh': '刘欢',
  'ymt': '杨梅亭',
  'dsk': '邓世坤',
  'wty': '吴天越',
  'wvv': '王维维',
  'zjc': '张嘉铖',
  'cy1': '陈祎',
  'test_creative': '🧪 测素材',
  'other': '未匹配',
};

let _pbPersonalAbort = null;

async function fetchPbPersonalData(sDate, eDate, signal) {
  const resp = await fetch(apiUrl(`/api/postback/personal?startDate=${sDate}&endDate=${eDate}`), { signal });
  return resp.json();
}

function renderPbPersonal() {
  const paidRevEl = document.getElementById('pbp-val-paid-revenue');
  const paidNewEl = document.getElementById('pbp-val-paid-new');
  const orgRevEl = document.getElementById('pbp-val-organic-revenue');
  const orgNewEl = document.getElementById('pbp-val-organic-new');
  const restrictedRevEl = document.getElementById('pbp-val-restricted-revenue');
  const listEl = document.getElementById('pb-personal-list');
  const costEl = document.getElementById('pbp-val-paid-cost');

  if (!pbPersonalData || (!pbPersonalData.operators || pbPersonalData.operators.length === 0)) {
    if (costEl) costEl.textContent = '--';
    paidRevEl.textContent = '--';
    paidNewEl.textContent = '--';
    orgRevEl.textContent = pbPersonalData && pbPersonalData.organic ? fmt(pbPersonalData.organic.revenue) : '--';
    orgNewEl.textContent = pbPersonalData && pbPersonalData.organic ? fmt(pbPersonalData.organic.newUserRevenue) : '--';
    if (restrictedRevEl) restrictedRevEl.textContent = pbPersonalData && pbPersonalData.restricted ? fmt(pbPersonalData.restricted.revenue) : '--';
    listEl.innerHTML = '<div class="pb-no-data">该日暂无付费渠道数据</div>';
    return;
  }

  const totalPaidCost = pbPersonalData.operators.reduce((s, o) => s + (o.cost || 0), 0);
  const totalPaidRev = pbPersonalData.operators.reduce((s, o) => s + o.revenue, 0);
  const totalPaidNew = pbPersonalData.operators.reduce((s, o) => s + o.newUserRevenue, 0);
  if (costEl) costEl.textContent = fmt(totalPaidCost);
  paidRevEl.textContent = fmt(totalPaidRev);
  paidNewEl.textContent = fmt(totalPaidNew);
  orgRevEl.textContent = fmt(pbPersonalData.organic.revenue);
  orgNewEl.textContent = fmt(pbPersonalData.organic.newUserRevenue);
  if (restrictedRevEl) restrictedRevEl.textContent = fmt(pbPersonalData.restricted ? pbPersonalData.restricted.revenue : 0);

  // ── Lazy render: only operator headers + product + channel rows ──
  let html = '';
  for (const op of pbPersonalData.operators) {
    const opId = 'pbp-op-' + op.operator;
    const label = OPERATOR_LABELS[op.operator] || op.operator;
    const hasCost = op.cost != null && op.cost > 0;
    let opRev = 0, opNewRev = 0;
    for (const p of op.products) {
      for (const c of p.channels) {
        opRev += applyCorrection(c.revenue, p.product, c.channel, c.correctedRevenue);
        opNewRev += applyCorrection(c.newUserRevenue, p.product, c.channel, c.correctedNewUserRevenue);
      }
    }
    const opRoas = hasCost ? fmtPct(opNewRev / op.cost * 100) : '0%';
    const opRoasColor = hasCost ? (opNewRev / op.cost >= 1 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)';

    // eLTV ROAS: cost-weighted average across all product×channel (per-channel multipliers)
    let eltvWeightedSum = 0, eltvWeightedCost = 0;
    for (const p of op.products) {
      for (const c of p.channels) {
        const m = getEltvMultiplier(p.product, c.channel);
        if (!m) continue;
        const cCost = c.cost || 0;
        if (cCost <= 0) continue;
        const cNewRev = applyCorrection(c.newUserRevenue, p.product, c.channel, c.correctedNewUserRevenue);
        const chEltvRoas = (cNewRev / cCost) * m;
        eltvWeightedSum += chEltvRoas * cCost;
        eltvWeightedCost += cCost;
      }
    }
    const opEltvRoas = eltvWeightedCost > 0 ? eltvWeightedSum / eltvWeightedCost : 0;
    const opEltvRoasStr = eltvWeightedCost > 0 ? fmtPct(opEltvRoas * 100) : '-';
    const opEltvColor = eltvWeightedCost > 0 ? (opEltvRoas >= 1 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)';

    html += `<div class="pb-product-card">
      <div class="pb-product-header" onclick="togglePbpOperator('${opId}')">
        <span class="pb-product-name">${label} <span style="color:var(--text-muted);font-size:0.8rem;font-weight:400;">(${op.operator})</span> <button class="ai-advice-btn rbi-btn" data-rbi-level="operator" data-op="${op.operator}" onclick="event.stopPropagation(); openRevenueByInstall(this)" title="\u6536\u5165\u6765\u6e90\uff08\u6309\u5b89\u88c5\u65e5\u671f\uff09">\ud83d\udcc8</button></span>
        <div class="pb-product-stats">
          ${hasCost ? `<span class="pb-stat"><span class="pb-stat-value" style="color:var(--yellow)">${fmt(op.cost)}</span><span class="pb-stat-label">消耗</span></span>` : ''}
          <span class="pb-stat"><span class="pb-stat-value">${fmt(opRev)}</span><span class="pb-stat-label">总收入</span></span>
          <span class="pb-stat"><span class="pb-stat-value" style="color:var(--green)">${fmt(opNewRev)}</span><span class="pb-stat-label">新用户</span></span>
          <span class="pb-stat"><span class="pb-stat-value" style="color:${opRoasColor}">${opRoas}</span><span class="pb-stat-label">新ROAS</span></span>
          <span class="pb-stat"><span class="pb-stat-value" style="color:${opEltvColor}">${opEltvRoasStr}</span><span class="pb-stat-label">eLTV</span></span>
          <span class="pb-expand-arrow" id="arrow-${opId}">▾</span>
        </div>
      </div>
      <div class="pb-channel-table" id="table-${opId}">`;

    for (const prod of op.products) {
      html += `<div class="pb-product-group">
        <div class="pb-product-group-title">${prod.product} <button class="ai-advice-btn rbi-btn" data-rbi-level="product" data-prod="${prod.product}" data-op="${op.operator}" onclick="event.stopPropagation(); openRevenueByInstall(this)" title="收入来源（按安装日期）">📈</button></div>
        <table class="pbp-detail-table">
          <thead><tr><th class="col-channel">渠道</th><th class="col-num">消耗</th><th class="col-num">CPM</th><th class="col-num">CPC</th><th class="col-num">CPI</th><th class="col-num">总收入</th><th class="col-num">新用户收入</th><th class="col-num">新用户ROAS</th><th class="col-num">eLTV ROAS</th></tr></thead>
          <tbody>`;
      for (const ch of prod.channels) {
        const eltvM = getEltvMultiplier(prod.product, ch.channel);
        const eltvConf = getEltvConfidence(prod.product, ch.channel);
        const confTag = eltvConf ? ` <span style="font-size:0.7rem;color:${eltvConf.color}">(${eltvConf.label})</span>` : '';
        const chCost = ch.cost != null && ch.cost > 0 ? fmt(ch.cost) : '-';
        const chCpm = ch.cpm != null && ch.cpm > 0 ? fmt(ch.cpm) : '-';
        const chCpc = ch.cpc != null && ch.cpc > 0 ? fmt(ch.cpc) : '-';
        const chInstalls = (ch.campaigns || []).reduce((s, c) => s + (c.installs || 0), 0);
        const chCpi = ch.cost > 0 && chInstalls > 0 ? '$' + (ch.cost / chInstalls).toFixed(2) : '-';
        const chRev = applyCorrection(ch.revenue, prod.product, ch.channel, ch.correctedRevenue);
        const chNewRev = applyCorrection(ch.newUserRevenue, prod.product, ch.channel, ch.correctedNewUserRevenue);
        const chRoas = ch.cost > 0 ? fmtPct(chNewRev / ch.cost * 100) : '0%';
        const roasColor = ch.cost > 0 ? (chNewRev / ch.cost >= 1 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)';
        const chEltvRoas = (eltvM && ch.cost > 0) ? fmtPct(chNewRev / ch.cost * 100 * eltvM) : '-';
        const eltvRoasColor = (eltvM && ch.cost > 0) ? (chNewRev / ch.cost * eltvM >= 1 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)';
        const hasCampaigns = ch.campaigns && ch.campaigns.length > 0;
        const chRowId = `pbp-ch-${opId}-${prod.product}-${ch.channel}`.replace(/[^a-zA-Z0-9-]/g, '_');
        html += `<tr class="${hasCampaigns ? 'pbp-ch-expandable' : ''}" ${hasCampaigns ? `onclick="togglePbpChannel('${chRowId}')"` : ''}>
          <td class="col-channel">${ch.channel}${hasCampaigns ? ` <span class="pb-expand-arrow" id="arrow-${chRowId}" style="font-size:0.75rem">▾</span>` : ''} <button class="ai-advice-btn rbi-btn" data-rbi-level="channel" data-prod="${prod.product}" data-ch="${ch.channel}" data-op="${op.operator}" onclick="event.stopPropagation(); openRevenueByInstall(this)" title="收入来源（按安装日期）">📈</button></td>
          <td class="col-num" style="color:var(--yellow)">${chCost}</td>
          <td class="col-num">${chCpm}</td>
          <td class="col-num">${chCpc}</td>
          <td class="col-num">${chCpi}</td>
          <td class="col-num">${fmt(chRev)}</td>
          <td class="col-num" style="color:var(--green)">${fmt(chNewRev)}</td>
          <td class="col-num" style="color:${roasColor}">${chRoas}</td>
          <td class="col-num" style="color:${eltvRoasColor}">${chEltvRoas}${confTag}</td>
        </tr>`;
        // Lazy: only insert a placeholder row for campaigns; content rendered on expand
        if (hasCampaigns) {
          html += `<tr class="pbp-camp-rows" id="${chRowId}" style="display:none" data-lazy="channel" data-op="${op.operator}" data-prod="${prod.product}" data-ch="${ch.channel}"><td colspan="9" style="padding:0"></td></tr>`;
        }
      }
      html += `</tbody></table></div>`;
    }
    html += `</div></div>`;
  }
  listEl.innerHTML = html;
}

// ── Lazy rendering helpers ──

function _renderCampaignRows(op, prodName, chName) {
  const opData = pbPersonalData.operators.find(o => o.operator === op);
  if (!opData) return '';
  const prod = opData.products.find(p => p.product === prodName);
  if (!prod) return '';
  const ch = prod.channels.find(c => c.channel === chName);
  if (!ch || !ch.campaigns) return '';
  const eltvM = getEltvMultiplier(prodName, chName);
  const eltvConf = getEltvConfidence(prodName, chName);
  const confTag = eltvConf ? ` <span style="font-size:0.7rem;color:${eltvConf.color}">(${eltvConf.label})</span>` : '';
  const opId = 'pbp-op-' + op;
  let html = '<table class="pbp-detail-table pbp-camp-table"><tbody>';
  for (const camp of ch.campaigns) {
    const campCost = camp.cost > 0 ? fmt(camp.cost) : '-';
    const campCpm = camp.impressions > 0 ? '$' + (camp.cost / camp.impressions * 1000).toFixed(2) : '-';
    const campCpc = camp.clicks > 0 ? '$' + (camp.cost / camp.clicks).toFixed(2) : '-';
    const campCpi = camp.cost > 0 && camp.installs > 0 ? '$' + (camp.cost / camp.installs).toFixed(2) : '-';
    const campRev = applyCorrection(camp.revenue, prodName, chName, camp.correctedRevenue);
    const campNewRev = applyCorrection(camp.newUserRevenue, prodName, chName, camp.correctedNewUserRevenue);
    const campRoas = camp.cost > 0 ? fmtPct(campNewRev / camp.cost * 100) : '0%';
    const campRoasColor = camp.cost > 0 ? (campNewRev / camp.cost >= 1 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)';
    const campEltvRoas = (eltvM && camp.cost > 0) ? fmtPct(campNewRev / camp.cost * 100 * eltvM) : '-';
    const campEltvColor = (eltvM && camp.cost > 0) ? (campNewRev / camp.cost * eltvM >= 1 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)';
    const hasAdsets = camp.adsets && camp.adsets.length > 0;
    const campRowId = `pbp-camp-${opId}-${prodName}-${chName}-${camp.campaign}`.replace(/[^a-zA-Z0-9-]/g, '_');
    const aiBtnData = `data-camp="${camp.campaign.replace(/"/g, '&quot;')}" data-prod="${prodName}" data-ch="${chName}" data-op="${op}"`;
    html += `<tr class="${hasAdsets ? 'pbp-ch-expandable' : ''}" ${hasAdsets ? `onclick="togglePbpChannel('${campRowId}')"` : ''}>
      <td class="col-channel pbp-camp-name">${camp.campaign}${hasAdsets ? ` <span class="pb-expand-arrow" id="arrow-${campRowId}" style="font-size:0.75rem">▾</span>` : ''} <button class="ai-advice-btn" ${aiBtnData} onclick="event.stopPropagation(); openAiAdvice(this)" title="AI 投放建议">✨AI</button> <button class="ai-advice-btn rbi-btn" data-rbi-level="campaign" ${aiBtnData} onclick="event.stopPropagation(); openRevenueByInstall(this)" title="收入来源（按安装日期）">📈</button></td>
      <td class="col-num" style="color:var(--yellow)">${campCost}</td>
      <td class="col-num">${campCpm}</td>
      <td class="col-num">${campCpc}</td>
      <td class="col-num">${campCpi}</td>
      <td class="col-num">${campRev > 0 ? fmt(campRev) : '-'}</td>
      <td class="col-num" style="color:var(--green)">${campNewRev > 0 ? fmt(campNewRev) : '-'}</td>
      <td class="col-num" style="color:${campRoasColor}">${camp.cost > 0 || campNewRev > 0 ? campRoas : '-'}</td>
      <td class="col-num" style="color:${campEltvColor}">${campEltvRoas}${confTag}</td>
    </tr>`;
    if (hasAdsets) {
      html += `<tr class="pbp-camp-rows" id="${campRowId}" style="display:none" data-lazy="adset" data-op="${op}" data-prod="${prodName}" data-ch="${chName}" data-camp-idx="${ch.campaigns.indexOf(camp)}"><td colspan="9" style="padding:0"></td></tr>`;
    }
  }
  html += '</tbody></table>';
  return html;
}

function _renderAdsetRows(op, prodName, chName, campIdx) {
  const opData = pbPersonalData.operators.find(o => o.operator === op);
  if (!opData) return '';
  const prod = opData.products.find(p => p.product === prodName);
  if (!prod) return '';
  const ch = prod.channels.find(c => c.channel === chName);
  if (!ch || !ch.campaigns || !ch.campaigns[campIdx]) return '';
  const camp = ch.campaigns[campIdx];
  if (!camp.adsets) return '';
  const opId = 'pbp-op-' + op;
  const campRowId = `pbp-camp-${opId}-${prodName}-${chName}-${camp.campaign}`.replace(/[^a-zA-Z0-9-]/g, '_');
  const eltvM = getEltvMultiplier(prodName, chName);
  const eltvConf = getEltvConfidence(prodName, chName);
  const confTag = eltvConf ? ` <span style="font-size:0.7rem;color:${eltvConf.color}">(${eltvConf.label})</span>` : '';
  let html = '<table class="pbp-detail-table pbp-camp-table pbp-adset-table"><tbody>';
  for (let ai = 0; ai < camp.adsets.length; ai++) {
    const adset = camp.adsets[ai];
    const hasAds = adset.ads && adset.ads.length > 0;
    const adsetRowId = `${campRowId}_${adset.adset}`.replace(/[^a-zA-Z0-9-]/g, '_');
    const adsetRev = applyCorrection(adset.revenue, prodName, chName, adset.correctedRevenue);
    const adsetNewRev = applyCorrection(adset.newUserRevenue, prodName, chName, adset.correctedNewUserRevenue);
    // XMP cost injected at adset level (step: adset-level spend). Old snapshots lack
    // adset.cost/impressions/clicks → these render as '-'.
    const adsetCost = adset.cost > 0 ? fmt(adset.cost) : '-';
    const adsetCpm = adset.impressions > 0 ? '$' + (adset.cost / adset.impressions * 1000).toFixed(2) : '-';
    const adsetCpc = adset.clicks > 0 ? '$' + (adset.cost / adset.clicks).toFixed(2) : '-';
    const adsetRoas = adset.cost > 0 ? fmtPct(adsetNewRev / adset.cost * 100) : '0%';
    const adsetRoasColor = adset.cost > 0 ? (adsetNewRev / adset.cost >= 1 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)';
    const adsetEltvRoas = (eltvM && adset.cost > 0) ? fmtPct(adsetNewRev / adset.cost * 100 * eltvM) : '-';
    const adsetEltvColor = (eltvM && adset.cost > 0) ? (adsetNewRev / adset.cost * eltvM >= 1 ? 'var(--green)' : 'var(--red)') : 'var(--text-dim)';
    html += `<tr class="${hasAds ? 'pbp-ch-expandable' : ''}" ${hasAds ? `onclick="togglePbpChannel('${adsetRowId}')"` : ''}>
      <td class="col-channel pbp-adset-name">${adset.adset}${hasAds ? ` <span class="pb-expand-arrow" id="arrow-${adsetRowId}" style="font-size:0.75rem">▾</span>` : ''}</td>
      <td class="col-num" style="color:var(--yellow)">${adsetCost}</td>
      <td class="col-num">${adsetCpm}</td>
      <td class="col-num">${adsetCpc}</td>
      <td class="col-num">-</td>
      <td class="col-num">${adsetRev > 0 ? fmt(adsetRev) : '-'}</td>
      <td class="col-num" style="color:var(--green)">${adsetNewRev > 0 ? fmt(adsetNewRev) : '-'}</td>
      <td class="col-num" style="color:${adsetRoasColor}">${adset.cost > 0 || adsetNewRev > 0 ? adsetRoas : '-'}</td>
      <td class="col-num" style="color:${adsetEltvColor}">${adsetEltvRoas}${confTag}</td>
    </tr>`;
    if (hasAds) {
      html += `<tr class="pbp-camp-rows" id="${adsetRowId}" style="display:none" data-lazy="ad" data-op="${op}" data-prod="${prodName}" data-ch="${chName}" data-camp-idx="${campIdx}" data-adset-idx="${ai}"><td colspan="9" style="padding:0"></td></tr>`;
    }
  }
  html += '</tbody></table>';
  return html;
}

function _renderAdRows(op, prodName, chName, campIdx, adsetIdx) {
  const opData = pbPersonalData.operators.find(o => o.operator === op);
  if (!opData) return '';
  const prod = opData.products.find(p => p.product === prodName);
  if (!prod) return '';
  const ch = prod.channels.find(c => c.channel === chName);
  if (!ch || !ch.campaigns || !ch.campaigns[campIdx]) return '';
  const camp = ch.campaigns[campIdx];
  if (!camp.adsets || !camp.adsets[adsetIdx]) return '';
  const adset = camp.adsets[adsetIdx];
  if (!adset.ads) return '';
  let html = '<table class="pbp-detail-table pbp-camp-table pbp-ad-table"><tbody>';
  for (const ad of adset.ads) {
    const adRev = applyCorrection(ad.revenue, prodName, chName, ad.correctedRevenue);
    const adNewRev = applyCorrection(ad.newUserRevenue, prodName, chName, ad.correctedNewUserRevenue);
    html += `<tr>
      <td class="col-channel pbp-ad-name">${ad.ad}</td>
      <td class="col-num">-</td><td class="col-num">-</td><td class="col-num">-</td><td class="col-num">-</td>
      <td class="col-num">${adRev > 0 ? fmt(adRev) : '-'}</td>
      <td class="col-num" style="color:var(--green)">${adNewRev > 0 ? fmt(adNewRev) : '-'}</td>
      <td class="col-num">-</td><td class="col-num">-</td>
    </tr>`;
  }
  html += '</tbody></table>';
  return html;
}

function toggleCorrectionMode(enabled) {
  correctionMode = enabled;
  const input = document.getElementById('corr-toggle-input');
  const label = document.getElementById('corr-toggle-label');
  if (input) input.checked = enabled;
  if (label) label.textContent = enabled ? '修正' : '原始';
  renderPbPersonal();
}

// ── AI Advice Modal ──
let _aiAbortCtrl = null;

function openAiAdvice(btn) {
  const campaign = btn.dataset.camp;
  const product = btn.dataset.prod;
  const channel = btn.dataset.ch;
  const operator = btn.dataset.op;
  const date = endDate || '';

  // Update modal header
  document.getElementById('ai-camp-name').textContent = campaign;
  document.getElementById('ai-prod-name').textContent = product;
  document.getElementById('ai-channel-name').textContent = channel;
  document.getElementById('ai-date').textContent = date;

  // Reset modal body
  const statusEl = document.getElementById('ai-status');
  const responseEl = document.getElementById('ai-response');
  const thinkingEl = document.getElementById('ai-thinking');
  const toggleBtn = document.getElementById('ai-toggle-thinking');

  statusEl.className = 'ai-modal-status';
  statusEl.innerHTML = '<div class="ai-spinner"></div><span>\u6b63\u5728\u83b7\u53d6 campaign \u6570\u636e...</span>';
  responseEl.innerHTML = '';
  thinkingEl.textContent = '';
  thinkingEl.classList.remove('show');
  toggleBtn.style.display = 'none';
  const inputSection = document.getElementById('ai-input-section');
  if (inputSection) inputSection.style.display = 'none';
  const inputArea = document.getElementById('ai-input-data');
  if (inputArea) inputArea.value = '';

  // Show modal
  document.getElementById('ai-advice-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';

  // Cancel any previous request
  if (_aiAbortCtrl) _aiAbortCtrl.abort();
  _aiAbortCtrl = new AbortController();

  runAiAdvice(campaign, product, channel, operator, date, _aiAbortCtrl.signal);
}

function closeAiAdvice() {
  document.getElementById('ai-advice-modal').style.display = 'none';
  document.body.style.overflow = '';
  if (_aiAbortCtrl) { _aiAbortCtrl.abort(); _aiAbortCtrl = null; }
}

let _aiThinkingVisible = false;
function toggleAiThinking() {
  _aiThinkingVisible = !_aiThinkingVisible;
  document.getElementById('ai-thinking').classList.toggle('show', _aiThinkingVisible);
  document.getElementById('ai-toggle-thinking').textContent = _aiThinkingVisible ? '\ud83d\udcad \u9690\u85cf\u63a8\u7406\u8fc7\u7a0b' : '\ud83d\udcad \u663e\u793a\u63a8\u7406\u8fc7\u7a0b';
}

// \u2500\u2500 \u6536\u5165\u6765\u6e90\u56fe (revenue-by-install) \u2500\u2500
// Opens the modal, fetches install-date revenue for the clicked level, draws a line chart.
function openRevenueByInstall(btn) {
  const level = btn.dataset.rbiLevel;
  const campaign = btn.dataset.camp || '';
  const product = btn.dataset.prod || '';
  const channel = btn.dataset.ch || '';
  const operator = btn.dataset.op || '';
  const date = endDate || '';

  const levelLabel = { campaign: 'Campaign', channel: '\u6e20\u9053', product: '\u4ea7\u54c1', operator: '\u6295\u624b' }[level] || level;
  let title = '';
  if (level === 'campaign') title = campaign;
  else if (level === 'channel') title = `${product} \u00b7 ${channel}`;
  else if (level === 'product') title = product;
  else if (level === 'operator') title = (OPERATOR_LABELS[operator] || operator);

  document.getElementById('rbi-title').textContent = title;
  document.getElementById('rbi-sub').textContent = `${levelLabel} \u00b7 ${date} \u5f53\u65e5\u4fee\u6b63\u4ed8\u8d39 \u00d7 \u6309\u5b89\u88c5\u65f6\u6bb5`;
  document.getElementById('rbi-total').textContent = '-';

  document.getElementById('rbi-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const statusEl = document.getElementById('rbi-status');
  statusEl.className = 'ai-modal-status';
  statusEl.style.display = 'flex';
  statusEl.innerHTML = '<div class="ai-spinner"></div><span>\u6b63\u5728\u52a0\u8f7d\u6536\u5165\u6765\u6e90\u6570\u636e...</span>';
  const canvas = document.getElementById('rbi-canvas');
  canvas.style.display = 'none';
  if (rbiChart) { rbiChart.destroy(); rbiChart = null; }

  const params = new URLSearchParams({ level, days: '99' });
  if (date) params.set('date', date);
  if (campaign) params.set('campaign', campaign);
  if (product) params.set('product', product);
  if (channel) params.set('channel', channel);
  if (operator) params.set('operator', operator);

  if (_rbiAbort) _rbiAbort.abort();
  _rbiAbort = new AbortController();
  fetch(apiUrl('/api/revenue-by-install?' + params.toString()), { signal: _rbiAbort.signal })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      renderRbiChart(data);
    })
    .catch(err => {
      if (err.name === 'AbortError') return;
      statusEl.className = 'ai-modal-status error';
      statusEl.innerHTML = '<span>\u52a0\u8f7d\u5931\u8d25\uff1a' + (err.message || err) + '</span>';
    });
}

function closeRevenueByInstall() {
  document.getElementById('rbi-modal').style.display = 'none';
  document.body.style.overflow = '';
  if (_rbiAbort) { _rbiAbort.abort(); _rbiAbort = null; }
  if (rbiChart) { rbiChart.destroy(); rbiChart = null; }
}

function renderRbiChart(data) {
  const statusEl = document.getElementById('rbi-status');
  const canvas = document.getElementById('rbi-canvas');
  const series = data.series || [];
  const D = data.date;

  // \u2500\u2500 Aggregate the per-day series into 11 install-age buckets \u2500\u2500
  // Order is left\u2192right = older install \u2192 newer install (left=\u8001\u7528\u6237, right=\u65b0\u7528\u6237).
  const buckets = [
    { label: '\u66f4\u65e9',      min: 99,  max: Infinity },
    { label: '85-98\u5929\u524d', min: 85,  max: 98 },
    { label: '71-84\u5929\u524d', min: 71,  max: 84 },
    { label: '57-70\u5929\u524d', min: 57,  max: 70 },
    { label: '43-56\u5929\u524d', min: 43,  max: 56 },
    { label: '29-42\u5929\u524d', min: 29,  max: 42 },
    { label: '15-28\u5929\u524d', min: 15,  max: 28 },
    { label: '8-14\u5929\u524d',  min: 8,   max: 14 },
    { label: '4-7\u5929\u524d',   min: 4,   max: 7 },
    { label: '\u8fc7\u53bb3\u5929',   min: 1,   max: 3 },
    { label: '\u5f53\u5929',      min: 0,   max: 0 },
  ];
  const daysAgo = ds => Math.round((Date.parse(D + 'T00:00:00Z') - Date.parse(ds + 'T00:00:00Z')) / 86400000);
  const bucketVals = buckets.map(() => 0);
  for (const p of series) {
    const da = daysAgo(p.date);
    for (let i = 0; i < buckets.length; i++) {
      if (da >= buckets[i].min && da <= buckets[i].max) { bucketVals[i] += (p.revenue || 0); break; }
    }
  }
  // installs earlier than the axis window \u2192 leftmost "\u66f4\u65e9" bucket
  bucketVals[0] += (data.earlierRevenue || 0);

  const labels = buckets.map(b => b.label);
  const values = bucketVals.map(v => Math.round(v * 100) / 100);
  const total = values.reduce((s, v) => s + (v || 0), 0);

  statusEl.style.display = 'none';
  canvas.style.display = 'block';
  document.getElementById('rbi-total').textContent = '\u533a\u95f4\u603b\u4fee\u6b63\u4ed8\u8d39 ' + fmt(total);

  const ctx = canvas.getContext('2d');
  if (rbiChart) { rbiChart.destroy(); }
  rbiChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '\u5f53\u65e5\u4fee\u6b63\u4ed8\u8d39\uff08\u6309\u5b89\u88c5\u65f6\u6bb5\uff09',
        data: values,
        borderColor: '#00d4ff',
        backgroundColor: 'rgba(0,212,255,0.12)',
        borderWidth: 2, tension: 0.15, fill: true,
        pointRadius: 3, pointHoverRadius: 6,
        pointBackgroundColor: '#00d4ff', spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8888aa', font: { size: 12 } } },
        tooltip: {
          callbacks: {
            title: items => items.length ? '\u5b89\u88c5\u65f6\u6bb5: ' + (labels[items[0].dataIndex] || '') : '',
            label: c => '\u4fee\u6b63\u4ed8\u8d39: ' + fmt(c.raw),
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#555577', font: { size: 10 }, maxRotation: 0, autoSkip: false },
          grid: { color: 'rgba(255,255,255,0.04)' },
          title: { display: true, text: '\u2190 \u8001\u7528\u6237(\u65e9\u5b89\u88c5)        \u5b89\u88c5\u65f6\u6bb5        \u65b0\u7528\u6237(\u8fd1\u5b89\u88c5) \u2192', color: '#555577' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#555577', font: { size: 11 }, callback: v => '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0)) },
          grid: { color: 'rgba(255,255,255,0.06)' },
        },
      },
    },
  });
}

async function runAiAdvice(campaign, product, channel, operator, date, signal) {
  const statusEl = document.getElementById('ai-status');
  const responseEl = document.getElementById('ai-response');
  const thinkingEl = document.getElementById('ai-thinking');
  const toggleBtn = document.getElementById('ai-toggle-thinking');

  try {
    // Step 1: Fetch campaign data context
    const ctxUrl = apiUrl(`/api/campaign-context?campaign=${encodeURIComponent(campaign)}&product=${encodeURIComponent(product)}&channel=${encodeURIComponent(channel)}&operator=${encodeURIComponent(operator)}&date=${encodeURIComponent(date)}`);
    const ctxRes = await fetch(ctxUrl, { signal });
    if (!ctxRes.ok) throw new Error(`\u6570\u636e\u83b7\u53d6\u5931\u8d25: ${ctxRes.status}`);
    const campData = await ctxRes.json();

    // Show structured input data in textarea (with aligned columns)
    if (campData.structuredInput) {
      const inputSection = document.getElementById('ai-input-section');
      const inputArea = document.getElementById('ai-input-data');
      if (inputSection && inputArea) {
        const si = campData.structuredInput;
        const confTag = c => c === 'green' ? '🟢可信' : c === 'yellow' ? '🟡供参考' : '🔴不可信';
        const f3 = v => { const s = String(v); const dot = s.indexOf('.'); return dot < 0 ? s : s.slice(0, dot + 4); };
        // History table: no 可信度/回本ROAS (same every day), date without year
        const headers = ['日期', '消耗', 'CPM', 'CPC', 'CPI', '新用户收入', '修正后收入', '修正系数', '新用户ROAS', 'eLTV_ROAS'];
        const rows = si.historyDays.map(d => [
          d.date.slice(5), `$${f3(d.cost)}`, `$${f3(d.cpm)}`, `$${f3(d.cpc)}`, `$${f3(d.cpi)}`,
          `$${f3(d.newUserRevenue)}`, `$${f3(d.correctedNewUserRevenue)}`, `${f3(d.correctionFactor)}`,
          `${(d.newUserROAS*100).toFixed(1)}%`, `${(d.newUserEltvROAS*100).toFixed(1)}%`,
        ]);
        // Column width: CJK chars ~1.5 monospace width; include header in width calc
        const dw = s => { let w = 0; for (const ch of String(s)) w += ch.charCodeAt(0) > 0x7F ? 1.6 : 1; return Math.ceil(w); };
        const pad = (s, width) => s + ' '.repeat(Math.max(0, width - dw(s)));
        const colW = headers.map((h, i) => Math.max(dw(h), ...rows.map(r => dw(r[i]))));
        const fmtRow = cells => '| ' + cells.map((c, i) => pad(c, colW[i])).join(' | ') + ' |';
        const sepRow = '|' + colW.map(w => '-'.repeat(w + 2)).join('|') + '|';

        let text = `Campaign: ${si.campaign}\nProduct: ${si.product}\nChannel: ${si.channel}\n\n`;
        text += `=== 过去7天每日数据 ===\n`;
        text += fmtRow(headers) + '\n';
        text += sepRow + '\n';
        for (const r of rows) text += fmtRow(r) + '\n';
        text += `\n=== 今天实时数据 (截至 ${si.realtime.snapshotTime || '?'}) ===\n`;
        const rt = si.realtime;
        text += `日期: ${rt.date}\n`;
        text += `消耗: $${f3(rt.cost)}\n`;
        text += `CPM: $${f3(rt.cpm)}\n`;
        text += `CPC: $${f3(rt.cpc)}\n`;
        text += `CPI: $${f3(rt.cpi)}\n`;
        text += `新用户收入: $${f3(rt.newUserRevenue)}\n`;
        text += `修正后收入: $${f3(rt.correctedNewUserRevenue)}\n`;
        text += `修正系数: ${f3(rt.correctionFactor)}\n`;
        text += `新用户ROAS: ${(rt.newUserROAS*100).toFixed(1)}%\n`;
        text += `eLTV D180: ${rt.eltvD180 || 'N/A'}\n`;
        text += `eLTV ROAS: ${(rt.newUserEltvROAS*100).toFixed(1)}% ${confTag(rt.eltvConfidence)}\n`;
        if (rt.breakevenROAS != null) text += `回本ROAS: ${rt.breakevenROAS}%${rt.eltvConfidence === 'yellow' ? '（已含5%风险调整）' : ''}\n`;
        inputArea.value = text;
        inputSection.style.display = 'block';
      }
    }

    // Step 2: Call LLM (non-streaming to avoid browser lag from thousands of SSE chunks)
    statusEl.innerHTML = '<div class="ai-spinner"></div><span>AI 正在生成建议，请耐心等待（约30-60秒）...</span>';

    const llmRes = await fetch(apiUrl('/api/llm/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: campData.messages,
        stream: false,
        temperature: 0.7,
        max_tokens: 4096,
      }),
      signal,
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text().catch(() => '');
      throw new Error(`LLM 调用失败: ${llmRes.status} ${errText.substring(0, 100)}`);
    }

    const llmData = await llmRes.json();
    const choice = llmData.choices?.[0];
    if (!choice) throw new Error('LLM 返回为空');

    // Show reasoning if present
    const reasoning = choice.message?.reasoning_content;
    if (reasoning) {
      thinkingEl.textContent = reasoning;
      toggleBtn.style.display = 'inline-block';
    }

    // Show content
    const content = choice.message?.content || '';
    responseEl.textContent = content;

    statusEl.className = 'ai-modal-status done';
    statusEl.innerHTML = '\u2705 \u5efa\u8bae\u751f\u6210\u5b8c\u6bd5';

  } catch (err) {
    if (err.name === 'AbortError') return;
    statusEl.className = 'ai-modal-status error';
    statusEl.innerHTML = `\u274c ${err.message}`;
  }
}

function togglePbpChannel(rowId) {
  const row = document.getElementById(rowId);
  const arrow = document.getElementById('arrow-' + rowId);
  if (!row) return;
  const isOpen = row.style.display !== 'none';
  if (!isOpen) {
    // Lazy render: populate content on first expand
    const td = row.querySelector('td');
    const lazy = row.dataset.lazy;
    if (lazy && td && !td.innerHTML) {
      const op = row.dataset.op;
      const prod = row.dataset.prod;
      const ch = row.dataset.ch;
      if (lazy === 'channel') {
        td.innerHTML = _renderCampaignRows(op, prod, ch);
      } else if (lazy === 'adset') {
        td.innerHTML = _renderAdsetRows(op, prod, ch, parseInt(row.dataset.campIdx));
      } else if (lazy === 'ad') {
        td.innerHTML = _renderAdRows(op, prod, ch, parseInt(row.dataset.campIdx), parseInt(row.dataset.adsetIdx));
      }
    }
  }
  row.style.display = isOpen ? 'none' : '';
  if (arrow) arrow.classList.toggle('open', !isOpen);
}

function togglePbpOperator(opId) {
  const table = document.getElementById('table-' + opId);
  const arrow = document.getElementById('arrow-' + opId);
  if (!table) return;
  const isOpen = table.classList.contains('open');
  table.classList.toggle('open', !isOpen);
  if (arrow) arrow.classList.toggle('open', !isOpen);
}

async function loadPbPersonalData(sDate, eDate) {
  // Cancel any in-flight personal panel request
  if (_pbPersonalAbort) { _pbPersonalAbort.abort(); }
  const ctrl = new AbortController();
  _pbPersonalAbort = ctrl;
  const signal = ctrl.signal;
  showLoading();
  try {
    [pbPersonalData] = await Promise.all([
      fetchPbPersonalData(sDate, eDate, signal),
      fetchCorrectionFactors(sDate, eDate, signal),
      fetchEltvMultipliers(eDate, signal),
    ]);
    if (signal.aborted) return;
    renderPbPersonal();
  } catch (err) {
    if (err.name === 'AbortError' || signal.aborted) return; // cancelled, don't touch loading
    console.error('Failed to load pb personal data:', err);
    document.getElementById('pb-personal-list').innerHTML = '<div class="pb-no-data">加载失败: ' + err.message + '</div>';
    hideLoading();
    return;
  }
  hideLoading();
}

function switchPanel(panel) {
  currentPanel = panel;
  resetLoading(); // Clear any pending loading state from previous panel
  document.getElementById('panel-summary').style.display = panel === 'summary' ? '' : 'none';
  document.getElementById('panel-postback').style.display = panel === 'postback' ? '' : 'none';
  document.getElementById('panel-pb-personal').style.display = panel === 'pb-personal' ? '' : 'none';
  const creativePanel = document.getElementById('panel-creative');
  if (creativePanel) creativePanel.style.display = panel === 'creative' ? '' : 'none';
  const aigcPanel = document.getElementById('panel-aigc');
  if (aigcPanel) aigcPanel.style.display = panel === 'aigc' ? '' : 'none';
  // Show correction toggle only in personal panel
  const corrWrap = document.getElementById('corr-toggle-wrap');
  if (corrWrap) corrWrap.style.display = panel === 'pb-personal' ? '' : 'none';
  const topBarRight = document.querySelector('.top-bar-right');
  if (topBarRight) topBarRight.style.display = '';
  updateStatusBarVisibility();

  const trigger = document.getElementById('panel-selector-trigger');
  const pbPersonalEntry = document.getElementById('pb-personal-entry');
  const creativeEntry = document.getElementById('creative-panel-entry');
  const aigcEntry = document.getElementById('aigc-panel-entry');
  const postbackEntry = document.getElementById('postback-panel-entry');
  const backFromPostback = document.getElementById('back-from-postback');

  // Highlight active panel tab
  if (trigger) trigger.classList.toggle('active-panel', panel === 'summary');
  if (pbPersonalEntry) pbPersonalEntry.classList.toggle('active-panel', panel === 'pb-personal');
  if (creativeEntry) creativeEntry.classList.toggle('active-panel', panel === 'creative');
  if (aigcEntry) aigcEntry.classList.toggle('active-panel', panel === 'aigc');

  if (postbackEntry) postbackEntry.style.display = 'none';
  if (backFromPostback) backFromPostback.style.display = panel === 'postback' ? 'inline-flex' : 'none';

  if (personalPanelRevealTimer) {
    clearTimeout(personalPanelRevealTimer);
    personalPanelRevealTimer = null;
  }

  if (panel === 'summary') render();
  else if (panel === 'postback') loadPostbackData(startDate, endDate);
  else if (panel === 'pb-personal') loadPbPersonalData(startDate, endDate);
  else if (panel === 'creative') loadCreativeData();
  else if (panel === 'aigc') loadAigcData();
}

function setupSort() {
  document.querySelectorAll('#product-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (sortField === field) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortField = field; sortDir = field === 'product' ? 'asc' : 'desc'; }
      document.querySelectorAll('#product-table th.sortable').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      render();
    });
  });

  document.querySelectorAll('#personal-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (personalSortField === field) personalSortDir = personalSortDir === 'asc' ? 'desc' : 'asc';
      else { personalSortField = field; personalSortDir = field === 'name' ? 'asc' : 'desc'; }
      document.querySelectorAll('#personal-table th.sortable').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(personalSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      renderPersonal();
    });
  });
}

function prevDateStr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function loadData(sDate, eDate) {
  showLoading();
  try {
    const isRange = sDate !== eDate;

    // Summary panel: fetch core data first, channel summary independently (may be slow for large ranges)
    const channelPromise = fetchChannelSummary(sDate, eDate).catch(e => {
      console.warn('[loadData] channel-summary failed or timed out:', e);
      return null;
    });

    const [current, afData] = await Promise.all([
      fetchData(sDate, eDate),
      fetchAfSummary(sDate, eDate),
    ]);

    dayData = current;
    afSummaryData = afData;
    channelSummaryData = null; // Will be set when channelPromise resolves

    if (isRange) {
      // Multi-day mode: no yesterday comparison
      prevDayData = null;
      prevAfSummaryData = null;
      personalDayData = null;
      personalPrevDayData = null;
    } else {
      // Single-day mode: keep original logic
      const prevDate = prevDateStr(sDate);
      const [prev, personal, personalPrev, prevAfData] = await Promise.all([
        fetchData(prevDate, prevDate),
        fetchPersonalData(sDate),
        fetchPersonalData(prevDate),
        fetchAfSummary(prevDate, prevDate),
      ]);
      prevDayData = prev;
      personalDayData = personal;
      personalPrevDayData = personalPrev;
      prevAfSummaryData = prevAfData;
    }

    if (currentPanel === 'summary') render();
    else renderPersonal();

    // Channel summary loads independently — render it when ready
    channelPromise.then(chData => {
      channelSummaryData = chData;
      if (currentPanel === 'summary') renderChannelSummary();
    });
  } catch (err) {
    console.error('Failed to load data:', err);
  } finally {
    hideLoading();
  }
}

async function handleSummaryRefresh() {
  showLoading();
  const btn = document.getElementById('btn-refresh-summary');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    await triggerRefresh();
    startSummaryStatusPoll();
  } catch (err) {
    console.error('Summary refresh failed:', err);
    btn.disabled = false;
    btn.classList.remove('spinning');
    hideLoading();
  }
}

async function handlePersonalRefresh() {
  showLoading();
  const btn = document.getElementById('btn-refresh-personal');
  btn.disabled = true;
  btn.classList.add('spinning');
  try {
    await triggerPersonalRefresh();
    startPersonalStatusPoll();
  } catch (err) {
    console.error('Personal refresh failed:', err);
    btn.disabled = false;
    btn.classList.remove('spinning');
    hideLoading();
  }
}

function startSummaryStatusPoll() {
  if (summaryStatusPollTimer) clearInterval(summaryStatusPollTimer);
  summaryStatusPollTimer = setInterval(async () => {
    const status = await fetchStatus();
    await updateStatus();
    if (!status.isFetching) {
      clearInterval(summaryStatusPollTimer);
      summaryStatusPollTimer = null;
      hideLoading();
      if (startDate === todayStr() && endDate === todayStr()) await loadData(startDate, endDate);
    }
  }, 3000);
}

function startPersonalStatusPoll() {
  if (personalStatusPollTimer) clearInterval(personalStatusPollTimer);
  personalStatusPollTimer = setInterval(async () => {
    const status = await fetchPersonalStatus();
    await updatePersonalStatus();
    if (!status.isFetching) {
      clearInterval(personalStatusPollTimer);
      personalStatusPollTimer = null;
      hideLoading();
      if (startDate === todayStr() && endDate === todayStr()) await loadData(startDate, endDate);
    }
  }, 3000);
}

// ═══════════════════════════════════════════════════════
// Creative Panel
// ═══════════════════════════════════════════════════════

let creativeData = null; // { days, dates, dateRange, missingDates, fb: [], tt: [] }
let creativeFbPage = 1;
let creativeTtPage = 1;
const CREATIVE_PAGE_SIZE = 20;
let creativeFbSort = { field: 'newUserRevenue', dir: 'desc' };
let creativeTtSort = { field: 'newUserRevenue', dir: 'desc' };

let creativeWindow = 3; // time window in days: 3 | 7 | 14
let creativeCorrectionMode = false; // false=原始收入, true=修正收入

// Reuse-target products for the creative panel. Superset of AIGC_PRODUCTS with
// Dora, which appears in old-convention creatives but not the AIGC product set.
const CREATIVE_PRODUCTS = ['Dora', 'Doni', 'GraceChat', 'Jovia', 'Kira', 'Luma', 'Nalo', 'Romi', 'Vika'];

// Filters mirror the AIGC panel. Convention fields are derived from the display
// name via parseAigcName(); old-convention creatives simply resolve to empty
// (treated as "no value") for owner/form/type/creative.
let creativeFilters = { owner: '', product: '', form: '', type: '', creative: '', date: '' };
let creativeNumFilter = { metric: 'newUserRevenue', op: 'gte', value: null };

async function loadCreativeData() {
  showLoading();
  const statusEl = document.getElementById('creative-status-info');
  if (statusEl) statusEl.innerHTML = '<span class="status-dot busy"></span> 素材数据：加载中...';

  try {
    const resp = await fetch(`/api/creative/data?days=${creativeWindow}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    creativeData = await resp.json();

    // Update summary cards (raw totals, correction-independent)
    const fbTotal = creativeData.fb || [];
    const ttTotal = creativeData.tt || [];

    document.getElementById('creative-fb-count').textContent = fbTotal.length;
    document.getElementById('creative-fb-cost').textContent = '$' + fbTotal.reduce((s,c) => s + c.cost, 0).toFixed(0);
    document.getElementById('creative-fb-revenue').textContent = '$' + fbTotal.reduce((s,c) => s + c.newUserRevenue, 0).toFixed(0);
    document.getElementById('creative-tt-count').textContent = ttTotal.length;
    document.getElementById('creative-tt-cost').textContent = '$' + ttTotal.reduce((s,c) => s + c.cost, 0).toFixed(0);
    document.getElementById('creative-tt-revenue').textContent = '$' + ttTotal.reduce((s,c) => s + c.newUserRevenue, 0).toFixed(0);

    const rangeEl = document.getElementById('creative-date-range');
    if (rangeEl) {
      const miss = (creativeData.missingDates && creativeData.missingDates.length)
        ? ` ⚠️ 缺 ${creativeData.missingDates.length} 天` : '';
      rangeEl.textContent = `素材排名（${creativeData.dateRange}）${miss}`;
    }

    if (statusEl) statusEl.innerHTML = '<span class="status-dot ok"></span> 素材数据：已加载';
    const datesEl = document.getElementById('creative-status-dates');
    if (datesEl) datesEl.textContent = `数据范围：${creativeData.dateRange}`;

    populateCreativeFilterOptions();

    // Reset pages
    creativeFbPage = 1;
    creativeTtPage = 1;

    renderCreativeTable('fb');
    renderCreativeTable('tt');

    // 修正系数并行后台拉取，不阻塞首屏（素材数据上面已渲染）。
    // 拉到后仅当修正开关打开(默认关)时才重渲染套用系数；开关关着则拉到即存，无需重渲染。
    fetchAigcCorrectionFactors().then(() => {
      if (creativeCorrectionMode) {
        renderCreativeTable('fb');
        renderCreativeTable('tt');
      }
    });
  } catch (err) {
    console.error('Failed to load creative data:', err);
    if (statusEl) statusEl.innerHTML = '<span class="status-dot error"></span> 素材数据：加载失败 - ' + err.message;
  } finally {
    hideLoading();
  }
}

// Creative metrics with optional correction applied to newUserRevenue (and ROAS
// recomputed). Reuses the AIGC correction factor resolver (keyed by base product
// + channel; AIGC_FACTOR_PRODUCT already includes Dora).
function computeCreativeMetrics(c) {
  let rev = c.newUserRevenue || 0;
  if (creativeCorrectionMode) rev = rev * getAigcCorrectionFactor(c.product, c.channel);
  return {
    ...c,
    newUserRevenue: rev,
    cpm: c.impressions > 0 ? (c.cost / c.impressions * 1000) : 0,
    cpc: c.clicks > 0 ? (c.cost / c.clicks) : 0,
    ctr: c.impressions > 0 ? (c.clicks / c.impressions * 100) : 0,
    roas: c.cost > 0 ? (rev / c.cost) : 0,
  };
}

function toggleCreativeCorrectionMode(enabled) {
  creativeCorrectionMode = enabled;
  const input = document.getElementById('creative-corr-toggle-input');
  const label = document.getElementById('creative-corr-toggle-label');
  if (input) input.checked = enabled;
  if (label) label.textContent = enabled ? '修正' : '原始';
  renderCreativeTable('fb');
  renderCreativeTable('tt');
}

function setCreativeWindow(days) {
  if (creativeWindow === days) return;
  creativeWindow = days;
  document.querySelectorAll('.creative-window-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.days, 10) === days);
  });
  creativeFbPage = 1;
  creativeTtPage = 1;
  loadCreativeData();
}

function sortCreatives(list, sortObj) {
  return list.sort((a, b) => {
    if (sortObj.field === 'name' || sortObj.field === 'product') {
      const av = a[sortObj.field] || '', bv = b[sortObj.field] || '';
      return sortObj.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    const am = computeCreativeMetrics(a);
    const bm = computeCreativeMetrics(b);
    return sortObj.dir === 'asc' ? am[sortObj.field] - bm[sortObj.field] : bm[sortObj.field] - am[sortObj.field];
  });
}

// ── 跨产品复用（creative）：与 AIGC 一致，但产品集合含 Dora（老素材）──
// 素材名按 '_' 分段，产品是其中一段。打包名（' | ' 拼接）逐个子名替换。
function replaceCreativeProduct(name, targetProduct) {
  if (!name || !targetProduct) return name;
  const replaceOne = (sub) => {
    const segs = sub.split('_');
    let replaced = false;
    for (let i = 0; i < segs.length; i++) {
      if (CREATIVE_PRODUCTS.includes(segs[i])) {
        segs[i] = targetProduct;
        replaced = true;
      }
    }
    if (!replaced) {
      for (const p of CREATIVE_PRODUCTS) {
        if (sub.includes(p)) return sub.split(p).join(targetProduct);
      }
    }
    return segs.join('_');
  };
  return name.split(' | ').map(replaceOne).join(' | ');
}

// 复制按钮点击：把行素材名的产品字段改成下拉选中的目标产品后写入剪贴板。
function creativeCopyReused(btn, encodedName) {
  const sel = btn.parentElement.querySelector('.aigc-reuse-select');
  const target = sel ? sel.value : '';
  if (!target) { sel && sel.focus(); return; }
  const original = decodeURIComponent(encodedName);
  const newName = replaceCreativeProduct(original, target);
  const done = () => {
    const old = btn.textContent;
    btn.textContent = '✓ 已复制';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(newName).then(done).catch(() => aigcCopyFallback(newName, done));
  } else {
    aigcCopyFallback(newName, done);
  }
}

// Keep rows whose parsed fields contain ALL selected filter values. Product uses
// the authoritative row product first, then falls back to name-parsed products.
function applyCreativeFilters(data) {
  const f = creativeFilters;
  const nf = creativeNumFilter;
  const hasNum = nf && nf.value != null && !Number.isNaN(nf.value);
  if (!f.owner && !f.product && !f.form && !f.type && !f.creative && !f.date && !hasNum) return data;
  return data.filter(c => {
    const p = parseAigcName(c.name || '');
    if (f.owner && !p.owners.includes(f.owner)) return false;
    if (f.product && c.product !== f.product && !p.products.includes(f.product)) return false;
    if (f.form && !p.forms.includes(f.form)) return false;
    if (f.type && !p.types.includes(f.type)) return false;
    if (f.creative && !p.creatives.includes(f.creative)) return false;
    if (f.date && !p.dates.includes(f.date)) return false;
    if (hasNum) {
      const m = computeCreativeMetrics(c);
      const actual = m[nf.metric];
      if (actual == null || !aigcNumCompare(actual, nf.op, nf.value)) return false;
    }
    return true;
  });
}

function populateCreativeFilterOptions() {
  const fill = (id, values) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部</option>' +
      values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    sel.value = cur; // preserve selection across reloads
  };
  fill('creative-filter-owner', AIGC_OWNERS);
  fill('creative-filter-product', CREATIVE_PRODUCTS);
  fill('creative-filter-form', AIGC_FORMS);
  fill('creative-filter-type', AIGC_TYPES);
  fill('creative-filter-creative', AIGC_CREATIVES);

  // Date (制作/上线日期) options collected dynamically from the loaded data, newest first.
  const dateSet = new Set();
  if (creativeData) {
    [...(creativeData.fb || []), ...(creativeData.tt || [])].forEach(c => {
      parseAigcName(c.name || '').dates.forEach(d => dateSet.add(d));
    });
  }
  const dates = [...dateSet].sort((x, y) => y.localeCompare(x)); // MM-DD desc
  fill('creative-filter-date', dates);

  // Numeric filter dropdowns (share AIGC metric/op definitions)
  const mSel = document.getElementById('creative-num-metric');
  if (mSel && !mSel.options.length) {
    mSel.innerHTML = AIGC_NUM_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join('');
    mSel.value = creativeNumFilter.metric;
  }
  const oSel = document.getElementById('creative-num-op');
  if (oSel && !oSel.options.length) {
    oSel.innerHTML = AIGC_NUM_OPS.map(o => `<option value="${o.key}">${o.label}</option>`).join('');
    oSel.value = creativeNumFilter.op;
  }
}

function setupCreativeFilters() {
  const map = {
    'creative-filter-owner': 'owner',
    'creative-filter-product': 'product',
    'creative-filter-form': 'form',
    'creative-filter-type': 'type',
    'creative-filter-creative': 'creative',
    'creative-filter-date': 'date',
  };
  Object.entries(map).forEach(([id, key]) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.addEventListener('change', () => {
      creativeFilters[key] = sel.value;
      creativeFbPage = 1;
      creativeTtPage = 1;
      renderCreativeTable('fb');
      renderCreativeTable('tt');
    });
  });

  const applyNum = () => {
    creativeFbPage = 1;
    creativeTtPage = 1;
    renderCreativeTable('fb');
    renderCreativeTable('tt');
  };
  const mSel = document.getElementById('creative-num-metric');
  if (mSel) mSel.addEventListener('change', () => { creativeNumFilter.metric = mSel.value; applyNum(); });
  const oSel = document.getElementById('creative-num-op');
  if (oSel) oSel.addEventListener('change', () => { creativeNumFilter.op = oSel.value; applyNum(); });
  const vInput = document.getElementById('creative-num-value');
  if (vInput) vInput.addEventListener('input', () => {
    const v = vInput.value.trim();
    creativeNumFilter.value = v === '' ? null : parseFloat(v);
    applyNum();
  });
}

function resetCreativeFilters() {
  creativeFilters = { owner: '', product: '', form: '', type: '', creative: '', date: '' };
  ['creative-filter-owner', 'creative-filter-product', 'creative-filter-form', 'creative-filter-type', 'creative-filter-creative', 'creative-filter-date']
    .forEach(id => { const s = document.getElementById(id); if (s) s.value = ''; });
  creativeNumFilter = { metric: 'newUserRevenue', op: 'gte', value: null };
  const mSel = document.getElementById('creative-num-metric'); if (mSel) mSel.value = 'newUserRevenue';
  const oSel = document.getElementById('creative-num-op'); if (oSel) oSel.value = 'gte';
  const vInput = document.getElementById('creative-num-value'); if (vInput) vInput.value = '';
  creativeFbPage = 1;
  creativeTtPage = 1;
  renderCreativeTable('fb');
  renderCreativeTable('tt');
}

function downloadCreativeCsv(channel) {
  if (!creativeData) return;
  const isF = channel === 'fb';
  const data = applyCreativeFilters(isF ? creativeData.fb : creativeData.tt);
  const sortObj = isF ? creativeFbSort : creativeTtSort;
  if (!data || data.length === 0) return;

  const sorted = sortCreatives([...data], sortObj);
  const headers = ['#', '\u7d20\u6750\u540d\u79f0', '\u4ea7\u54c1', '\u65b0\u7528\u6237\u6536\u5165', '\u6d88\u8017', 'ROAS', 'CPM', 'CPC', 'CTR(%)'];
  const csvRows = [headers.join(',')];
  sorted.forEach((c, i) => {
    const m = computeCreativeMetrics(c);
    const name = '"' + (c.name || '').replace(/"/g, '""') + '"';
    const product = '"' + (c.product || '').replace(/"/g, '""') + '"';
    csvRows.push([
      i + 1, name, product, m.newUserRevenue.toFixed(2), m.cost.toFixed(2),
      m.roas.toFixed(2), m.cpm.toFixed(2), m.cpc.toFixed(2), m.ctr.toFixed(2)
    ].join(','));
  });

  const bom = '\uFEFF';
  const blob = new Blob([bom + csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const channelLabel = isF ? 'FB' : 'TT';
  const dateRange = (creativeData.dateRange || 'unknown').replace(/\s/g, '');
  a.href = url;
  a.download = `${channelLabel}\u7d20\u6750_${dateRange}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderCreativeTable(channel) {
  if (!creativeData) return;
  const isF = channel === 'fb';
  const data = applyCreativeFilters(isF ? creativeData.fb : creativeData.tt);
  const sortObj = isF ? creativeFbSort : creativeTtSort;
  const page = isF ? creativeFbPage : creativeTtPage;
  const tbodyId = isF ? 'creative-fb-tbody' : 'creative-tt-tbody';
  const pagId = isF ? 'creative-fb-pagination' : 'creative-tt-pagination';

  if (!data || data.length === 0) {
    document.getElementById(tbodyId).innerHTML = '<tr><td colspan="10" class="empty-msg">暂无数据</td></tr>';
    document.getElementById(pagId).innerHTML = '';
    return;
  }

  const sorted = sortCreatives([...data], sortObj);
  const totalPages = Math.ceil(sorted.length / CREATIVE_PAGE_SIZE);
  const start = (page - 1) * CREATIVE_PAGE_SIZE;
  const pageData = sorted.slice(start, start + CREATIVE_PAGE_SIZE);

  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = pageData.map((c, i) => {
    const m = computeCreativeMetrics(c);
    const rank = start + i + 1;
    const roasClass = m.roas >= 1 ? 'val-positive' : m.roas > 0 ? 'val-negative' : '';
    // 跨产品复用：产品下拉（默认选中首个非当前产品）+ 复制按钮
    const encName = encodeURIComponent(c.name || '');
    const curProd = c.product || '';
    const defTarget = CREATIVE_PRODUCTS.find(p => p !== curProd) || (CREATIVE_PRODUCTS[0] || '');
    const opts = CREATIVE_PRODUCTS.map(p =>
      `<option value="${escapeHtml(p)}"${p === defTarget ? ' selected' : ''}>${escapeHtml(p)}</option>`
    ).join('');
    const reuseCell = `<div class="aigc-reuse-wrap">`
      + `<select class="aigc-reuse-select" title="选目标产品">${opts}</select>`
      + `<button class="aigc-reuse-copy" title="复制改成目标产品后的完整素材名" onclick="creativeCopyReused(this,'${encName}')">复制</button>`
      + `</div>`;
    return `<tr>
      <td class="col-num">${rank}</td>
      <td class="col-creative-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
      <td class="creative-reuse-cell">${reuseCell}</td>
      <td class="creative-product-cell">${escapeHtml(c.product || '—')}</td>
      <td class="col-num">$${m.newUserRevenue.toFixed(2)}</td>
      <td class="col-num">$${m.cost.toFixed(2)}</td>
      <td class="col-num ${roasClass}">${m.roas.toFixed(2)}</td>
      <td class="col-num">$${m.cpm.toFixed(2)}</td>
      <td class="col-num">$${m.cpc.toFixed(2)}</td>
      <td class="col-num">${m.ctr.toFixed(2)}%</td>
    </tr>`;
  }).join('');
  
  // Pagination
  const pagEl = document.getElementById(pagId);
  if (totalPages <= 1) {
    pagEl.innerHTML = `<span class="creative-page-info">共 ${sorted.length} 条</span>`;
  } else {
    let html = `<span class="creative-page-info">第 ${page}/${totalPages} 页（共 ${sorted.length} 条）</span>`;
    html += `<button class="btn btn-small creative-page-btn" ${page <= 1 ? 'disabled' : ''} onclick="creativePageGo('${channel}', ${page - 1})">上一页</button>`;
    html += `<button class="btn btn-small creative-page-btn" ${page >= totalPages ? 'disabled' : ''} onclick="creativePageGo('${channel}', ${page + 1})">下一页</button>`;
    pagEl.innerHTML = html;
  }
}

function creativePageGo(channel, page) {
  if (channel === 'fb') creativeFbPage = page;
  else creativeTtPage = page;
  renderCreativeTable(channel);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setupCreativeSort() {
  document.querySelectorAll('.creative-sortable').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      const channel = th.dataset.channel;
      const sortObj = channel === 'fb' ? creativeFbSort : creativeTtSort;
      if (sortObj.field === field) {
        sortObj.dir = sortObj.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortObj.field = field;
        sortObj.dir = (field === 'name' || field === 'product') ? 'asc' : 'desc';
      }
      // Reset to page 1 on sort change
      if (channel === 'fb') creativeFbPage = 1;
      else creativeTtPage = 1;
      renderCreativeTable(channel);
    });
  });
}

// ═══════════════════════════════════════════════════════
// AIGC Panel — parallel to creative panel. Keys by full raw
// material name (no parseCreativeName), AIGC-filtered upstream.
// ═══════════════════════════════════════════════════════

let aigcData = null; // { dates, dateRange, fb: [], tt: [] }
let aigcWindow = 3; // time window in days: 3 | 7 | 14
let aigcCorrectionMode = false; // false=原始收入, true=修正收入
let aigcCorrectionFactors = {}; // latest correction factors { fullProduct: number | {fb, other} }

// AIGC uses base product names (no iOS/And suffix); correction factors are keyed by full
// product name (platform-specific). Map base product + channel -> full factor key.
// Decision (屹恒 2026-06-30): Romi always uses Romi iOS.
const AIGC_FACTOR_PRODUCT = {
  'Doni': 'Doni',
  'GraceChat': 'GraceChat',
  'Jovia': 'Jovia And',
  'Kira': 'Kira And',
  'Luma': 'Luma',
  'Nalo': 'Nalo And',
  'Romi': 'Romi iOS',
  'Dora': 'Dora iOS',
};

// Resolve the correction factor for an AIGC row (base product + channel FB/TT).
function getAigcCorrectionFactor(product, channel) {
  const key = AIGC_FACTOR_PRODUCT[product];
  if (!key) return 1;
  const f = aigcCorrectionFactors[key];
  if (f == null) return 1;
  if (typeof f === 'number') return f; // Android: single factor, channel-independent
  // iOS-style { fb, other }: FB channel uses fb, everything else (TT) uses other
  if (channel === 'FB') return f.fb || 1;
  return f.other || 1;
}

// Fetch the latest single-day correction factors (yesterday's, the most recent complete set).
async function fetchAigcCorrectionFactors() {
  try {
    // Use yesterday (Beijing) as the latest complete factor set.
    const now = new Date(Date.now() + 8 * 3600000);
    now.setUTCDate(now.getUTCDate() - 1);
    const d = now.toISOString().slice(0, 10);
    const resp = await fetch(`/api/correction-factors?date=${d}`);
    if (resp.ok) {
      const data = await resp.json();
      aigcCorrectionFactors = data.factors || {};
    }
  } catch (e) { console.warn('Failed to fetch AIGC correction factors', e); }
}

// AIGC metrics with optional correction applied to newUserRevenue (and ROAS recomputed).
function computeAigcMetrics(c) {
  let rev = c.newUserRevenue || 0;
  if (aigcCorrectionMode) rev = rev * getAigcCorrectionFactor(c.product, c.channel);
  return {
    ...c,
    newUserRevenue: rev,
    cpm: c.impressions > 0 ? (c.cost / c.impressions * 1000) : 0,
    cpc: c.clicks > 0 ? (c.cost / c.clicks) : 0,
    ctr: c.impressions > 0 ? (c.clicks / c.impressions * 100) : 0,
    roas: c.cost > 0 ? (rev / c.cost) : 0,
  };
}

function toggleAigcCorrectionMode(enabled) {
  aigcCorrectionMode = enabled;
  const input = document.getElementById('aigc-corr-toggle-input');
  const label = document.getElementById('aigc-corr-toggle-label');
  if (input) input.checked = enabled;
  if (label) label.textContent = enabled ? '修正' : '原始';
  renderAigcTable('fb');
  renderAigcTable('tt');
}
let aigcFbPage = 1;
let aigcTtPage = 1;
const AIGC_PAGE_SIZE = 20;
let aigcFbSort = { field: 'newUserRevenue', dir: 'desc' };
let aigcTtSort = { field: 'newUserRevenue', dir: 'desc' };

// ── AIGC naming-convention parsing + filtering (front-end only) ──
const AIGC_OWNERS = ['ZHT', 'WXT', 'LSY', 'WYM', 'ZKN', 'XZH', 'CKY'];
const AIGC_PRODUCTS = ['Doni', 'GraceChat', 'Jovia', 'Kira', 'Luma', 'Nalo', 'Romi', 'Vika'];
const AIGC_FORMS = ['剧情类', '口播类', '展示类'];
const AIGC_TYPES = ['创新', '迭代', '铺量'];
const AIGC_CREATIVES = ['暗示', '自我展示', '女性主动', '男性爽感', '找对象', '产品安利', '痛点对比', '社会证明', '挑战承诺', '情绪求助', '反差冲突'];
const AIGC_ACTORS = ['Emily', 'Ashley', 'Jessica', 'Sarah', 'Amanda', 'Megan', 'Hannah', 'Brittany', 'Lauren', 'Nicole', 'Rachel', 'Samantha', 'Lisa'];

let aigcFilters = { owner: '', product: '', form: '', type: '', creative: '', date: '' };
// Numeric filter: { metric: 'newUserRevenue'|'cost'|'roas'|'cpm'|'cpc'|'ctr', op: 'gt'|'lt'|'eq'|'gte'|'lte', value: number|null }
let aigcNumFilter = { metric: 'newUserRevenue', op: 'gte', value: null };
// Metrics available for numeric filtering (key matches computeAigcMetrics output fields).
const AIGC_NUM_METRICS = [
  { key: 'newUserRevenue', label: '新用户收入' },
  { key: 'cost', label: '消耗' },
  { key: 'roas', label: 'ROAS' },
  { key: 'cpm', label: 'CPM' },
  { key: 'cpc', label: 'CPC' },
  { key: 'ctr', label: 'CTR(%)' },
];
const AIGC_NUM_OPS = [
  { key: 'gt', label: '>' },
  { key: 'gte', label: '≥' },
  { key: 'eq', label: '=' },
  { key: 'lte', label: '≤' },
  { key: 'lt', label: '<' },
];
function aigcNumCompare(actual, op, target) {
  switch (op) {
    case 'gt': return actual > target;
    case 'gte': return actual >= target;
    case 'eq': return Math.abs(actual - target) < 1e-9;
    case 'lte': return actual <= target;
    case 'lt': return actual < target;
    default: return true;
  }
}

// Match an enum value against a name: by underscore segment OR substring.
// Substring fallback lets compound names (e.g. GraceChat) match without mis-splitting.
function aigcMatchEnum(name, segs, values) {
  const hit = [];
  for (const v of values) {
    if (segs.includes(v) || name.includes(v)) hit.push(v);
  }
  return hit;
}

// Parse a single (sub)name into its convention fields.
function parseAigcSubName(name) {
  const segs = (name || '').split('_');
  const owners = aigcMatchEnum(name, segs, AIGC_OWNERS);
  const products = aigcMatchEnum(name, segs, AIGC_PRODUCTS);
  const forms = aigcMatchEnum(name, segs, AIGC_FORMS);
  const types = aigcMatchEnum(name, segs, AIGC_TYPES);
  const actors = aigcMatchEnum(name, segs, AIGC_ACTORS);
  const creatives = AIGC_CREATIVES.filter(c => (name || '').includes(c));
  const refMatch = (name || '').match(/竞品学习([A-Za-z0-9]+)/);
  // Leading YYMMDD = 制作/上线日期 (first 6-digit segment). Display as MM-DD.
  let date = '';
  const dm = (segs[0] || '').match(/^(\d{2})(\d{2})(\d{2})$/);
  if (dm) date = `${dm[2]}-${dm[3]}`;
  return {
    owner: owners[0] || '',
    product: products[0] || '',
    form: forms[0] || '',
    type: types[0] || '',
    creatives,
    actor: actors[0] || '',
    refCode: refMatch ? refMatch[1] : '',
    date,
  };
}

// Parse a (possibly multi-product packaged) name. Packaged rows joined by ' | '
// are split into sub-names; row-level fields are the UNION across sub-names.
function parseAigcName(name) {
  const parts = (name || '').split(' | ');
  const out = { owner: '', product: '', form: '', type: '', creatives: [], actor: '', refCode: '' };
  const ownerSet = new Set(), productSet = new Set(), formSet = new Set();
  const typeSet = new Set(), creativeSet = new Set(), actorSet = new Set(), refSet = new Set();
  const dateSet = new Set();
  for (const part of parts) {
    const p = parseAigcSubName(part);
    if (p.owner) ownerSet.add(p.owner);
    if (p.product) productSet.add(p.product);
    if (p.form) formSet.add(p.form);
    if (p.type) typeSet.add(p.type);
    if (p.actor) actorSet.add(p.actor);
    if (p.refCode) refSet.add(p.refCode);
    if (p.date) dateSet.add(p.date);
    p.creatives.forEach(c => creativeSet.add(c));
  }
  out.dates = [...dateSet];
  out.date = out.dates[0] || '';
  out.owners = [...ownerSet];
  out.products = [...productSet];
  out.forms = [...formSet];
  out.types = [...typeSet];
  out.actors = [...actorSet];
  out.creatives = [...creativeSet];
  out.refCodes = [...refSet];
  // Single-value convenience fields (first hit) per the documented shape.
  out.owner = out.owners[0] || '';
  out.product = out.products[0] || '';
  out.form = out.forms[0] || '';
  out.type = out.types[0] || '';
  out.actor = out.actors[0] || '';
  out.refCode = out.refCodes[0] || '';
  return out;
}

// ── 跨产品复用：把素材名里的产品字段替换为目标产品，返回新完整素材名 ──
// 素材名按 '_' 分段，产品是其中一段（AIGC_PRODUCTS 之一）。以名字里实际出现的
// 产品 seg 为准替换（不依赖行的 product 字段，因两者偶有不一致）。
// 打包名（' | ' 拼接）逐个子名替换。
function replaceAigcProduct(name, targetProduct) {
  if (!name || !targetProduct) return name;
  const replaceOne = (sub) => {
    const segs = sub.split('_');
    let replaced = false;
    for (let i = 0; i < segs.length; i++) {
      if (AIGC_PRODUCTS.includes(segs[i])) {
        segs[i] = targetProduct;
        replaced = true;
      }
    }
    // 兜底：无独立产品 seg 时，尝试子串替换任一已知产品名
    if (!replaced) {
      for (const p of AIGC_PRODUCTS) {
        if (sub.includes(p)) return sub.split(p).join(targetProduct);
      }
    }
    return segs.join('_');
  };
  return name.split(' | ').map(replaceOne).join(' | ');
}

// 复制按钮点击：把行素材名的产品字段改成下拉选中的目标产品后写入剪贴板。
function aigcCopyReused(btn, encodedName) {
  const sel = btn.parentElement.querySelector('.aigc-reuse-select');
  const target = sel ? sel.value : '';
  if (!target) { sel && sel.focus(); return; }
  const original = decodeURIComponent(encodedName);
  const newName = replaceAigcProduct(original, target);
  const done = () => {
    const old = btn.textContent;
    btn.textContent = '✓ 已复制';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(newName).then(done).catch(() => aigcCopyFallback(newName, done));
  } else {
    aigcCopyFallback(newName, done);
  }
}

function aigcCopyFallback(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done && done(); } catch (e) { console.warn('copy failed', e); }
  document.body.removeChild(ta);
}

// Keep rows whose parsed fields contain ALL selected filter values (AND across fields).
function applyAigcFilters(data) {
  const f = aigcFilters;
  const nf = aigcNumFilter;
  const hasNum = nf && nf.value != null && !Number.isNaN(nf.value);
  if (!f.owner && !f.product && !f.form && !f.type && !f.creative && !f.date && !hasNum) return data;
  return data.filter(c => {
    const p = parseAigcName(c.name || '');
    if (f.owner && !p.owners.includes(f.owner)) return false;
    if (f.product && c.product !== f.product && !p.products.includes(f.product)) return false;
    if (f.form && !p.forms.includes(f.form)) return false;
    if (f.type && !p.types.includes(f.type)) return false;
    if (f.creative && !p.creatives.includes(f.creative)) return false;
    if (f.date && !p.dates.includes(f.date)) return false;
    if (hasNum) {
      const m = computeAigcMetrics(c);
      const actual = m[nf.metric];
      if (actual == null || !aigcNumCompare(actual, nf.op, nf.value)) return false;
    }
    return true;
  });
}

function populateAigcFilterOptions() {
  const fill = (id, values) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部</option>' +
      values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    sel.value = cur; // preserve selection across reloads
  };
  fill('aigc-filter-owner', AIGC_OWNERS);
  fill('aigc-filter-product', AIGC_PRODUCTS);
  fill('aigc-filter-form', AIGC_FORMS);
  fill('aigc-filter-type', AIGC_TYPES);
  fill('aigc-filter-creative', AIGC_CREATIVES);

  // Date (制作/上线日期) options collected dynamically from the loaded data, newest first.
  const dateSet = new Set();
  if (aigcData) {
    [...(aigcData.fb || []), ...(aigcData.tt || [])].forEach(c => {
      parseAigcName(c.name || '').dates.forEach(d => dateSet.add(d));
    });
  }
  const dates = [...dateSet].sort((x, y) => y.localeCompare(x)); // MM-DD desc
  fill('aigc-filter-date', dates);

  // Numeric filter dropdowns
  const mSel = document.getElementById('aigc-num-metric');
  if (mSel && !mSel.options.length) {
    mSel.innerHTML = AIGC_NUM_METRICS.map(m => `<option value="${m.key}">${m.label}</option>`).join('');
    mSel.value = aigcNumFilter.metric;
  }
  const oSel = document.getElementById('aigc-num-op');
  if (oSel && !oSel.options.length) {
    oSel.innerHTML = AIGC_NUM_OPS.map(o => `<option value="${o.key}">${o.label}</option>`).join('');
    oSel.value = aigcNumFilter.op;
  }
}

function setupAigcFilters() {
  const map = {
    'aigc-filter-owner': 'owner',
    'aigc-filter-product': 'product',
    'aigc-filter-form': 'form',
    'aigc-filter-type': 'type',
    'aigc-filter-creative': 'creative',
    'aigc-filter-date': 'date',
  };
  Object.entries(map).forEach(([id, key]) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.addEventListener('change', () => {
      aigcFilters[key] = sel.value;
      aigcFbPage = 1;
      aigcTtPage = 1;
      renderAigcTable('fb');
      renderAigcTable('tt');
    });
  });

  // Numeric filter listeners
  const applyNum = () => {
    aigcFbPage = 1;
    aigcTtPage = 1;
    renderAigcTable('fb');
    renderAigcTable('tt');
  };
  const mSel = document.getElementById('aigc-num-metric');
  if (mSel) mSel.addEventListener('change', () => { aigcNumFilter.metric = mSel.value; applyNum(); });
  const oSel = document.getElementById('aigc-num-op');
  if (oSel) oSel.addEventListener('change', () => { aigcNumFilter.op = oSel.value; applyNum(); });
  const vInput = document.getElementById('aigc-num-value');
  if (vInput) vInput.addEventListener('input', () => {
    const v = vInput.value.trim();
    aigcNumFilter.value = v === '' ? null : parseFloat(v);
    applyNum();
  });
}

function resetAigcFilters() {
  aigcFilters = { owner: '', product: '', form: '', type: '', creative: '', date: '' };
  ['aigc-filter-owner', 'aigc-filter-product', 'aigc-filter-form', 'aigc-filter-type', 'aigc-filter-creative', 'aigc-filter-date']
    .forEach(id => { const s = document.getElementById(id); if (s) s.value = ''; });
  // Reset numeric filter
  aigcNumFilter = { metric: 'newUserRevenue', op: 'gte', value: null };
  const mSel = document.getElementById('aigc-num-metric'); if (mSel) mSel.value = 'newUserRevenue';
  const oSel = document.getElementById('aigc-num-op'); if (oSel) oSel.value = 'gte';
  const vInput = document.getElementById('aigc-num-value'); if (vInput) vInput.value = '';
  aigcFbPage = 1;
  aigcTtPage = 1;
  renderAigcTable('fb');
  renderAigcTable('tt');
}

function setAigcWindow(days) {
  if (aigcWindow === days) return;
  aigcWindow = days;
  // toggle active button state
  document.querySelectorAll('.aigc-window-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.days, 10) === days);
  });
  aigcFbPage = 1;
  aigcTtPage = 1;
  loadAigcData();
}

async function loadAigcData() {
  showLoading();
  const statusEl = document.getElementById('aigc-status-info');
  if (statusEl) statusEl.innerHTML = '<span class="status-dot busy"></span> AIGC 数据：加载中...';

  try {
    const resp = await fetch(`/api/aigc/data?days=${aigcWindow}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    aigcData = await resp.json();

    // Load the latest correction factors so the 修正 toggle can apply them instantly.
    await fetchAigcCorrectionFactors();

    const rangeEl = document.getElementById('aigc-date-range');
    if (rangeEl) {
      const miss = (aigcData.missingDates && aigcData.missingDates.length)
        ? ` ⚠️ 缺 ${aigcData.missingDates.length} 天` : '';
      rangeEl.textContent = `AIGC 素材排名（${aigcData.dateRange}）${miss}`;
    }

    if (statusEl) statusEl.innerHTML = '<span class="status-dot ok"></span> AIGC 数据：已加载';
    const datesEl = document.getElementById('aigc-status-dates');
    if (datesEl) datesEl.textContent = `数据范围：${aigcData.dateRange}`;

    populateAigcFilterOptions();

    aigcFbPage = 1;
    aigcTtPage = 1;

    renderAigcTable('fb');
    renderAigcTable('tt');
  } catch (err) {
    console.error('Failed to load aigc data:', err);
    if (statusEl) statusEl.innerHTML = '<span class="status-dot error"></span> AIGC 数据：加载失败 - ' + err.message;
  } finally {
    hideLoading();
  }
}

// AIGC reuses computeCreativeMetrics (cost/impressions/clicks/newUserRevenue shape is identical).
function sortAigc(list, sortObj) {
  return list.sort((a, b) => {
    if (sortObj.field === 'name' || sortObj.field === 'product') {
      const av = a[sortObj.field] || '', bv = b[sortObj.field] || '';
      return sortObj.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    const am = computeAigcMetrics(a);
    const bm = computeAigcMetrics(b);
    return sortObj.dir === 'asc' ? am[sortObj.field] - bm[sortObj.field] : bm[sortObj.field] - am[sortObj.field];
  });
}

function downloadAigcCsv(channel) {
  if (!aigcData) return;
  const isF = channel === 'fb';
  const data = applyAigcFilters(isF ? aigcData.fb : aigcData.tt);
  const sortObj = isF ? aigcFbSort : aigcTtSort;
  if (!data || data.length === 0) return;

  const sorted = sortAigc([...data], sortObj);
  const headers = ['#', '素材名称', '产品', '新用户收入', '消耗', 'ROAS', 'CPM', 'CPC', 'CTR(%)'];
  const csvRows = [headers.join(',')];
  sorted.forEach((c, i) => {
    const m = computeAigcMetrics(c);
    const name = '"' + (c.name || '').replace(/"/g, '""') + '"';
    const product = '"' + (c.product || '').replace(/"/g, '""') + '"';
    csvRows.push([
      i + 1, name, product, m.newUserRevenue.toFixed(2), m.cost.toFixed(2),
      m.roas.toFixed(2), m.cpm.toFixed(2), m.cpc.toFixed(2), m.ctr.toFixed(2)
    ].join(','));
  });

  const bom = '﻿';
  const blob = new Blob([bom + csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const channelLabel = isF ? 'FB' : 'TT';
  const dateRange = (aigcData.dateRange || 'unknown').replace(/\s/g, '');
  a.href = url;
  a.download = `${channelLabel}AIGC素材_${dateRange}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderAigcTable(channel) {
  if (!aigcData) return;
  const isF = channel === 'fb';
  const data = applyAigcFilters(isF ? aigcData.fb : aigcData.tt);
  const sortObj = isF ? aigcFbSort : aigcTtSort;
  const page = isF ? aigcFbPage : aigcTtPage;
  const tbodyId = isF ? 'aigc-fb-tbody' : 'aigc-tt-tbody';
  const pagId = isF ? 'aigc-fb-pagination' : 'aigc-tt-pagination';

  if (!data || data.length === 0) {
    document.getElementById(tbodyId).innerHTML = '<tr><td colspan="10" class="empty-msg">暂无数据</td></tr>';
    document.getElementById(pagId).innerHTML = '';
    return;
  }

  const sorted = sortAigc([...data], sortObj);
  const totalPages = Math.ceil(sorted.length / AIGC_PAGE_SIZE);
  const start = (page - 1) * AIGC_PAGE_SIZE;
  const pageData = sorted.slice(start, start + AIGC_PAGE_SIZE);

  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = pageData.map((c, i) => {
    const m = computeAigcMetrics(c);
    const rank = start + i + 1;
    const roasClass = m.roas >= 1 ? 'val-positive' : m.roas > 0 ? 'val-negative' : '';
    // 跨产品复用：产品下拉（默认选中首个非当前产品）+ 复制按钮
    const encName = encodeURIComponent(c.name || '');
    const curProd = c.product || '';
    const defTarget = AIGC_PRODUCTS.find(p => p !== curProd) || (AIGC_PRODUCTS[0] || '');
    const opts = AIGC_PRODUCTS.map(p =>
      `<option value="${escapeHtml(p)}"${p === defTarget ? ' selected' : ''}>${escapeHtml(p)}</option>`
    ).join('');
    const reuseCell = `<div class="aigc-reuse-wrap">`
      + `<select class="aigc-reuse-select" title="选目标产品">${opts}</select>`
      + `<button class="aigc-reuse-copy" title="复制改成目标产品后的完整素材名" onclick="aigcCopyReused(this,'${encName}')">复制</button>`
      + `</div>`;
    return `<tr>
      <td class="col-num">${rank}</td>
      <td class="col-aigc-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
      <td class="aigc-reuse-cell">${reuseCell}</td>
      <td class="aigc-product-cell">${escapeHtml(c.product || '—')}</td>
      <td class="col-num">$${m.newUserRevenue.toFixed(2)}</td>
      <td class="col-num">$${m.cost.toFixed(2)}</td>
      <td class="col-num ${roasClass}">${m.roas.toFixed(2)}</td>
      <td class="col-num">$${m.cpm.toFixed(2)}</td>
      <td class="col-num">$${m.cpc.toFixed(2)}</td>
      <td class="col-num">${m.ctr.toFixed(2)}%</td>
    </tr>`;
  }).join('');

  const pagEl = document.getElementById(pagId);
  if (totalPages <= 1) {
    pagEl.innerHTML = `<span class="creative-page-info">共 ${sorted.length} 条</span>`;
  } else {
    let html = `<span class="creative-page-info">第 ${page}/${totalPages} 页（共 ${sorted.length} 条）</span>`;
    html += `<button class="btn btn-small creative-page-btn" ${page <= 1 ? 'disabled' : ''} onclick="aigcPageGo('${channel}', ${page - 1})">上一页</button>`;
    html += `<button class="btn btn-small creative-page-btn" ${page >= totalPages ? 'disabled' : ''} onclick="aigcPageGo('${channel}', ${page + 1})">下一页</button>`;
    pagEl.innerHTML = html;
  }
}

function aigcPageGo(channel, page) {
  if (channel === 'fb') aigcFbPage = page;
  else aigcTtPage = page;
  renderAigcTable(channel);
}

function setupAigcSort() {
  document.querySelectorAll('.aigc-sortable').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      const channel = th.dataset.channel;
      const sortObj = channel === 'fb' ? aigcFbSort : aigcTtSort;
      if (sortObj.field === field) {
        sortObj.dir = sortObj.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortObj.field = field;
        sortObj.dir = field === 'name' ? 'asc' : 'desc';
      }
      if (channel === 'fb') aigcFbPage = 1;
      else aigcTtPage = 1;
      renderAigcTable(channel);
    });
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const summaryPanelTrigger = document.getElementById('panel-selector-trigger');
  if (summaryPanelTrigger) summaryPanelTrigger.addEventListener('click', () => switchPanel('summary'));

  const backToSummaryBtn = document.getElementById('back-to-summary');
  if (backToSummaryBtn) backToSummaryBtn.addEventListener('click', () => switchPanel('summary'));

  const postbackEntryBtn = document.getElementById('postback-panel-entry');
  if (postbackEntryBtn) postbackEntryBtn.addEventListener('click', () => switchPanel('postback'));

  const backFromPostbackBtn = document.getElementById('back-from-postback');
  if (backFromPostbackBtn) backFromPostbackBtn.addEventListener('click', () => switchPanel('summary'));

  const pbPersonalEntryBtn = document.getElementById('pb-personal-entry');
  if (pbPersonalEntryBtn) pbPersonalEntryBtn.addEventListener('click', () => switchPanel('pb-personal'));

  const creativeEntryBtn = document.getElementById('creative-panel-entry');
  if (creativeEntryBtn) creativeEntryBtn.addEventListener('click', () => switchPanel('creative'));

  const aigcEntryBtn = document.getElementById('aigc-panel-entry');
  if (aigcEntryBtn) aigcEntryBtn.addEventListener('click', () => switchPanel('aigc'));

  // ── Date range picker (Flatpickr, single calendar, range mode) ──
  // Format a Date to local YYYY-MM-DD (avoid toISOString UTC offset).
  function fpDateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  // Apply new start/end and trigger exactly one data load for the current panel.
  function applyDateRange() {
    resetLoading();
    if (trendChart) { trendChart.destroy(); trendChart = null; }
    if (personalTrendChart) { personalTrendChart.destroy(); personalTrendChart = null; }
    if (currentPanel === 'postback') loadPostbackData(startDate, endDate);
    else if (currentPanel === 'pb-personal') loadPbPersonalData(startDate, endDate);
    else loadData(startDate, endDate);
  }

  const fp = flatpickr('#date-range', {
    mode: 'range',
    dateFormat: 'Y-m-d',
    locale: 'zh',
    defaultDate: [startDate, endDate],
    // Only load once the range is fully chosen (both endpoints picked).
    onChange: function(selectedDates) {
      if (selectedDates.length < 2) return; // first click: waiting for second endpoint, no load
      const ds = selectedDates.map(fpDateStr).sort();
      // Guard: large ranges trigger slow multi-day cross-month aggregation (can stall the server).
      const MAX_RANGE_DAYS = 31;
      const spanDays = Math.round((new Date(ds[1]) - new Date(ds[0])) / 86400000) + 1;
      if (spanDays > MAX_RANGE_DAYS) {
        alert(`日期范围过大（${spanDays} 天）。当前多日查询性能有限，请选择不超过 ${MAX_RANGE_DAYS} 天的区间。`);
        fp.setDate([startDate, endDate], false); // revert to previous valid range
        return;
      }
      startDate = ds[0];
      endDate = ds[1]; // equal => single day
      applyDateRange();
    }
  });

  document.getElementById('btn-today').addEventListener('click', () => {
    const today = todayStr();
    startDate = today;
    endDate = today;
    fp.setDate([today, today], false); // false = don't fire onChange
    applyDateRange();
  });

  const summaryRefreshBtn = document.getElementById('btn-refresh-summary');
  const summaryStatusNextEl = document.getElementById('status-next');
  let summaryHideTimer = null;
  summaryStatusNextEl.addEventListener('dblclick', () => {
    summaryRefreshBtn.style.display = 'inline-block';
    if (summaryHideTimer) clearTimeout(summaryHideTimer);
    summaryHideTimer = setTimeout(() => { summaryRefreshBtn.style.display = 'none'; }, 3000);
  });
  summaryRefreshBtn.addEventListener('click', handleSummaryRefresh);

  const personalRefreshBtn = document.getElementById('btn-refresh-personal');
  const personalStatusNextEl = document.getElementById('personal-status-next');
  let personalHideTimer = null;
  personalStatusNextEl.addEventListener('dblclick', () => {
    personalRefreshBtn.style.display = 'inline-block';
    if (personalHideTimer) clearTimeout(personalHideTimer);
    personalHideTimer = setTimeout(() => { personalRefreshBtn.style.display = 'none'; }, 3000);
  });
  personalRefreshBtn.addEventListener('click', handlePersonalRefresh);

  setupSort();
  setupExpandBtns();
  setupCreativeSort();
  setupCreativeFilters();
  setupAigcSort();
  setupAigcFilters();
  await loadData(startDate, endDate);
  await updateStatus();
  await updatePersonalStatus();
  switchPanel('summary');

  setInterval(updateStatus, 30000);
  setInterval(updatePersonalStatus, 30000);
  setInterval(() => { if (startDate === todayStr() && endDate === todayStr()) loadData(startDate, endDate); }, 5 * 60 * 1000);

  // ── Overview Modal ──
  const overviewBtn = document.getElementById('btn-overview');
  const overviewModal = document.getElementById('overview-modal');
  const overviewBackdrop = document.getElementById('overview-modal-backdrop');
  const overviewClose = document.getElementById('overview-modal-close');
  const overviewBody = document.getElementById('overview-modal-body');

  function openOverviewModal() {
    overviewModal.style.display = 'flex';
    if (!overviewBody.dataset.loaded) {
      overviewBody.innerHTML = '<div class="overview-loading">加载中...</div>';
      fetch('/api/overview')
        .then(r => r.ok ? r.text() : Promise.reject('Failed'))
        .then(text => {
          overviewBody.textContent = text;
          overviewBody.dataset.loaded = '1';
        })
        .catch(() => {
          overviewBody.innerHTML = '<div class="overview-loading">加载失败，请刷新重试</div>';
        });
    }
  }
  function closeOverviewModal() { overviewModal.style.display = 'none'; }

  overviewBtn.addEventListener('click', openOverviewModal);
  overviewClose.addEventListener('click', closeOverviewModal);
  overviewBackdrop.addEventListener('click', closeOverviewModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOverviewModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAiAdvice(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRevenueByInstall(); });
});
