/**
 * 注册事件按 user_id 去重（做法B：仅在查询范围内跨天/跨月去重）——复刻旧 server.js buildDedupCountSql。
 * 同一 user_id 只保留 event_time 最早一条（并列用 _tbl 月序 + _rid 兜底取唯一）；
 * 无 user_id 的行（约 20% 自然量）全部保留、每条各计一次。
 * uid 提取表达式 AF_UID_EXPR/AD_UID_EXPR 由 @agentic-ug/db 统一提供，与月表局部索引同源。
 */

export { AF_UID_EXPR, AD_UID_EXPR } from '@agentic-ug/db';

/**
 * 构造去重计数 SQL（PG 版）。
 *   groupCols : 分组列（同时是最外层 SELECT/GROUP BY 列），如 'campaign' 或 'media_source, app_id'；'' 表示不分组（单值 COUNT）。
 *   cntAlias  : 计数列别名。
 *   timeOrder : ROW_NUMBER 内取「最早」的排序表达式。AF 用 'event_time, _tbl, _rid'（ISO 文本可直接排序）；
 *               AD 用 'event_time::bigint, _tbl, _rid'（unix 秒文本先转 bigint）。
 *   innerFrom : 内层 FROM+WHERE 子查询（单表或多月表 UNION ALL），须 SELECT 出 groupCols/event_time/uid，
 *               并提供 _rid（= id）、_tbl（月序）；跨月 UNION 时二者保证并列排序全局唯一。
 */
export function buildDedupCountSql(
  groupCols: string,
  cntAlias: string,
  timeOrder: string,
  innerFrom: string,
): string {
  const gcSel = groupCols ? `${groupCols},` : '';
  const gcGrp = groupCols ? `GROUP BY ${groupCols}` : '';
  return `
    SELECT ${gcSel} COUNT(*)::int as ${cntAlias} FROM (
      SELECT ${gcSel}
        CASE
          WHEN uid IS NULL THEN 1
          WHEN ROW_NUMBER() OVER (PARTITION BY uid ORDER BY ${timeOrder}) = 1 THEN 1
          ELSE 0 END AS keep
      FROM ( ${innerFrom} ) sub
    ) dd WHERE keep = 1
    ${gcGrp}
  `;
}
