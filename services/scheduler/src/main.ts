/**
 * 定时抓取 Job —— 复刻旧 dashboard/server.js 的 scheduleSummary 单次触发。
 * 由 k8s CronJob 每整点 :00（Asia/Shanghai）拉起，运行一次 fetchAll 后退出；
 * 北京 0 点自动抓昨日收尾（分支逻辑在 fetchAll 内按北京时刻判定），结果落
 * PG daily_snapshots。调度改由 CronJob 承担，故无需常驻进程与自纠正 setTimeout。
 *
 * 说明：XMP 缓存的周期预热（旧 :05 warm / 00:50 昨日回填）暂缓——xmp_cache 由
 * web 请求按需惰性填充（3 天 TTL），预热仅是延迟优化，非正确性所需。
 */

import { closePool, ensureDashboardTables, getPool } from '@agentic-ug/db';
import {
  fetchAll,
  fetchCorrectionFactorsDaily,
  fetchCreativeAll,
  fetchDauDaily,
} from '@agentic-ug/fetcher';

/** 北京当前小时（0-23）。 */
function nowBeijingHour(): number {
  return new Date(Date.now() + 8 * 3_600_000).getUTCHours();
}

try {
  await ensureDashboardTables(getPool());
  console.log('[Scheduler] Running summary fetch...');
  await fetchAll();
  console.log('[Scheduler] Summary fetch done');

  if (nowBeijingHour() === 1) {
    console.log('[Scheduler] Running creative/aigc fetch...');
    await fetchCreativeAll();
    console.log('[Scheduler] Creative/aigc fetch done');

    console.log('[Scheduler] Persisting yesterday correction factors...');
    const corr = await fetchCorrectionFactorsDaily();
    console.log(
      `[Scheduler] Correction factors done for ${corr.date} (${corr.products.toString()} products)`,
    );

    console.log('[Scheduler] Fetching DAU...');
    const dau = await fetchDauDaily();
    console.log(`[Scheduler] DAU done for ${dau.date} (${dau.products.toString()} products)`);
  }

  // 日报功能已于 2026-07-23 迁移至 Web 前端看板（/daily-report 面板），
  // 不再通过飞书文档写入。每日 personal/correction/dau/main 快照仍由 1 点 cron 生成。
  // 参见「全自动投手日报」知识空间。
  // 若未来需其他自动处理，在此补充。
} catch (error) {
  console.error(`[Scheduler] Fatal: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
