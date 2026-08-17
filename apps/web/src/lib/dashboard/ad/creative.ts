/**
 * 广告创意业务逻辑 —— 创建创意、查询列表。
 */

import { query, queryOne } from '@agentic-ug/db';
import { createFbAdapter } from '@agentic-ug/fetcher';

import { getAdAccountConfig } from './token-service';

// ── Demo 固定文案模板 ──

const DEFAULT_TITLES = ['Singles nearby🫦', 'Ready to date?💞'];
const DEFAULT_BODIES = [
  'Dating in your town💞',
  "Find the love you're looking for",
  'Meet girls online!👇🏻',
];
const DEFAULT_CTA = 'INSTALL_MOBILE_APP';

// ── 类型 ──

export interface CreativeItem {
  id: number;
  channel: string;
  channel_creative_id: string | null;
  channel_material_id: string;
  page_id: string | null;
  ig_account_id: string | null;
  cta_type: string | null;
  titles: unknown;
  bodies: unknown;
  channel_extra: unknown;
  created_at: string;
}

export interface CreateCreativeInput {
  material_upload_id: string;
  page_id: string;
  ig_account_id?: string;
  titles?: string[];
  bodies?: string[];
  cta_type?: string;
}

// ── 查询 ──

export async function listCreatives(channel?: string): Promise<CreativeItem[]> {
  return query<CreativeItem>(
    `SELECT id, channel, channel_creative_id, channel_material_id,
            page_id, ig_account_id, cta_type, titles, bodies, channel_extra,
            to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM ad_creative
       ${channel ? 'WHERE channel = $1' : ''}
      ORDER BY created_at DESC`,
    channel ? [channel] : [],
  );
}

// ── 创建 ──

export async function createCreative(input: CreateCreativeInput & { accountId?: string }): Promise<CreativeItem> {
  // 1. 从素材 upload 记录拿 channel_material_id
  const upload = await queryOne<{
    channel_material_id: string | null;
    channel: string;
    material_id: string;
  }>(`SELECT channel_material_id, channel, material_id FROM ad_material_upload WHERE id = $1`, [
    input.material_upload_id,
  ]);
  if (!upload?.channel_material_id) {
    throw new Error('素材尚未同步到平台，请先上传');
  }
  if (upload.channel !== 'fb') {
    throw new Error(`Demo 阶段仅支持 FB，当前渠道: ${upload.channel}`);
  }

  // 2. 调 FB API 创建 creative
  if (!input.accountId) throw new Error('创建创意需要 accountId');
  const config = await getAdAccountConfig(input.accountId);
  if (!config) throw new Error(`未找到广告账户配置: ${input.accountId}`);
  const adapter = await createFbAdapter(config.token);
  const titles = input.titles ?? DEFAULT_TITLES;
  const bodies = input.bodies ?? DEFAULT_BODIES;
  const ctaType = input.cta_type ?? DEFAULT_CTA;
  const result = await adapter.createCreative({
    name: `Creative_${String(Date.now())}`,
    page_id: input.page_id,
    ...(input.ig_account_id === undefined ? {} : { ig_account_id: input.ig_account_id }),
    video_id: upload.channel_material_id,
    titles,
    bodies,
    cta_type: ctaType,
  });

  // 3. 写本地库
  const row = await queryOne<CreativeItem>(
    `INSERT INTO ad_creative (channel, channel_creative_id, channel_material_id,
                              page_id, ig_account_id, cta_type, titles, bodies, channel_extra)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, channel, channel_creative_id, channel_material_id,
               page_id, ig_account_id, cta_type, titles, bodies, channel_extra,
               to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
    [
      'fb',
      result.id,
      upload.channel_material_id,
      input.page_id,
      input.ig_account_id ?? null,
      ctaType,
      JSON.stringify(titles),
      JSON.stringify(bodies),
      JSON.stringify(result.channel_extra),
    ],
  );
  if (!row) throw new Error('创意创建失败');
  return row;
}
