import { buildRecordRow, pyStr, pyTruthy } from '@agentic-ug/core';
import type { RawParams } from '@agentic-ug/core';
import { query, queryOne } from '@agentic-ug/db';

/** 旧 dataserver 内存队列上限；PG inbox 超过则拒收（503）。 */
const QUEUE_MAXSIZE = 20_000;

/**
 * 复刻 Python `params.pop(a, None) or params.pop(b, None) or fallback` 的短路语义：
 * 逐个 key 弹出（存在即删除），返回首个真值的字符串化结果；命中即停，
 * 后续 key 不再弹出（保留在 params 中，随 payload 一起落库）。
 */
export function popFirst(params: RawParams, keys: readonly string[], fallback: string): string {
  for (const key of keys) {
    if (!(key in params)) continue;
    const value = params[key];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete params[key];
    if (pyTruthy(value)) return pyStr(value);
  }
  return fallback;
}

/** inbox 当前积压行数（对应旧 write_queue.qsize()）。 */
export async function queueSize(): Promise<number> {
  const row = await queryOne<{ count: number }>('SELECT COUNT(*)::int AS count FROM ingest_inbox');
  return row?.count ?? 0;
}

/**
 * 提取字段并写入 ingest_inbox；队列已满（≥QUEUE_MAXSIZE）返回 false。
 * row 以 JSONB 存 16 元组数组，供 ingest-worker 批量落库。
 */
/** 积压超过此值即告警：正常情况下 worker 应持续排空，持续高积压 = worker 未在消费。 */
const BACKLOG_WARN_AT = 2000;

export async function enqueue(
  source: string,
  params: RawParams,
  now: Date = new Date(),
): Promise<boolean> {
  const size = await queueSize();
  if (size >= QUEUE_MAXSIZE) return false;
  // 每千行且超过告警线时提示一次，避免逐条刷屏；持续增长说明 ingest-worker 没在下沉。
  if (size >= BACKLOG_WARN_AT && size % 1000 === 0) {
    console.warn(`[ingest] inbox backlog=${size.toString()} (worker 可能未在消费 ingest_inbox)`);
  }
  const record = buildRecordRow(source, params, now);
  await query('INSERT INTO ingest_inbox (row) VALUES ($1::jsonb)', [JSON.stringify(record)]);
  return true;
}
