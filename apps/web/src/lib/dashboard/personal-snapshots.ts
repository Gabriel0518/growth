/**
 * 个人面板按日快照的读写与持久化结构 —— 复刻旧 server.js 的 personal-{date}.json。
 * 文件 → PG：统一存入 daily_snapshots(kind='personal')，payload 内含 _meta（type/savedAt）。
 */

import { query, queryOne } from '@agentic-ug/db';

export interface PersonalAd {
  ad: string;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
}

export interface PersonalAdset {
  adset: string;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  cost: number;
  impressions: number;
  clicks: number;
  adsetIds?: string[];
  ads: PersonalAd[];
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
}

export interface PersonalCampaign {
  campaign: string;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  cost: number;
  impressions: number;
  clicks: number;
  installs: number;
  campaignIds?: string[];
  adsets: PersonalAdset[];
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
}

export interface PersonalChannel {
  channel: string;
  count: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  cost: number;
  cpm: number | null;
  cpc: number | null;
  campaigns: PersonalCampaign[];
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
}

export interface PersonalProduct {
  product: string;
  count: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  cost: number;
  channels: PersonalChannel[];
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
}

export interface PersonalOperator {
  operator: string;
  count: number;
  cost: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  products: PersonalProduct[];
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
}

export interface PersonalSummary {
  count: number;
  revenue: number;
  newUserRevenue: number;
  deductedRevenue?: number;
  correctedRevenue?: number;
  correctedNewUserRevenue?: number;
  correctedDeductedRevenue?: number;
}

export interface PersonalResponse {
  date: string;
  startDate?: string;
  endDate?: string;
  isRange?: boolean;
  missingDates?: string[];
  operators: PersonalOperator[];
  organic: PersonalSummary;
  restricted?: PersonalSummary;
}

export interface SnapshotMeta {
  type: 'complete' | 'partial';
  savedAt?: string;
  upgradedFrom?: string;
}

export type PersonalSnapshot = PersonalResponse & { _meta?: SnapshotMeta };

/** 读个人快照（含 _meta）；无则 null。 */
export async function loadPersonalSnapshot(dateStr: string): Promise<PersonalSnapshot | null> {
  const row = await queryOne<{ payload: PersonalSnapshot }>(
    "SELECT payload FROM daily_snapshots WHERE kind = 'personal' AND date = $1",
    [dateStr],
  );
  return row?.payload ?? null;
}

/** 写个人快照：包裹 _meta（含 savedAt）后 upsert。 */
export async function savePersonalSnapshot(
  dateStr: string,
  data: PersonalResponse,
  meta: SnapshotMeta,
): Promise<void> {
  const snapshot: PersonalSnapshot = {
    _meta: { ...meta, savedAt: new Date().toISOString() },
    ...data,
  };
  await query(
    `INSERT INTO daily_snapshots (kind, date, payload)
     VALUES ('personal', $1, $2::jsonb)
     ON CONFLICT (kind, date) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [dateStr, JSON.stringify(snapshot)],
  );
  console.log(`[Snapshot] Saved personal snapshot for ${dateStr} (${meta.type})`);
}
