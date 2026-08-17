/**
 * 素材库业务逻辑 —— 通用素材表 CRUD + 平台同步。
 */

import { query, queryOne } from '@agentic-ug/db';
import { createFbAdapter } from '@agentic-ug/fetcher';

import { logger } from './logger';
import { getAdAccountConfig } from './token-service';

// ── 类型 ──

export interface MaterialItem {
  id: number;
  name: string;
  file_url: string | null;
  source_type: string;
  mime_type: string | null;
  duration_ms: number | null;
  app_product: string | null;
  tags: unknown;
  creator: string | null;
  created_at: string;
}

export interface MaterialUploadItem {
  id: number;
  material_id: number;
  channel: string;
  channel_material_id: string | null;
  channel_thumbnail_url: string | null;
  status: string;
  channel_extra: unknown;
  uploaded_at: string;
}

export interface MaterialWithUploads extends MaterialItem {
  uploads: MaterialUploadItem[];
}

// ── 查询 ──

export async function listMaterials(channel?: string): Promise<MaterialWithUploads[]> {
  const rows = await query<MaterialItem>(
    `SELECT id, name, file_url, source_type, mime_type, duration_ms,
            app_product, tags, creator,
            to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM ad_material
      ORDER BY created_at DESC`,
  );

  const results: MaterialWithUploads[] = [];
  for (const m of rows) {
    const uploads = await query<MaterialUploadItem>(
      `SELECT id, material_id, channel, channel_material_id, channel_thumbnail_url,
              status, channel_extra,
              to_char(uploaded_at, 'YYYY-MM-DD HH24:MI:SS') AS uploaded_at
         FROM ad_material_upload
        WHERE material_id = $1
        ${channel ? 'AND channel = $2' : ''}
        ORDER BY uploaded_at DESC`,
      channel ? [m.id, channel] : [m.id],
    );
    results.push({ ...m, uploads });
  }
  return results;
}

export async function getMaterial(id: number): Promise<MaterialWithUploads | undefined> {
  const m = await queryOne<MaterialItem>(
    `SELECT id, name, file_url, source_type, mime_type, duration_ms,
            app_product, tags, creator,
            to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM ad_material WHERE id = $1`,
    [id],
  );
  if (!m) return undefined;
  const uploads = await query<MaterialUploadItem>(
    `SELECT id, material_id, channel, channel_material_id, channel_thumbnail_url,
            status, channel_extra,
            to_char(uploaded_at, 'YYYY-MM-DD HH24:MI:SS') AS uploaded_at
       FROM ad_material_upload
      WHERE material_id = $1
      ORDER BY uploaded_at DESC`,
    [id],
  );
  return { ...m, uploads };
}

// ── 写入 ──

export interface RegisterMaterialInput {
  file_url: string;
  name: string;
  app_product?: string;
  mime_type?: string;
  creator?: string;
}

export async function registerMaterial(input: RegisterMaterialInput): Promise<MaterialItem> {
  const row = await queryOne<MaterialItem>(
    `INSERT INTO ad_material (name, file_url, app_product, mime_type, creator)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, file_url, source_type, mime_type, duration_ms,
               app_product, tags, creator,
               to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
    [
      input.name,
      input.file_url,
      input.app_product ?? null,
      input.mime_type ?? null,
      input.creator ?? null,
    ],
  );
  if (!row) throw new Error('素材创建失败');
  return row;
}

// ── 平台同步 ──

export interface SyncMaterialInput {
  channel: 'fb' | 'tt' | 'gg';
}

export async function syncMaterialToChannel(
  materialId: number,
  channel: string,
  accountId?: string,
): Promise<MaterialUploadItem> {
  const material = await queryOne<{ file_url: string | null; name: string }>(
    `SELECT file_url, name FROM ad_material WHERE id = $1`,
    [materialId],
  );
  if (!material?.file_url) throw new Error('素材无 file_url，无法上传');

  // 创建 upload 记录，初始状态 uploading
  const upload = await queryOne<MaterialUploadItem>(
    `INSERT INTO ad_material_upload (material_id, channel, status)
     VALUES ($1, $2, 'uploading')
     RETURNING id, material_id, channel, channel_material_id, channel_thumbnail_url,
               status, channel_extra,
               to_char(uploaded_at, 'YYYY-MM-DD HH24:MI:SS') AS uploaded_at`,
    [materialId, channel],
  );
  if (!upload) throw new Error('创建 upload 记录失败');

  // 调平台 API 上传
  if (!accountId) throw new Error('同步素材需要 accountId');
  const config = await getAdAccountConfig(accountId);
  if (!config) throw new Error(`未找到广告账户配置: ${accountId}`);
  const adapter = await createFbAdapter(config.token);
  const result = await adapter.uploadVideoByUrl(
    accountId,
    material.file_url,
    material.name,
  );

  // 更新 upload 记录
  const updated = await queryOne<MaterialUploadItem>(
    `UPDATE ad_material_upload
        SET channel_material_id = $2, channel_thumbnail_url = $3, status = 'uploading', channel_extra = $4
      WHERE id = $1
      RETURNING id, material_id, channel, channel_material_id, channel_thumbnail_url,
                status, channel_extra,
                to_char(uploaded_at, 'YYYY-MM-DD HH24:MI:SS') AS uploaded_at`,
    [upload.id, result.channel_material_id, result.channel_thumbnail_url, JSON.stringify({})],
  );
  if (!updated) throw new Error('更新 upload 记录失败');

  // 后台轮询 FB 转码状态（fire-and-forget，不做 await）
  pollVideoTranscode(updated.id, result.channel_material_id, accountId).catch((_error: unknown) => {
    logger.error(`[material] 转码轮询失败 material=${String(materialId)}:`, _error);
  });

  return updated;
}

/** 后台轮询 FB 视频转码状态，每 5 秒一次，最长等 5 分钟。 */
async function pollVideoTranscode(uploadId: number, videoId: string, accountId?: string): Promise<void> {
  if (!accountId) return;
  const config = await getAdAccountConfig(accountId);
  if (!config) return;
  const adapter = await createFbAdapter(config.token);
  const deadline = Date.now() + 300_000; // 5 分钟
  while (Date.now() < deadline) {
    await sleep(5000);
    const status = await adapter.getVideoStatus(videoId);
    if (status.status === 'ready') {
      await query(
        `UPDATE ad_material_upload SET status = 'ready', channel_extra = $2 WHERE id = $1`,
        [uploadId, JSON.stringify(status.channel_extra)],
      );
      logger.info(`[material] 视频转码完成 video=${videoId} upload=${String(uploadId)}`);
      return;
    }
    if (status.status === 'failed') {
      await query(
        `UPDATE ad_material_upload SET status = 'failed', channel_extra = $2 WHERE id = $1`,
        [uploadId, JSON.stringify(status.channel_extra)],
      );
      logger.warn(`[material] 视频转码失败 video=${videoId} upload=${String(uploadId)}`);
      return;
    }
  }

  // 超时标为 failed
  await query(`UPDATE ad_material_upload SET status = 'failed' WHERE id = $1`, [uploadId]);
  logger.warn(`[material] 视频转码超时 video=${videoId} upload=${String(uploadId)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
