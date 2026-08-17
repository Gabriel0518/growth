/** 上报入参：query 参数或 JSON body，值可能是字符串/数字/布尔。 */
export type RawParams = Record<string, unknown>;

/** extractFields 的结构化输出（不含 source/payload/created_at）。 */
export interface ExtractedFields {
  app_id: string;
  event_name: string;
  event_time: string;
  revenue: number | null;
  currency: string;
  campaign: string;
  media_source: string;
  ad_id: string;
  adset: string;
  country: string;
  device_id: string;
  install_time: string;
  is_retargeting: number;
}

/**
 * 记录行元组 —— 严格对应 RECORD_COLUMNS 的 16 列顺序：
 * source, app_id, event_name, event_time, revenue, currency, campaign,
 * media_source, ad_id, adset, country, device_id, install_time,
 * is_retargeting, payload, created_at
 */
export type RecordRow = readonly [
  string,
  string,
  string,
  string,
  number | null,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  string,
];
