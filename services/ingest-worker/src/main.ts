import { currentTable } from '@agentic-ug/core';
import { RECORD_COLUMNS, closePool, getPool, ensureRecordTable, resolveDsn } from '@agentic-ug/db';
import type pg from 'pg';

/**
 * 上报批写 worker —— 复刻旧 dataserver/app.py:batch_writer() 的落库语义，
 * 消费源从内存 asyncio.Queue 改为 PG ingest_inbox。以「有界 Job」运行：
 * 轮询 inbox，有行就连续批写直到排空，空了则 sleep(POLL_IDLE_MS) 再查；
 * 运行满 MAX_RUNTIME_MS 后自动退出（由外部 CronJob 周期性重新拉起）。
 *
 * ⚠️ 历史坑：早期本进程「排空即退出」并被部署为 Deployment，退出即被 k8s 重启
 * → CrashLoopBackOff → inbox 只涨不落。现改为「定时退出」：单次运行有时间上限，
 * 到点干净退出（closePool 后进程结束），靠 CronJob 而非常驻进程维持周期消费。
 * 单轮异常不退出，仅记日志并退避后继续，避免单条毒行卡死整条管道。
 *
 * 每轮：事务内 DELETE ... FOR UPDATE SKIP LOCKED 取一批（≤BATCH_SIZE）→
 * 批量 INSERT 到当月表 records_YYYYMM → 派生 user_lookup（af_complete_registration
 * 且 payload 含整型 user_id，ON CONFLICT DO NOTHING）→ COMMIT。
 * 失败则 ROLLBACK，行留在 inbox 下轮重试（比旧内存队列更不易丢）。
 * 并发安全（SKIP LOCKED），但仍建议单实例。
 */

const BATCH_SIZE = 500;
// 空转轮询间隔（inbox 为空时）；有积压时不 sleep，连续排空。
const POLL_IDLE_MS = Number.parseInt(process.env['INGEST_POLL_MS'] ?? '3000', 10);
// 单轮异常后的退避，避免 DB 抖动/毒行导致的紧密错误循环刷屏。
const ERROR_BACKOFF_MS = Number.parseInt(process.env['INGEST_ERROR_BACKOFF_MS'] ?? '5000', 10);
// 单次运行时间上限；到点自动退出（默认 2 分钟），由外部 CronJob 周期性重拉。
const MAX_RUNTIME_MS = Number.parseInt(process.env['INGEST_MAX_RUNTIME_MS'] ?? '120000', 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 DSN 摘出 host:port/db 用于日志（隐去账号口令）。 */
function dsnLabel(): string {
  try {
    const u = new URL(resolveDsn());
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unparseable DSN)';
  }
}

const COLUMN_COUNT = RECORD_COLUMNS.length;
const USER_LOOKUP_COLUMNS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** inbox.row 必须是与 RECORD_COLUMNS 等长的数组元组。 */
function isRecordRow(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length === COLUMN_COUNT;
}

function buildRecordInsert(table: string, rowCount: number): string {
  const cols = RECORD_COLUMNS.join(', ');
  const tuples: string[] = [];
  let placeholder = 1;
  for (let i = 0; i < rowCount; i += 1) {
    const slots = Array.from({ length: COLUMN_COUNT }, () => `$${(placeholder++).toString()}`);
    tuples.push(`(${slots.join(', ')})`);
  }
  return `INSERT INTO ${table} (${cols}) VALUES ${tuples.join(', ')}`;
}

function buildUserLookupInsert(rowCount: number): string {
  const tuples: string[] = [];
  let placeholder = 1;
  for (let i = 0; i < rowCount; i += 1) {
    const slots = Array.from(
      { length: USER_LOOKUP_COLUMNS },
      () => `$${(placeholder++).toString()}`,
    );
    tuples.push(`(${slots.join(', ')})`);
  }
  return (
    `INSERT INTO user_lookup (user_id, app_id, event_time, install_time, payload, table_name) ` +
    `VALUES ${tuples.join(', ')} ON CONFLICT (user_id) DO NOTHING`
  );
}

/** 复刻 batch_writer 的 user_lookup 派生：嵌套解析 payload.event_value.user_id。 */
function deriveUserLookup(rows: readonly unknown[][], table: string): unknown[][] {
  const out: unknown[][] = [];
  for (const row of rows) {
    const eventName = row[2];
    const payload = row[14];
    if (eventName !== 'af_complete_registration' || typeof payload !== 'string' || !payload) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(payload);
      const eventValue = isRecord(parsed) ? parsed['event_value'] : undefined;
      if (typeof eventValue !== 'string' || !eventValue.includes('user_id')) continue;
      const inner: unknown = JSON.parse(eventValue);
      const uid = isRecord(inner) ? inner['user_id'] : undefined;
      if (typeof uid === 'number' && Number.isInteger(uid)) {
        out.push([uid, row[1], row[3], row[12], row[14], table]);
      }
    } catch {
      // 与旧版一致：payload 解析异常则跳过该行的 user_lookup 派生。
    }
  }
  return out;
}

/** 取一批并落库；返回本轮消费行数。 */
async function drainOnce(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query<{ row: unknown }>(
      `DELETE FROM ingest_inbox
       WHERE id IN (
         SELECT id FROM ingest_inbox ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       RETURNING row`,
      [BATCH_SIZE],
    );

    const consumed = deleted.rows.length;
    if (consumed === 0) {
      await client.query('COMMIT');
      return 0;
    }

    const rawRows = deleted.rows.map((r) => r.row);
    const valid = rawRows.filter((row): row is unknown[] => isRecordRow(row));
    const skipped = consumed - valid.length;
    if (skipped > 0) {
      // 形状不符（非 RECORD_COLUMNS 等长数组）的行会被丢弃——记下来以便排查上游写入格式。
      const sample = rawRows.find((r) => !isRecordRow(r));
      console.warn(
        `[worker] batch dropped ${skipped.toString()} malformed row(s); sample=${JSON.stringify(sample).slice(0, 300)}`,
      );
    }

    let lookupCount = 0;
    if (valid.length > 0) {
      const table = currentTable();
      await ensureRecordTable(client, table);
      await client.query(buildRecordInsert(table, valid.length), valid.flat());

      const lookups = deriveUserLookup(valid, table);
      lookupCount = lookups.length;
      if (lookups.length > 0) {
        await client.query(buildUserLookupInsert(lookups.length), lookups.flat());
      }
    }

    await client.query('COMMIT');
    console.log(
      `[worker] batch ok: consumed=${consumed.toString()} sunk=${valid.length.toString()} lookups=${lookupCount.toString()}`,
    );
    return consumed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

let shuttingDown = false;

/** 有界轮询：有积压连续排空，空了 sleep；运行满 MAX_RUNTIME_MS 或收到信号则退出。 */
async function main(): Promise<void> {
  const pool = getPool();
  const deadline = Date.now() + MAX_RUNTIME_MS;
  console.log(
    `[worker] started (DB=${dsnLabel()}, batch=${BATCH_SIZE.toString()}, idle=${POLL_IDLE_MS.toString()}ms, errBackoff=${ERROR_BACKOFF_MS.toString()}ms, maxRuntime=${MAX_RUNTIME_MS.toString()}ms)`,
  );

  let grandTotal = 0;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const consumed = await drainOnce(pool);
      if (consumed === 0) {
        // 空转：sleep 但不越过截止时刻，保证运行时长不超过 MAX_RUNTIME_MS。
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(POLL_IDLE_MS, remaining));
        continue;
      }
      grandTotal += consumed;
      if (grandTotal % 5000 < consumed) {
        console.log(`[worker] cumulative sunk≈${grandTotal.toString()} rows`);
      }
    } catch (error) {
      // 单轮失败（DB 抖动、毒行、建表/索引出错等）：记全上下文，退避后继续，避免整条管道停摆。
      console.error(
        `[worker] drain error (will retry in ${ERROR_BACKOFF_MS.toString()}ms):`,
        error,
      );
      await sleep(ERROR_BACKOFF_MS);
    }
  }

  await closePool();
  const reason = shuttingDown ? 'signal' : 'max-runtime';
  console.log(`[worker] exit (${reason}), ${grandTotal.toString()} rows sunk this run`);
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} received, draining current batch then exiting`);
    shuttingDown = true;
  });
}

try {
  await main();
} catch (error) {
  console.error('[worker] fatal:', error);
  process.exitCode = 1;
  // 释放连接池，否则事件循环不退出 → 进程挂起。
  await closePool();
}
