/**
 * sitin.ai 客户门户（/demo）的小时级缓存。
 *
 * 为什么要缓存：buildPartnershipOverview 一次要打数十个 FB Graph 请求（结构 + 三个粒度的
 * insights + 两个品牌的授权名单），秒级耗时且吃 FB 调用配额。门户是给客户随便刷的页面，
 * 不能每次打开都重算——按屹恒的要求，只读数据**每小时更新一次**。
 *
 * 存储直接复用 daily_snapshots（主键 kind+date），不新建表：kind='demo_partnership'，
 * date 取北京日，payload 存整份聚合结果。跨副本、跨重启都在，比进程内 Map 稳。
 *
 * 刷新是**惰性**的：请求进来发现过期才重算，不挂 cron。好处是没人看时不空跑 FB 调用；
 * 代价是过期后第一个请求要等一次全量取数（数秒）。要改成整点预热，加一个调 refresh 的
 * CronJob 即可，缓存逻辑不用动。
 */

import { query, queryOne } from '@agentic-ug/db';

import { buildPartnershipOverview, resolveRange } from '@/lib/demo/partnership';
import type { DemoRange } from '@/lib/demo/partnership';
import type { DemoOverview } from '@/lib/demo/types';

const SNAPSHOT_KIND = 'demo_partnership';

/** 缓存有效期：1 小时（屹恒定的「只读数据每小时更新一次」）。 */
const TTL_MS = 3600 * 1000;

/**
 * 进程内的在途重算去重：同一副本上多个请求同时撞到同一区间的过期缓存时，只让第一个真去算，
 * 其余等它。按区间键分桶（不同日期区间是不同的取数），多副本下最多各算一次，可接受。
 */
const inFlight = new Map<string, Promise<DemoOverview>>();

/** 区间 → 缓存主键的 date 段。区间即缓存粒度：默认 14 天与自定义区间各存各的。 */
function cacheKeyOf(range: DemoRange): string {
  return `${range.start}~${range.end}`;
}

interface CacheRow {
  payload: DemoOverview;
  updated_at: string;
}

async function readCache(date: string): Promise<CacheRow | null> {
  const row = await queryOne<CacheRow>(
    `SELECT payload, updated_at FROM daily_snapshots WHERE kind = $1 AND date = $2`,
    [SNAPSHOT_KIND, date],
  );
  return row ?? null;
}

async function writeCache(date: string, payload: DemoOverview): Promise<void> {
  await query(
    `INSERT INTO daily_snapshots (kind, date, payload, updated_at)
          VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (kind, date)
     DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [SNAPSHOT_KIND, date, JSON.stringify(payload)],
  );
}

export interface CachedOverview {
  data: DemoOverview;
  /** 这份数据实际算出来的时刻（ISO），前端显示「数据更新于」。 */
  cachedAt: string;
  /** 本次是否命中缓存（未重算）。 */
  fromCache: boolean;
}

/**
 * 取门户数据：缓存未过期直接返回，过期则重算并回写。按传入区间分别缓存（默认 14 天）。
 * force=true 跳过 TTL 强制重算（供手动刷新 / 预热用）。
 */
export async function getPartnershipOverview(
  force = false,
  rawRange?: Partial<DemoRange>,
): Promise<CachedOverview> {
  const range = resolveRange(rawRange);
  const key = cacheKeyOf(range);

  if (!force) {
    const cached = await readCache(key);
    if (cached !== null) {
      const age = Date.now() - Date.parse(cached.updated_at);
      if (age < TTL_MS) {
        return { data: cached.payload, cachedAt: cached.updated_at, fromCache: true };
      }
    }
  }

  let pending = inFlight.get(key);
  if (pending === undefined) {
    pending = buildPartnershipOverview(range)
      .then(async (fresh) => {
        await writeCache(key, fresh);
        return fresh;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, pending);
  }

  try {
    const data = await pending;
    return { data, cachedAt: data.updatedAt, fromCache: false };
  } catch (error) {
    // 重算失败时宁可回过期数据也别给客户一个白页；连过期数据都没有才真报错。
    const stale = await readCache(key);
    if (stale !== null) {
      return { data: stale.payload, cachedAt: stale.updated_at, fromCache: true };
    }
    throw error;
  }
}
