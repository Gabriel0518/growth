// api-guard.js — Dashboard 对外接口保护中间件
// 目标：防止外部 agent（或失控循环）用重接口/大范围查询打爆单线程 Node 事件循环。
// 四层保护：
//   1) 单请求范围护栏：postback/personal、ext/records 等重接口，日期跨度超上限直接 429。
//   2) 每 IP 频率限制：滑动 60s 窗口，超上限 429 + Retry-After。
//   3) 分级并发闸（快速失败，不排长队）：
//        a) 每 IP 并发上限：单个 IP 同时在跑的重接口数超上限 → 429（只限它自己，不误伤别人）。
//        b) 全局并发上限：所有重接口同时在跑的总数超上限 → 429（防多 IP 涌入把单线程 Node 打爆）。
//   4) 单请求硬超时：任何重接口跑超过上限直接掐断连接、释放并发计数、返回 503。
//      → 保证「同 IP 打满并发」最坏情况下也只会自我堵塞约超时时长，之后并发坑必被归还、自动恢复。
//      注：Node 单线程 + better-sqlite3 同步查询时，若单条查询自身跑满超时才返回，超时回调需等其执行完
//      才触发（Node 特性，无法中断同步执行）；实测这些查询均为亚秒级，长堵来自多请求叠加，已被并发闸从源头掐掉。
//
// 所有阈值可通过环境变量覆盖（不改配置文件，用 EnvironmentFile /etc/environment 或默认值）。

'use strict';

const CFG = {
  // 单请求最大日期跨度（天）。postback/personal 逐天遍历，跨度大=重。
  MAX_RANGE_DAYS: parseInt(process.env.GUARD_MAX_RANGE_DAYS || '14', 10),
  // 绝对硬范围上限：对所有请求（含真人 session）生效，防单个大范围同步查询把事件循环卡死。
  HARD_MAX_RANGE_DAYS: parseInt(process.env.GUARD_HARD_MAX_RANGE_DAYS || '45', 10),
  // 每 IP 每 60s 最大请求数（针对受保护的重接口）。
  IP_RATE_PER_MIN: parseInt(process.env.GUARD_IP_RATE_PER_MIN || '30', 10),
  // 每个 IP 最大并发重接口数（超过就快速 429，只影响该 IP 自己）。
  PER_IP_CONCURRENT: parseInt(process.env.GUARD_PER_IP_CONCURRENT || '4', 10),
  // 全局重接口最大并发（单线程 Node，超过就快速 429，避免排队阻塞事件循环）。
  MAX_CONCURRENT: parseInt(process.env.GUARD_MAX_CONCURRENT || '8', 10),
  // 单个重接口请求硬超时（毫秒）：超时掐断连接 + 释放并发计数 + 503。
  REQUEST_TIMEOUT_MS: parseInt(process.env.GUARD_REQUEST_TIMEOUT_MS || '180000', 10),
  // M2M（?key=/Authorization 机器取数）全局串行槽：同一时刻最多几个 M2M 重请求真正执行，
  // 其余立刻 429 快速失败（绝不排队堆事件循环）。默认 1 = 外部机器取数彻底串行，
  // 单个慢请求(如 postback/personal ~4s)最多只占 1 个槽，绝不叠加把单线程堵死。真人 session 不受此限。
  M2M_SERIAL_SLOTS: parseInt(process.env.GUARD_M2M_SERIAL_SLOTS || '1', 10),
  // 【总开关】是否直接关闭对外机器取数 API（?key=/Authorization 的 M2M 请求）。
  // 默认 '1' = 关闭：所有 M2M 请求一律 503 拒绝，只保留网页端浏览器 session 正常访问。
  // 背景：8081 裸奔公网，外部 agent 用代理池分散 IP 直连猛刷，逐个封 IP 追不上，
  // 干脆从源头关掉对外 API，等做好「收回内网 + Caddy 反代 + 认证限流」再重新开放（设为 '0'）。
  BLOCK_M2M: (process.env.GUARD_BLOCK_M2M || '1') === '1',
  // 受「范围护栏 + 并发闸」保护的重接口前缀（这些接口按日期遍历/大聚合，最重）。
  HEAVY_PATHS: [
    '/api/postback/personal',
    '/api/ext/records',
    '/api/data',
    '/api/af-summary',
    '/api/channel-summary',
    '/api/correction-factors',
    '/api/revenue-by-install',
    '/api/campaign-context',
  ],
};

// ---- 状态 ----
const ipHits = new Map();       // ip -> number[] (timestamps ms, 滑动窗口)
const ipConcurrent = new Map(); // ip -> number (该 IP 当前在飞的重接口数)
let concurrent = 0;             // 当前全局重接口并发数
let m2mInFlight = 0;            // 当前在飞的 M2M（机器取数）重接口数（全局串行槽用）
const IP_WINDOW_MS = 60_000;

function isHeavy(path) {
  return CFG.HEAVY_PATHS.some(p => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));
}

// 从 query 解析日期跨度（天）。支持 startDate/endDate 或单 date。
function rangeDays(q) {
  const s = q.startDate || q.date;
  const e = q.endDate || q.date;
  if (!s || !e) return 1;
  const sd = Date.parse(s + 'T00:00:00Z');
  const ed = Date.parse(e + 'T00:00:00Z');
  if (isNaN(sd) || isNaN(ed)) return 1;
  return Math.floor((ed - sd) / 86400000) + 1; // inclusive
}

function clientIp(req) {
  // 反代后取真实 IP：优先 X-Forwarded-For 首段，否则 req.ip
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || 'unknown';
}

function pruneIp(list, now) {
  // 原地删除窗口外的时间戳
  while (list.length && now - list[0] > IP_WINDOW_MS) list.shift();
  return list;
}

/**
 * Express 中间件。挂在 authCheck 之后、重接口路由之前（对所有 /api/* 生效，
 * 但仅对 HEAVY_PATHS 施加范围护栏 + 并发闸；频率限制对所有受保护路径生效）。
 */
function apiGuard(req, res, next) {
  const path = req.path || '';
  if (!path.startsWith('/api/')) return next();
  if (!isHeavy(path)) return next(); // 轻接口放行（meta/xmp-fields 等）

  // --- (0) 绝对硬范围闸：对所有人（含真人 session）生效。
  // 单个超大范围的同步 SQLite 查询会独占事件循环把整个进程卡死数分钟，
  // 且 request-timeout 无法中断同步执行。所以这一层必须在 browser 豁免之前，谁都不能绕过。
  {
    const hardDays = rangeDays(req.query || {});
    if (hardDays > CFG.HARD_MAX_RANGE_DAYS) {
      console.warn(`[Guard] HARD range too large: ${hardDays}d > ${CFG.HARD_MAX_RANGE_DAYS}d, path=${req.path} (applies to all incl. session)`);
      return res.status(429).json({
        ok: false,
        error: `Date range too large: ${hardDays} days exceeds the hard limit of ${CFG.HARD_MAX_RANGE_DAYS} days. A single query this large would freeze the server. Split it up.`,
        hardMaxRangeDays: CFG.HARD_MAX_RANGE_DAYS,
        hint: 'Split into smaller date chunks, even in the browser.',
      });
    }
  }

  // 浏览器登录用户（session 认证的真人）豁免：他们打开面板会连发几个 heavy 请求，
  // 不该被机器取数的限流误伤。限流只针对用 ?key=/Bearer 的机器取数（M2M）。
  const isM2M = !!(req.query && req.query.key) ||
    !!(req.headers && req.headers['authorization']);
  const isBrowserSession = !!(req.session && req.session.authenticated) && !isM2M;
  if (isBrowserSession) return next();

  // --- (0) M2M 总闸：对外机器取数 API 已临时关闭 ---
  // 只保留网页端浏览器 session（上面已放行）。带 ?key=/Authorization 的机器取数一律 503 拒绝。
  // 重新开放：设环境变量 GUARD_BLOCK_M2M=0 并重启。
  if (isM2M && CFG.BLOCK_M2M) {
    console.warn(`[Guard] M2M API disabled: reject machine data-pull path=${path} ip=${clientIp(req)}`);
    res.set('Retry-After', '86400');
    return res.status(503).json({
      ok: false,
      error: 'External machine data-pull API is temporarily disabled. Only the web dashboard is available right now.',
      hint: 'Contact the dashboard owner if you need programmatic access.',
    });
  }

  const ip = clientIp(req);
  const now = Date.now();

  // --- (1) 单请求范围护栏 ---
  const days = rangeDays(req.query || {});
  if (days > CFG.MAX_RANGE_DAYS) {
    console.warn(`[Guard] range too large: ${days}d > ${CFG.MAX_RANGE_DAYS}d, path=${path} ip=${ip}`);
    return res.status(429).json({
      ok: false,
      error: `Date range too large: ${days} days (max ${CFG.MAX_RANGE_DAYS}). Split into smaller batches to avoid overloading the single-threaded server.`,
      maxRangeDays: CFG.MAX_RANGE_DAYS,
      hint: 'Fetch day-by-day or in <=' + CFG.MAX_RANGE_DAYS + '-day chunks, sequentially (not in parallel).',
    });
  }

  // --- (2) 每 IP 频率限制 ---
  let hits = ipHits.get(ip);
  if (!hits) { hits = []; ipHits.set(ip, hits); }
  pruneIp(hits, now);
  if (hits.length >= CFG.IP_RATE_PER_MIN) {
    const retryMs = IP_WINDOW_MS - (now - hits[0]);
    const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
    console.warn(`[Guard] IP rate limit: ${ip} ${hits.length}/${CFG.IP_RATE_PER_MIN} per min, path=${path}`);
    res.set('Retry-After', String(retrySec));
    return res.status(429).json({
      ok: false,
      error: `Rate limit: max ${CFG.IP_RATE_PER_MIN} heavy requests/min per IP. Slow down.`,
      retryAfterSeconds: retrySec,
      hint: 'Serialize requests and add a small delay between calls.',
    });
  }

  // --- (3a) 每 IP 并发闸（只限该 IP 自己，快速失败）---
  const ipInFlight = ipConcurrent.get(ip) || 0;
  if (ipInFlight >= CFG.PER_IP_CONCURRENT) {
    console.warn(`[Guard] per-IP concurrency cap: ${ip} ${ipInFlight}/${CFG.PER_IP_CONCURRENT} in-flight, reject path=${path}`);
    res.set('Retry-After', '2');
    return res.status(429).json({
      ok: false,
      error: `Too many concurrent heavy requests from your IP: ${CFG.PER_IP_CONCURRENT} already in flight. Send them one at a time (serialize).`,
      perIpConcurrent: CFG.PER_IP_CONCURRENT,
      retryAfterSeconds: 2,
      hint: 'Do NOT fire heavy requests in parallel; wait for each to finish before the next.',
    });
  }

  // --- (3b) 全局重接口并发闸（防多 IP 涌入打爆单线程，快速失败不排长队）---
  if (concurrent >= CFG.MAX_CONCURRENT) {
    console.warn(`[Guard] global concurrency cap: ${concurrent}/${CFG.MAX_CONCURRENT} in-flight, reject path=${path} ip=${ip}`);
    res.set('Retry-After', '2');
    return res.status(429).json({
      ok: false,
      error: `Server busy: ${CFG.MAX_CONCURRENT} heavy requests already in flight globally. Retry shortly.`,
      retryAfterSeconds: 2,
      hint: 'Do NOT fire heavy requests in parallel; send them one at a time.',
    });
  }

  // --- (3c) M2M 串行槽：机器取数（?key=/Authorization）全局最多 M2M_SERIAL_SLOTS 个真正执行，其余立刻 429 ---
  // 关键：外部 agent 常发「单日但本身很慢(~4s)的重请求」，跨度=1天绕过范围闸、频率也不高绕过频率闸；
  // 多个 4s 慢请求叠加会把单线程事件循环堵死数分钟。这一层强制机器取数彻底串行，从根上杜绝叠加。
  if (isM2M && m2mInFlight >= CFG.M2M_SERIAL_SLOTS) {
    console.warn(`[Guard] M2M serial cap: ${m2mInFlight}/${CFG.M2M_SERIAL_SLOTS} machine heavy req in-flight, reject path=${path} ip=${ip}`);
    res.set('Retry-After', '5');
    return res.status(429).json({
      ok: false,
      error: `Server is processing another machine request. Machine data pulls run strictly one at a time (serial). Retry in a few seconds.`,
      m2mSerialSlots: CFG.M2M_SERIAL_SLOTS,
      retryAfterSeconds: 5,
      hint: 'Send heavy requests strictly sequentially: wait for each response before the next. Do NOT parallelize.',
    });
  }

  // 通过所有闸门：记账并放行
  hits.push(now);
  concurrent++;
  ipConcurrent.set(ip, ipInFlight + 1);
  if (isM2M) m2mInFlight++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    concurrent = Math.max(0, concurrent - 1);
    if (isM2M) m2mInFlight = Math.max(0, m2mInFlight - 1);
    const cur = (ipConcurrent.get(ip) || 1) - 1;
    if (cur <= 0) ipConcurrent.delete(ip);
    else ipConcurrent.set(ip, cur);
  };

  // --- (4) 单请求硬超时：跑超过上限 → 掐断连接 + 释放并发 + 503 ---
  const timer = setTimeout(() => {
    if (released) return;
    console.warn(`[Guard] request timeout: ${CFG.REQUEST_TIMEOUT_MS}ms exceeded, path=${path} ip=${ip} — killing`);
    try {
      if (!res.headersSent) {
        res.status(503).json({
          ok: false,
          error: `Request timed out after ${Math.round(CFG.REQUEST_TIMEOUT_MS / 1000)}s and was terminated to protect the server.`,
          hint: 'Reduce the query size (fewer days / narrower scope) and avoid parallel heavy requests.',
        });
      }
    } catch (_) { /* ignore */ }
    // 强制掐断底层连接，确保挂住的请求不再占用资源
    try { req.destroy(); } catch (_) {}
    try { res.destroy(); } catch (_) {}
    release();
  }, CFG.REQUEST_TIMEOUT_MS);
  if (timer.unref) timer.unref();

  const releaseAndClear = () => { clearTimeout(timer); release(); };
  res.on('finish', releaseAndClear);
  res.on('close', releaseAndClear);
  next();
}

// 定期清理空 IP 桶，防内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of ipHits) {
    pruneIp(list, now);
    if (list.length === 0) ipHits.delete(ip);
  }
}, 5 * 60_000).unref();

module.exports = { apiGuard, CFG };
