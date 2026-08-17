/**
 * AF 汇总（/api/af-summary）—— 复刻旧 dashboard/server.js。
 * 每产品三指标：实际收入（event_time 落在区间）、LTV 收入（install 与 event 同北京日、24h 内）、
 * 安装数（af_complete_registration）。区间为连续 UTC 窗口 [start.strLo, end.strHi)。
 * SQLite→PG：julianday 差*24（小时）→ EXTRACT(EPOCH ...)/3600；同日判定用 (::timestamp+8h)::date。
 */

import { query, queryOne } from '@agentic-ug/db';

import { beijingDayBounds, getTablesForRange } from './dates';
import { AF_UID_EXPR, buildDedupCountSql } from './dedup';
import { APP_ID_MAP } from './mapping';

export interface AfSummaryProduct {
  revenueActual: number;
  revenueLTV: number;
  installs: number;
}

interface RevRow {
  app_id: string | null;
  revenue: number;
}

interface InstallRow {
  app_id: string | null;
  installs: number;
}

/** 区间 AF 汇总：产品名 → 三指标。 */
export async function computeAfSummary(
  startDate: string,
  endDate: string,
): Promise<Record<string, AfSummaryProduct>> {
  const rangeStart = beijingDayBounds(startDate).strLo;
  const rangeEnd = beijingDayBounds(endDate).strHi;
  const result: Record<string, AfSummaryProduct> = {};

  const ensure = (p: string): AfSummaryProduct => {
    let cur = result[p];
    if (!cur) {
      cur = { revenueActual: 0, revenueLTV: 0, installs: 0 };
      result[p] = cur;
    }
    return cur;
  };

  const existingTables: string[] = [];
  for (const tableName of getTablesForRange(startDate, endDate)) {
    const exists = await queryOne<{ tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE tablename = $1',
      [tableName],
    );
    if (!exists) continue;
    existingTables.push(tableName);

    const actualRows = await query<RevRow>(
      `SELECT app_id, COALESCE(SUM(revenue), 0)::float8 as revenue
       FROM ${tableName}
       WHERE event_name = 'af_purchase' AND event_time >= $1 AND event_time < $2
       GROUP BY app_id`,
      [rangeStart, rangeEnd],
    );

    const ltvRows = await query<RevRow>(
      `SELECT app_id, COALESCE(SUM(revenue), 0)::float8 as revenue
       FROM ${tableName}
       WHERE event_name = 'af_purchase'
         AND install_time >= $1 AND install_time < $2
         AND event_time >= $3 AND event_time < $4
         AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 >= 0
         AND EXTRACT(EPOCH FROM (event_time::timestamp - install_time::timestamp)) / 3600 < 24
         AND (event_time::timestamp + interval '8 hours')::date
             = (install_time::timestamp + interval '8 hours')::date
       GROUP BY app_id`,
      [rangeStart, rangeEnd, rangeStart, rangeEnd],
    );

    for (const row of actualRows) {
      ensure(APP_ID_MAP[row.app_id ?? ''] ?? row.app_id ?? '').revenueActual += row.revenue;
    }
    for (const row of ltvRows) {
      ensure(APP_ID_MAP[row.app_id ?? ''] ?? row.app_id ?? '').revenueLTV += row.revenue;
    }
  }

  // AF 安装数（event_time 落区间）：跨月表 UNION ALL 后按 AF user_id 全局去重，再按 app_id 计数。
  // 必须移出上面的逐表循环——同一 user_id 若跨月重复上报，只算最早一次。
  if (existingTables.length > 0) {
    const params: string[] = [];
    const branches = existingTables.map((t, i) => {
      const a = params.push(rangeStart);
      const b = params.push(rangeEnd);
      return `SELECT app_id, event_time, id AS _rid, ${i.toString()} AS _tbl, ${AF_UID_EXPR} AS uid
        FROM ${t}
        WHERE event_name = 'af_complete_registration' AND event_time >= $${a.toString()} AND event_time < $${b.toString()}`;
    });
    const installRows = await query<InstallRow>(
      buildDedupCountSql(
        'app_id',
        'installs',
        'event_time, _tbl, _rid',
        branches.join(' UNION ALL '),
      ),
      params,
    );
    for (const row of installRows) {
      ensure(APP_ID_MAP[row.app_id ?? ''] ?? row.app_id ?? '').installs += row.installs;
    }
  }

  return result;
}
