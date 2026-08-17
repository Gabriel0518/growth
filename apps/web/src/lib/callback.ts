import type { RawParams } from '@agentic-ug/core';

import { enqueue, popFirst } from './ingest';

/** 日志用：截断字符串化任意上报字段，避免超长 payload 刷屏。 */
function brief(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/**
 * 复刻 dataserver 的 /adjust、/appsflyer 落库分支：一次投递可能含多条记录（AF Push 数组）。
 * 逐条按优先级选 source、打 _platform 标记、入队。任一条队列满 → 503，入队异常 → 500，
 * 全部成功 → 202（附已入队条数）。全链路打点：入站(平台/来源/关键字段) → 入队结果，
 * 便于定位「配了回调但没数据」。
 */
export async function ingestCallbackBatch(
  records: readonly RawParams[],
  sourceKeys: readonly string[],
  fallback: string,
  platform: string,
): Promise<Response> {
  let queued = 0;
  let source = fallback;

  for (const params of records) {
    source = popFirst(params, sourceKeys, fallback);
    params['_platform'] = platform;

    // 入站打点：即便下游落库出问题，也能确认平台回调确实打到了本服务。
    console.log(
      `[callback] in platform=${platform} source=${brief(source)} ` +
        `event=${brief(params['event_name'] ?? params['event'])} ` +
        `app_id=${brief(params['app_id'] ?? params['bundle_id'])} ` +
        `event_time=${brief(params['event_time'] ?? params['created_at'])} keys=${Object.keys(params).length.toString()}`,
    );

    try {
      if (!(await enqueue(source, params))) {
        console.warn(
          `[callback] queue full, rejected platform=${platform} source=${brief(source)}`,
        );
        return Response.json({ detail: '队列已满', queued }, { status: 503 });
      }
    } catch (error) {
      // 入队失败几乎必是 DB 不可达/写入报错——务必落日志，否则前端只见到无声 500。
      console.error(
        `[callback] enqueue failed platform=${platform} source=${brief(source)}:`,
        error,
      );
      return Response.json({ detail: 'enqueue failed', queued }, { status: 500 });
    }
    queued += 1;
  }

  return Response.json({ status: 'queued', source, queued }, { status: 202 });
}
