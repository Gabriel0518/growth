import { formatTimestamp } from './tables.js';
import type { ExtractedFields, RawParams, RecordRow } from './types.js';

/**
 * Python 真值语义：None/False/0/""（空串）为假，其余为真。
 * 保留旧行为的怪癖，例如字符串 "false" 视为真值。
 */
export function pyTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  return true;
}

/** str(v)：与 Python str() 对齐的字符串化（用于最终写入 TEXT 列）。 */
export function pyStr(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  return JSON.stringify(v);
}

/** 复刻 `a or b or c`：返回首个真值的字符串化结果，全假则空串。 */
function firstTruthy(...vals: unknown[]): string {
  for (const v of vals) {
    if (pyTruthy(v)) return pyStr(v);
  }
  return '';
}

/**
 * 从上报 payload 中提取结构化字段 —— 逐字复刻 dataserver/app.py:extract_fields。
 * 优先使用已换算的 USD 值，避免非美元币种原始值被当作 USD。
 */
export function extractFields(source: string, params: RawParams): ExtractedFields {
  const appId = firstTruthy(params['app_id'], params['bundle_id'], params['app_name']);
  const eventName = firstTruthy(params['event_name'], params['event']);
  const eventTime = firstTruthy(params['event_time'], params['created_at']);

  const rawCurrency = firstTruthy(params['event_revenue_currency'], params['currency']) || 'USD';
  const eventRevenueUsd = params['event_revenue_usd'];
  const eventRevenueRaw = firstTruthy(params['event_revenue'], params['revenue']);

  let revenueStr: string;
  let currency: string;
  if (
    eventRevenueUsd !== undefined &&
    eventRevenueUsd !== null &&
    pyStr(eventRevenueUsd).trim().length > 0
  ) {
    revenueStr = pyStr(eventRevenueUsd);
    currency = 'USD';
  } else {
    revenueStr = eventRevenueRaw ? pyStr(eventRevenueRaw) : '';
    currency = rawCurrency;
  }

  const campaign = firstTruthy(params['campaign']);
  const mediaSource = source;
  const adId = firstTruthy(params['af_ad_id'], params['adgroup_id']);
  const adset = firstTruthy(params['af_adset'], params['adset']);
  const country = firstTruthy(params['country_code'], params['country']);
  const deviceId = firstTruthy(params['advertising_id'], params['idfa'], params['gps_adid']);
  const installTime = firstTruthy(params['install_time']);
  const isRetargeting = pyTruthy(params['is_retargeting']) ? 1 : 0;

  let revenue: number | null = null;
  if (revenueStr) {
    const parsed = Number(revenueStr);
    revenue = Number.isFinite(parsed) ? parsed : null;
  }

  return {
    app_id: appId,
    event_name: eventName,
    event_time: eventTime,
    revenue,
    currency,
    campaign,
    media_source: mediaSource,
    ad_id: adId,
    adset,
    country,
    device_id: deviceId,
    install_time: installTime,
    is_retargeting: isRetargeting,
  };
}

/**
 * 构造记录行元组 —— 复刻 enqueue_record：提取字段 + payload JSON + created_at。
 * 返回顺序严格对应 RECORD_COLUMNS。
 */
export function buildRecordRow(
  source: string,
  params: RawParams,
  now: Date = new Date(),
): RecordRow {
  const fields = extractFields(source, params);
  const payloadJson = Object.keys(params).length > 0 ? JSON.stringify(params) : '{}';
  const ts = formatTimestamp(now);

  return [
    source,
    fields.app_id,
    fields.event_name,
    fields.event_time,
    fields.revenue,
    fields.currency,
    fields.campaign,
    fields.media_source,
    fields.ad_id,
    fields.adset,
    fields.country,
    fields.device_id,
    fields.install_time,
    fields.is_retargeting,
    payloadJson,
    ts,
  ];
}
