/**
 * 修正系数每日持久化（写侧）—— 每日 job 算一次「前一天」的修正系数并 upsert 进
 * daily_snapshots(kind='correction', date=<数据日>)，永久留存，供对外接口 + 看板只读。
 *
 * 计算逻辑与映射表全部来自 @agentic-ug/core 的唯一真源，本文件只负责调度与落库。
 * 读侧是 apps/web/src/lib/dashboard/correction-factors.ts（持久化优先、缺失现算兜底）。
 * 两侧曾各存一份实现并靠注释约定「必须逐字一致」维护，实际漂移过——详见
 * packages/core/src/correction.ts 头注释。现在新增产品只需改 core 一处。
 */

import { computeCorrectionFactors } from '@agentic-ug/core';
import { query, queryOne } from '@agentic-ug/db';

/** 北京时间「昨天」YYYY-MM-DD（纯 epoch 偏移）。 */
function yesterdayBeijing(): string {
  return new Date(Date.now() + 8 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
}

/**
 * 每日一次：算「前一天」的修正系数并 upsert 进 daily_snapshots(kind='correction')，永久留存。
 * date 为 null 时取昨天（北京）。ON CONFLICT (kind,date) DO UPDATE 幂等，重跑安全，
 * 可直接用于历史回填。
 */
export async function fetchCorrectionFactorsDaily(
  date: string | null = null,
): Promise<{ date: string; products: number }> {
  const dataDate = date ?? yesterdayBeijing();
  const factors = await computeCorrectionFactors(dataDate, { query, queryOne });
  await query(
    `INSERT INTO daily_snapshots (kind, date, payload)
     VALUES ('correction', $1, $2::jsonb)
     ON CONFLICT (kind, date) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [dataDate, JSON.stringify(factors)],
  );
  const products = Object.keys(factors).length;
  console.log(
    `[Fetcher] Correction factors persisted for ${dataDate}: ${products.toString()} products`,
  );
  return { date: dataDate, products };
}
