import { requireApiAuth } from '@/lib/dashboard/auth';
import { getDateRange } from '@/lib/dashboard/dates';
import { withGuard } from '@/lib/dashboard/guard';
import { getRangeCache, rangeCacheTtl, setRangeCache } from '@/lib/dashboard/range-cache';
import type { AthenaItem, Snapshot, XmpItem } from '@/lib/dashboard/snapshots';
import { formatDate, loadDayData } from '@/lib/dashboard/snapshots';
import { loadXmpProductCostRange } from '@/lib/dashboard/xmp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RangeResponse {
  date: string;
  startDate: string;
  endDate: string;
  isRange: true;
  missingDates: string[];
  snapshots: Snapshot[];
}

/**
 * 用 adset 级 xmp_cache 加总出的 product 级消耗覆盖快照 xmp。
 * XMP 现由整点定时任务写 xmp_cache（adset 级）；product 级消耗与 channel-summary 同源，
 * 均从 adset 级加总得出。缓存缺失的历史日期回退快照里旧的 product 级 xmp（若有）。
 */
function overlayXmp(
  snapshotXmp: XmpItem[] | undefined,
  costByProduct: Map<string, number>,
): XmpItem[] {
  if (costByProduct.size > 0) {
    return [...costByProduct.entries()].map(([product, cost]) => ({ product, cost }));
  }
  return snapshotXmp ?? [];
}

/** GET /api/data：单日返回原始快照；多日聚合各产品 athena 收入与 xmp 花费。 */
export function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return Promise.resolve(auth);

  return withGuard(request, auth, async () => {
    const q = new URL(request.url).searchParams;
    const today = formatDate(new Date());
    const startDate = q.get('startDate') ?? q.get('date') ?? today;
    const endDate = q.get('endDate') ?? q.get('date') ?? today;
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      return Response.json({ error: 'Invalid date format' }, { status: 400 });
    }

    // 单日：保留原始快照结构，但 xmp 消耗改用 adset 级缓存加总（缺失回退快照旧值）。
    if (startDate === endDate) {
      const dayData = await loadDayData(startDate);
      const costByProduct = await loadXmpProductCostRange([startDate]);
      if (dayData.snapshots.length > 0) {
        const last = dayData.snapshots.at(-1);
        if (last) last.xmp = overlayXmp(last.xmp, costByProduct);
      } else if (costByProduct.size > 0) {
        // 快照尚未生成但已有 xmp 缓存：补一条仅含消耗的快照，避免消耗显示为空。
        dayData.snapshots.push({
          time: new Date().toISOString(),
          athena: [],
          xmp: overlayXmp([], costByProduct),
        });
      }
      return Response.json(dayData);
    }

    // 多日：跨区间聚合
    const cacheKey = `data|${startDate}|${endDate}`;
    const cached = getRangeCache(cacheKey, '');
    if (cached !== undefined) return Response.json(cached);

    const dates = getDateRange(startDate, endDate);
    const missingDates: string[] = [];
    const athenaAgg = new Map<string, AthenaItem>();
    const xmpAgg = new Map<string, XmpItem>();

    // XMP 消耗：整段区间一次性从 adset 级缓存按 product 加总（与 channel-summary 同源）。
    const costByProduct = await loadXmpProductCostRange(dates);
    for (const [product, cost] of costByProduct) {
      xmpAgg.set(product, { product, cost });
    }

    for (const d of dates) {
      const dayData = await loadDayData(d);
      if (dayData.snapshots.length === 0) {
        missingDates.push(d);
        continue;
      }
      const lastSnap = dayData.snapshots.at(-1);
      for (const a of lastSnap?.athena ?? []) {
        const cur = athenaAgg.get(a.product) ?? {
          product: a.product,
          totalRevenue: 0,
          newUserRevenue: 0,
        };
        cur.totalRevenue = (cur.totalRevenue ?? 0) + (a.totalRevenue ?? 0);
        cur.newUserRevenue = (cur.newUserRevenue ?? 0) + (a.newUserRevenue ?? 0);
        athenaAgg.set(a.product, cur);
      }
    }

    // 缓存整段无数据（如全历史、缓存已过期）时回退旧快照里的 product 级 xmp。
    if (costByProduct.size === 0) {
      for (const d of dates) {
        const dayData = await loadDayData(d);
        const lastSnap = dayData.snapshots.at(-1);
        for (const x of lastSnap?.xmp ?? []) {
          const cur = xmpAgg.get(x.product) ?? { product: x.product, cost: 0 };
          cur.cost = (cur.cost ?? 0) + (x.cost ?? 0);
          xmpAgg.set(x.product, cur);
        }
      }
    }

    const aggregatedSnapshot: Snapshot = {
      time: new Date().toISOString(),
      athena: [...athenaAgg.values()],
      xmp: [...xmpAgg.values()],
    };
    const response: RangeResponse = {
      date: endDate,
      startDate,
      endDate,
      isRange: true,
      missingDates,
      snapshots: [aggregatedSnapshot],
    };
    setRangeCache(cacheKey, response, '', rangeCacheTtl(endDate));
    return Response.json(response);
  });
}
