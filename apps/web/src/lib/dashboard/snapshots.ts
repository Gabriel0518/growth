/**
 * 按日快照读取 —— 替代旧 fetcher.js 的 data/{date}.json 文件读。
 * 统一从 PG daily_snapshots（kind='main' 对应旧 {date}.json）取原始 JSONB blob。
 */

import { query, queryOne } from '@agentic-ug/db';

export interface AthenaItem {
  product: string;
  totalRevenue?: number;
  newUserRevenue?: number;
}

export interface XmpItem {
  product: string;
  cost?: number;
}

export interface Snapshot {
  time?: string;
  athena?: AthenaItem[];
  xmp?: XmpItem[];
}

export interface DayData {
  date: string;
  snapshots: Snapshot[];
}

/** 单日 main 快照；无则返回空壳（复刻 loadDayData 缺文件回退）。 */
export async function loadDayData(date: string): Promise<DayData> {
  const row = await queryOne<{ payload: DayData }>(
    "SELECT payload FROM daily_snapshots WHERE kind = 'main' AND date = $1",
    [date],
  );
  return row?.payload ?? { date, snapshots: [] };
}

/** 所有已入库的 main 日期，倒序（复刻 getAvailableDates 的 sort().reverse()）。 */
export async function getAvailableDates(): Promise<string[]> {
  const rows = await query<{ date: string }>(
    "SELECT date FROM daily_snapshots WHERE kind = 'main' ORDER BY date DESC",
  );
  return rows.map((r) => r.date);
}

/**
 * 某时刻所属的【北京】自然日 YYYY-MM-DD。
 *
 * 原实现取运行环境本地时区分量，而部署镜像未设 TZ（容器内为 UTC），于是北京 00:00–08:00
 * 期间会算成前一天，快照读写错位。改为 epoch 偏移 +8h 取 UTC 分量，与系统时区解耦
 * （同 dashboard/dates.ts 的 todayBeijing）。
 */
export function formatDate(date: Date): string {
  return new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}
