/**
 * 广告账户素材库（ad_account_material）—— FB adimages / advideos 同步。
 * 从 Facebook API 拉取广告账户下已有的图片和视频列表，写入本地表。
 */

import { query, queryOne } from '@agentic-ug/db';
import { FacebookClient } from '@agentic-ug/fetcher';

import { logger } from './logger';
import { getAdAccountConfig } from './token-service';

// ── 类型 ──

export interface AccountMaterialRow {
  id: number;
  channel: string;
  channel_account_id: string;
  channel_material_id: string;
  type: 'image' | 'video';
  name: string | null;
  url: string | null;
  thumbnail_url: string | null;
  status: string | null;
  width: number | null;
  height: number | null;
  length_ms: number | null;
  channel_extra: unknown;
  created_at: string;
  updated_at: string;
}

interface FbImage {
  hash: string;
  url?: string;
  width?: number;
  height?: number;
  name?: string;
  status?: string;
  created_time?: string;
  permalink_url?: string;
}

interface FbVideo {
  id: string;
  title?: string;
  description?: string;
  length?: number;
  source?: string;
  status?: string;
  created_time?: string;
  thumbnails?: { data?: { uri?: string }[] };
  picture?: string;
  width?: number;
  height?: number;
}

// ── 查询 ──

export async function listAccountMaterials(
  accountId: string,
  page = 1,
  pageSize = 24,
): Promise<{ data: AccountMaterialRow[]; total: number; page: number; pageSize: number }> {
  const countResult = await queryOne<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM ad_account_material WHERE channel_account_id = $1`,
    [accountId],
  );
  const total = Number.parseInt(countResult?.cnt ?? '0', 10);
  const offset = (page - 1) * pageSize;

  const rows = await query<AccountMaterialRow>(
    `SELECT id, channel, channel_account_id, channel_material_id, type, name, url,
            thumbnail_url, status, width, height, length_ms, channel_extra,
            to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
            to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
       FROM ad_account_material
      WHERE channel_account_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [accountId, pageSize, offset],
  );
  return { data: rows, total, page, pageSize };
}

// ── 同步 ──

export async function syncAccountMaterials(
  accountId: string,
): Promise<{ images: number; videos: number }> {
  const config = await getAdAccountConfig(accountId);
  if (!config) throw new Error(`未找到广告账户配置: ${accountId}`);

  const client = new FacebookClient(config.token);
  const actNum = accountId.replace(/^act_/, '');
  let imageCount = 0;
  let videoCount = 0;

  // 1. 同步图片
  logger.info(`[account-material] 开始同步图片 act_${actNum}`);
  try {
    const imgRes = await client.get<{ data?: FbImage[]; paging?: { next?: string } }>(
      `act_${actNum}/adimages`,
      { fields: 'hash,url,width,height,name,status,created_time,permalink_url', limit: '100' },
    );

    if (imgRes.data) {
      for (const img of imgRes.data) {
        await query(
          `INSERT INTO ad_account_material
             (channel, channel_account_id, channel_material_id, type, name, url, status, width, height, channel_extra)
           VALUES ('fb', $1, $2, 'image', $3, $4, $5, $6, $7, $8)
           ON CONFLICT (channel_material_id, channel_account_id) DO UPDATE
             SET name = EXCLUDED.name,
                 url = EXCLUDED.url,
                 status = EXCLUDED.status,
                 width = EXCLUDED.width,
                 height = EXCLUDED.height,
                 channel_extra = EXCLUDED.channel_extra,
                 updated_at = now()`,
          [
            accountId, img.hash, img.name ?? null, img.url ?? null,
            img.status ?? null, img.width ?? null, img.height ?? null,
            JSON.stringify(img),
          ],
        );
        imageCount++;
      }
    }
  } catch (error_: unknown) {
    logger.warn(`[account-material] 图片同步异常: ${error_ instanceof Error ? error_.message : String(error_)}`);
  }

  // 2. 同步视频
  logger.info(`[account-material] 开始同步视频 act_${actNum}`);
  try {
    const vidRes = await client.get<{ data?: FbVideo[]; paging?: { next?: string } }>(
      `act_${actNum}/advideos`,
      { fields: 'id,title,description,source,status,length,created_time,picture,width,height', limit: '100' },
    );

    if (vidRes.data) {
      for (const vid of vidRes.data) {
        const thumbUrl = vid.picture ?? null;
        await query(
          `INSERT INTO ad_account_material
             (channel, channel_account_id, channel_material_id, type, name, url, thumbnail_url, status, width, height, length_ms, channel_extra)
           VALUES ('fb', $1, $2, 'video', $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (channel_material_id, channel_account_id) DO UPDATE
             SET name = EXCLUDED.name,
                 url = EXCLUDED.url,
                 thumbnail_url = EXCLUDED.thumbnail_url,
                 status = EXCLUDED.status,
                 width = EXCLUDED.width,
                 height = EXCLUDED.height,
                 length_ms = EXCLUDED.length_ms,
                 channel_extra = EXCLUDED.channel_extra,
                 updated_at = now()`,
          [
            accountId, vid.id, vid.title ?? vid.description ?? null,
            vid.source ?? null, thumbUrl, vid.status ?? null,
            vid.width ?? null, vid.height ?? null,
            typeof vid.length === 'number' ? Math.round(vid.length * 1000) : null,
            JSON.stringify(vid),
          ],
        );
        videoCount++;
      }
    }
  } catch (error_: unknown) {
    logger.warn(`[account-material] 视频同步异常: ${error_ instanceof Error ? error_.message : String(error_)}`);
  }

  logger.info(`[account-material] 同步完成 act_${actNum}: ${String(imageCount)} images, ${String(videoCount)} videos`);
  return { images: imageCount, videos: videoCount };
}
