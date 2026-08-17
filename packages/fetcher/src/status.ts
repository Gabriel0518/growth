/**
 * 抓取状态 —— 复刻旧 dashboard/fetcher.js 的进程内 fetchStatus 对象。
 * 单进程内存 → 跨进程 PG fetch_status(kind,payload)：scheduler 写、/api/status 读、
 * /api/refresh 据 isFetching 判并发。字段与旧 getStatus() 逐字对齐。
 */

import { query, queryOne } from '@agentic-ug/db';

export type SourceStatus = 'idle' | 'fetching' | 'success' | 'error';

export interface SourceState {
  status: SourceStatus;
  lastSuccess: string | null;
  lastError: string | null;
  lastTime: string | null;
}

export interface ProxyHealth {
  checkedAt: string;
  ok: boolean;
  detail: string;
}

export interface FetchStatus {
  isFetching: boolean;
  /**
   * 本次抓取的加锁时刻（ISO）。设 isFetching=true 时写入，用于判定死锁残留。
   * 可选字段：读旧 payload（无此字段）时为 undefined，isFetchLockStale 视为过期以便自愈。
   */
  fetchStartedAt?: string | null;
  lastFetchTime: string | null;
  lastFetchSuccess: boolean | null;
  sources: { athena: SourceState; af: SourceState; xmp: SourceState };
  proxyHealth?: ProxyHealth;
}

/**
 * 抓取锁的最长有效期（毫秒）。超过此时长仍为 isFetching=true，判定为崩溃/被 kill 的
 * Job 残留的死锁，允许后续 Job 抢锁继续，避免整点抓取被永久卡死。
 */
export const FETCH_LOCK_TTL_MS = 5 * 60 * 1000;

function idleSource(): SourceState {
  return { status: 'idle', lastSuccess: null, lastError: null, lastTime: null };
}

/** 全 idle 的初始状态（对齐旧 fetchStatus 字面量）。 */
export function initialStatus(): FetchStatus {
  return {
    isFetching: false,
    lastFetchTime: null,
    lastFetchSuccess: null,
    sources: { athena: idleSource(), af: idleSource(), xmp: idleSource() },
  };
}

/**
 * 判断当前 isFetching 锁是否已“陈旧”（超时残留）。
 * - isFetching=false：无锁，返回 false。
 * - isFetching=true 且 fetchStartedAt 缺失/无法解析：视为陈旧（自愈，防旧数据或异常写入卡死）。
 * - isFetching=true 且距 fetchStartedAt 超过 FETCH_LOCK_TTL_MS：视为陈旧。
 */
export function isFetchLockStale(status: FetchStatus, now: number = Date.now()): boolean {
  if (!status.isFetching) return false;
  const started = status.fetchStartedAt ? Date.parse(status.fetchStartedAt) : Number.NaN;
  if (Number.isNaN(started)) return true;
  return now - started > FETCH_LOCK_TTL_MS;
}

/** 读取当前状态；无记录时返回全 idle 初始值（对齐旧首次 getStatus）。 */
export async function readFetchStatus(kind = 'main'): Promise<FetchStatus> {
  const row = await queryOne<{ payload: FetchStatus }>(
    'SELECT payload FROM fetch_status WHERE kind = $1',
    [kind],
  );
  return row?.payload ?? initialStatus();
}

/** 覆盖写入状态（upsert）。 */
export async function writeFetchStatus(status: FetchStatus, kind = 'main'): Promise<void> {
  await query(
    `INSERT INTO fetch_status (kind, payload, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (kind) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [kind, JSON.stringify(status)],
  );
}
