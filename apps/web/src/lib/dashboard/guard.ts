/**
 * 重接口保护 —— 复刻旧 dashboard/api-guard.js。
 * 四层：绝对硬范围闸（含真人）→ 浏览器 session 豁免 → M2M 总闸 →
 * 单请求范围 / 每 IP 频率 / 每 IP 并发 / 全局并发 / M2M 串行槽 → 单请求硬超时。
 * 计数器为进程内单例（单副本部署下与旧版逐字对齐；多副本需外部化，见部署说明）。
 */

import type { Session } from './auth';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const CFG = {
  MAX_RANGE_DAYS: intEnv('GUARD_MAX_RANGE_DAYS', 14),
  HARD_MAX_RANGE_DAYS: intEnv('GUARD_HARD_MAX_RANGE_DAYS', 45),
  IP_RATE_PER_MIN: intEnv('GUARD_IP_RATE_PER_MIN', 30),
  PER_IP_CONCURRENT: intEnv('GUARD_PER_IP_CONCURRENT', 4),
  MAX_CONCURRENT: intEnv('GUARD_MAX_CONCURRENT', 8),
  REQUEST_TIMEOUT_MS: intEnv('GUARD_REQUEST_TIMEOUT_MS', 180_000),
  M2M_SERIAL_SLOTS: intEnv('GUARD_M2M_SERIAL_SLOTS', 1),
  BLOCK_M2M: (process.env['GUARD_BLOCK_M2M'] ?? '1') === '1',
};

const IP_WINDOW_MS = 60_000;

const ipHits = new Map<string, number[]>();
const ipConcurrent = new Map<string, number>();
let concurrent = 0;
let m2mInFlight = 0;

function jsonError(status: number, body: Record<string, unknown>, retryAfter?: string): Response {
  const headers = retryAfter === undefined ? undefined : { 'Retry-After': retryAfter };
  return Response.json(body, headers ? { status, headers } : { status });
}

function rangeDays(url: URL): number {
  const q = url.searchParams;
  const s = q.get('startDate') ?? q.get('date');
  const e = q.get('endDate') ?? q.get('date');
  if (!s || !e) return 1;
  const sd = Date.parse(`${s}T00:00:00Z`);
  const ed = Date.parse(`${e}T00:00:00Z`);
  if (Number.isNaN(sd) || Number.isNaN(ed)) return 1;
  return Math.floor((ed - sd) / 86_400_000) + 1;
}

function clientIp(request: Request): string {
  const xff = (request.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim();
  return xff !== undefined && xff !== '' ? xff : 'unknown';
}

function isM2MRequest(request: Request, url: URL): boolean {
  return url.searchParams.get('key') !== null || request.headers.get('authorization') !== null;
}

function pruneIp(list: number[], now: number): void {
  while (list.length > 0 && now - (list[0] ?? 0) > IP_WINDOW_MS) list.shift();
}

type GuardResult =
  | { kind: 'reject'; response: Response }
  | { kind: 'exempt' }
  | { kind: 'pass'; release: () => void };

/**
 * 进入重接口闸门。'reject' 已拒绝直接回客户端；'exempt' 浏览器 session 放行且不计账/不设超时；
 * 'pass' 放行且需在结束时 release() 并受硬超时保护。
 */
function enterGuard(request: Request, session: Session): GuardResult {
  const url = new URL(request.url);

  // (0) 绝对硬范围闸：对所有人（含真人 session）生效。
  const hardDays = rangeDays(url);
  if (hardDays > CFG.HARD_MAX_RANGE_DAYS) {
    return {
      kind: 'reject',
      response: jsonError(429, {
        ok: false,
        error: `Date range too large: ${hardDays.toString()} days exceeds the hard limit of ${CFG.HARD_MAX_RANGE_DAYS.toString()} days. A single query this large would freeze the server. Split it up.`,
        hardMaxRangeDays: CFG.HARD_MAX_RANGE_DAYS,
        hint: 'Split into smaller date chunks, even in the browser.',
      }),
    };
  }

  const isM2M = isM2MRequest(request, url);
  const isBrowserSession = session.authenticated && !isM2M;
  if (isBrowserSession) return { kind: 'exempt' };

  // (0) M2M 总闸
  if (isM2M && CFG.BLOCK_M2M) {
    return {
      kind: 'reject',
      response: jsonError(
        503,
        {
          ok: false,
          error:
            'External machine data-pull API is temporarily disabled. Only the web dashboard is available right now.',
          hint: 'Contact the dashboard owner if you need programmatic access.',
        },
        '86400',
      ),
    };
  }

  const ip = clientIp(request);
  const now = Date.now();

  // (1) 单请求范围护栏
  const days = rangeDays(url);
  if (days > CFG.MAX_RANGE_DAYS) {
    return {
      kind: 'reject',
      response: jsonError(429, {
        ok: false,
        error: `Date range too large: ${days.toString()} days (max ${CFG.MAX_RANGE_DAYS.toString()}). Split into smaller batches to avoid overloading the single-threaded server.`,
        maxRangeDays: CFG.MAX_RANGE_DAYS,
        hint: `Fetch day-by-day or in <=${CFG.MAX_RANGE_DAYS.toString()}-day chunks, sequentially (not in parallel).`,
      }),
    };
  }

  // (2) 每 IP 频率限制
  let hits = ipHits.get(ip);
  if (!hits) {
    hits = [];
    ipHits.set(ip, hits);
  }
  pruneIp(hits, now);
  if (hits.length >= CFG.IP_RATE_PER_MIN) {
    const retryMs = IP_WINDOW_MS - (now - (hits[0] ?? now));
    const retrySec = Math.max(1, Math.ceil(retryMs / 1000));
    return {
      kind: 'reject',
      response: jsonError(
        429,
        {
          ok: false,
          error: `Rate limit: max ${CFG.IP_RATE_PER_MIN.toString()} heavy requests/min per IP. Slow down.`,
          retryAfterSeconds: retrySec,
          hint: 'Serialize requests and add a small delay between calls.',
        },
        retrySec.toString(),
      ),
    };
  }

  // (3a) 每 IP 并发闸
  const ipInFlight = ipConcurrent.get(ip) ?? 0;
  if (ipInFlight >= CFG.PER_IP_CONCURRENT) {
    return {
      kind: 'reject',
      response: jsonError(
        429,
        {
          ok: false,
          error: `Too many concurrent heavy requests from your IP: ${CFG.PER_IP_CONCURRENT.toString()} already in flight. Send them one at a time (serialize).`,
          perIpConcurrent: CFG.PER_IP_CONCURRENT,
          retryAfterSeconds: 2,
          hint: 'Do NOT fire heavy requests in parallel; wait for each to finish before the next.',
        },
        '2',
      ),
    };
  }

  // (3b) 全局并发闸
  if (concurrent >= CFG.MAX_CONCURRENT) {
    return {
      kind: 'reject',
      response: jsonError(
        429,
        {
          ok: false,
          error: `Server busy: ${CFG.MAX_CONCURRENT.toString()} heavy requests already in flight globally. Retry shortly.`,
          retryAfterSeconds: 2,
          hint: 'Do NOT fire heavy requests in parallel; send them one at a time.',
        },
        '2',
      ),
    };
  }

  // (3c) M2M 串行槽
  if (isM2M && m2mInFlight >= CFG.M2M_SERIAL_SLOTS) {
    return {
      kind: 'reject',
      response: jsonError(
        429,
        {
          ok: false,
          error:
            'Server is processing another machine request. Machine data pulls run strictly one at a time (serial). Retry in a few seconds.',
          m2mSerialSlots: CFG.M2M_SERIAL_SLOTS,
          retryAfterSeconds: 5,
          hint: 'Send heavy requests strictly sequentially: wait for each response before the next. Do NOT parallelize.',
        },
        '5',
      ),
    };
  }

  // 通过所有闸门：记账
  hits.push(now);
  concurrent += 1;
  ipConcurrent.set(ip, ipInFlight + 1);
  if (isM2M) m2mInFlight += 1;

  let released = false;
  return {
    kind: 'pass',
    release: () => {
      if (released) return;
      released = true;
      concurrent = Math.max(0, concurrent - 1);
      if (isM2M) m2mInFlight = Math.max(0, m2mInFlight - 1);
      const cur = (ipConcurrent.get(ip) ?? 1) - 1;
      if (cur <= 0) ipConcurrent.delete(ip);
      else ipConcurrent.set(ip, cur);
    },
  };
}

function timeout503(): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(
        jsonError(503, {
          ok: false,
          error: `Request timed out after ${Math.round(CFG.REQUEST_TIMEOUT_MS / 1000).toString()}s and was terminated to protect the server.`,
          hint: 'Reduce the query size (fewer days / narrower scope) and avoid parallel heavy requests.',
        }),
      );
    }, CFG.REQUEST_TIMEOUT_MS).unref();
  });
}

/**
 * 包裹重接口处理逻辑：先过闸门，放行则在硬超时保护下执行 handler，结束释放并发计数。
 * 用法：`return withGuard(request, session, async () => { ... })`。
 */
export async function withGuard(
  request: Request,
  session: Session,
  handler: () => Promise<Response>,
): Promise<Response> {
  const gate = enterGuard(request, session);
  if (gate.kind === 'reject') return gate.response;
  if (gate.kind === 'exempt') return handler();
  try {
    return await Promise.race([handler(), timeout503()]);
  } finally {
    gate.release();
  }
}

/** 定期清理空 IP 桶，防内存泄漏。 */
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of ipHits) {
    pruneIp(list, now);
    if (list.length === 0) ipHits.delete(ip);
  }
}, 5 * 60_000).unref();
