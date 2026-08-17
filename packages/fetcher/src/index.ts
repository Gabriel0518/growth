export { fetchAll } from './fetcher.js';
export type { AthenaItem, AthenaResult, XmpSummaryItem } from './fetcher.js';
export { fetchFeishuDailyReport } from './feishu-daily-report.js';
export { fetchCreativeAll } from './creative.js';
export { fetchCorrectionFactorsDaily } from './correction.js';
export { fetchDauDaily } from './dau.js';
export type { DauItem } from './dau.js';
export {
  FETCH_LOCK_TTL_MS,
  initialStatus,
  isFetchLockStale,
  readFetchStatus,
  writeFetchStatus,
} from './status.js';
export type { FetchStatus, SourceState, SourceStatus, ProxyHealth } from './status.js';

// ── 广告渠道适配层 ──
export { FacebookClient } from './channels/facebook/client.js';
export { createFbAdapter, getAdapter, getFbAdapter } from './channels/index.js';
export type { ChannelAdapter } from './channels/index.js';
export { queryAdAccounts, queryBusinessManager, validateToken } from './channels/facebook/token.js';
export type {
  Ad,
  AdAccount,
  AdSet,
  AvailablePage,
  BrandedContentPermission,
  Campaign,
  Channel,
  ChannelMaterial,
  CreateAdSetInput,
  CreateAdInput,
  CreateCampaignInput,
  CreateCreativeInput,
  Creative,
  MaterialStatus,
  UpdateCampaignInput,
} from './channels/types.js';
