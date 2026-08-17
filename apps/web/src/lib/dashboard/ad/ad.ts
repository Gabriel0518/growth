/**
 * 广告（Ad）业务逻辑。
 * 创建后在本地 ad 表回写，后续查询走本地库。
 */

import { query, queryOne } from '@agentic-ug/db';
import { FacebookClient } from '@agentic-ug/fetcher';
import type { Ad } from '@agentic-ug/fetcher';

import { logger } from './logger';
import { getAdAccountConfig } from './token-service';

// ── 本地库行类型 ──

interface AdRow {
  id: number;
  adset_id: number;
  ad_campaign_id: number | null;
  creative_id: number | null;
  channel_ad_id: string | null;
  name: string;
  status: string;
  effective_status: string | null;
  channel_extra: unknown;
  created_at: string;
}

function rowToAd(row: AdRow): Ad & { local_id: number } {
  return {
    id: row.channel_ad_id ?? String(row.id),
    local_id: row.id,
    name: row.name,
    status: row.status as 'ACTIVE' | 'PAUSED',
    effective_status: row.effective_status ?? 'PENDING_REVIEW',
    channel_extra: row.channel_extra as Record<string, unknown>,
  };
}

// ── 查询 ──

export async function listAds(adgroupId: string): Promise<(Ad & { local_id: number })[]> {
  const rows = await query<AdRow & { campaign_product: string | null; campaign_operator: string | null; campaign_created_at: string | null }>(
    `SELECT a.id, a.adset_id, a.creative_id, a.channel_ad_id, a.name, a.status,
            a.effective_status, a.channel_extra,
            to_char(a.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
            c.app_product AS campaign_product,
            s.creator AS campaign_operator,
            to_char(c.created_at, 'YYYY-MM-DD') AS campaign_created_at
       FROM ad a
       LEFT JOIN ad_set s ON s.id = a.adset_id
       LEFT JOIN ad_campaign c ON c.id = s.campaign_id
      WHERE a.adset_id = $1
      ORDER BY a.created_at DESC`,
    [adgroupId],
  );
  return rows.map((r) => {
    const ad = rowToAd(r);
    return Object.assign(ad, {
      campaign_product: r.campaign_product,
      campaign_operator: r.campaign_operator,
      campaign_created_at: r.campaign_created_at,
    });
  });
}

// ── 创建 ──

export async function createAd(input: {
  name: string;
  adset_id: string;
  local_creative_id?: string;
  status?: 'ACTIVE' | 'PAUSED';
  accountId?: string;
  page_id?: string;
  // 内联创建 Creative
  material_id?: number;
  creative_name?: string;
  titles?: string[];
  bodies?: string[];
  optimization_type?: string;
  link_url?: string;
  call_to_action_type?: string;
  ig_user_id?: string;
  instagram_branded_content?: Record<string, unknown>;
  creator?: string;
  link_description?: string;
  url_tags?: string;
}): Promise<Ad> {
  // 1. 从本地库取 FB adset_id + promoted_object
  const adsetRow = await queryOne<{
    channel_adset_id: string | null;
    channel_extra: Record<string, unknown>;
  }>(`SELECT channel_adset_id, channel_extra FROM ad_set WHERE id = $1`, [input.adset_id]);
  if (!adsetRow?.channel_adset_id) {
    throw new Error('无效的 AdSet ID');
  }

  // 从 AdSet channel_extra 提取 object_store_url 作为 CTA 链接（必须匹配）
  const promotedObj = adsetRow.channel_extra['promoted_object'];
  const adsetStoreUrl: string | undefined =
    typeof promotedObj === 'object' && promotedObj !== null
      ? ((promotedObj as unknown as Record<string, unknown>)['object_store_url'] as
          string | undefined)
      : undefined;

  // CTA 链接: 必须匹配 AdSet promoted_object.object_store_url（FB 要求）
  const finalCtaLink = adsetStoreUrl ?? input.link_url;

  const status = input.status ?? 'PAUSED';
  let creativeId: string;
  let localCreativeId: number;

  // 2. 获取或创建 Creative
  if (input.material_id) {
    // ── 路径 A: 从素材库内联创建 Creative ──
    const materialId = input.material_id;
    creativeId = await createCreativeFromMaterial({
      ...input,
      material_id: materialId,
      ...(finalCtaLink ? { cta_link: finalCtaLink } : {}),
    });

    // 写入本地
    const newCr = await queryOne<{ id: number }>(
      `INSERT INTO ad_creative (channel, channel_creative_id, channel_material_id, page_id, titles, bodies, channel_extra)
       VALUES ('fb', $1, '', $2, $3, $4, '{}')
       RETURNING id`,
      [
        creativeId,
        input.page_id ?? '',
        JSON.stringify(input.titles ?? []),
        JSON.stringify(input.bodies ?? []),
      ],
    );
    if (!newCr) throw new Error('创建本地 Creative 记录失败');
    localCreativeId = newCr.id;
  } else if (input.local_creative_id) {
    // ── 路径 B: 使用已有 Creative ──
    const creative = await queryOne<{
      channel_creative_id: string | null;
      page_id: string | null;
      channel_extra: unknown;
    }>(`SELECT channel_creative_id, page_id, channel_extra FROM ad_creative WHERE id = $1`, [
      input.local_creative_id,
    ]);
    if (!creative?.channel_creative_id) {
      throw new Error('创意尚未同步到平台，请先创建创意');
    }

    creativeId = creative.channel_creative_id;
    localCreativeId = Number.parseInt(input.local_creative_id, 10);

    // 如果需要换 page_id，创建新 Creative
    if (input.page_id && creative.page_id !== input.page_id && input.accountId) {
      const config = await getAdAccountConfig(input.accountId);
      if (!config) throw new Error(`未找到广告账户配置: ${input.accountId}`);
      const client = new FacebookClient(config.token);
      const actNum = input.accountId.replace(/^act_/, '');

      const extra = creative.channel_extra as Record<string, unknown> | null;
      const cleaned: Record<string, unknown> = {};
      if (extra && typeof extra === 'object') {
        for (const [k, v] of Object.entries(extra)) {
          if (k !== 'id' && k !== 'standard_enhancements') cleaned[k] = v;
        }
      }
      const oss = cleaned['object_story_spec'] as Record<string, unknown> | undefined;
      if (oss) oss['page_id'] = input.page_id;

      const creativeForm = new FormData();
      for (const [key, value] of Object.entries(cleaned)) {
        if (value === undefined || value === null) continue;
        if (key === 'object_story_spec' || key === 'asset_feed_spec') {
          creativeForm.set(key, JSON.stringify(value));
        } else if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          creativeForm.set(key, String(value));
        }
      }
      const creativeResult = await client.postMultipart<{
        id?: string;
        error?: { message: string };
      }>(`act_${actNum}/adcreatives`, creativeForm);
      if (!creativeResult.id) {
        throw new Error(`创建新 Creative 失败: ${creativeResult.error?.message ?? '未返回 ID'}`);
      }
      const newCreativeRow = await queryOne<{ id: number }>(
        `INSERT INTO ad_creative (channel, channel_creative_id, channel_material_id, page_id, channel_extra)
         VALUES ('fb', $1, $2, $3, $4) RETURNING id`,
        [creativeResult.id, input.local_creative_id, input.page_id, JSON.stringify(cleaned)],
      );
      if (newCreativeRow) {
        creativeId = creativeResult.id;
        localCreativeId = newCreativeRow.id;
      }
    }
  } else {
    throw new Error('请选择素材或已有创意');
  }

  // 3. 调 FB API 创建 ad —— 用 FacebookClient 直连，绕过 adapter 的 defaultAccountId()
  if (!input.accountId) throw new Error('创建广告需要 accountId');
  const config = await getAdAccountConfig(input.accountId);
  if (!config) throw new Error(`未找到广告账户配置: ${input.accountId}`);
  const client = new FacebookClient(config.token);
  const actNum = input.accountId.replace(/^act_/, '');

  // POST {accountId}/ads 创建广告
  const adCreateResult = await client.post<{ id: string }>(`act_${actNum}/ads`, {
    name: input.name,
    adset_id: adsetRow.channel_adset_id,
    creative: { creative_id: creativeId },
    status,
  });
  // 再读回获取 effective_status
  const fbAdRaw = await client.get<{
    id: string;
    name: string;
    status: string;
    effective_status: string;
  }>(adCreateResult.id, { fields: 'id,name,status,effective_status' });
  const fbAd: Ad = {
    id: fbAdRaw.id,
    name: fbAdRaw.name,
    status: fbAdRaw.status as 'ACTIVE' | 'PAUSED',
    effective_status: fbAdRaw.effective_status,
    channel_extra: fbAdRaw,
  };

  // 4. 回写本地库"syh"
  await query(
    `INSERT INTO ad (adset_id, creative_id, channel_ad_id, name, status, effective_status, creator, channel_extra, ad_campaign_id)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, campaign_id FROM ad_set WHERE id = $1`,
    [
      input.adset_id,
      localCreativeId,
      fbAd.id,
      input.name,
      fbAd.status,
      fbAd.effective_status,
      input.creator ?? null,
      JSON.stringify(fbAd.channel_extra),
    ],
  );

  return fbAd;
}

// ── 内联创建 Creative ──

async function createCreativeFromMaterial(input: {
  material_id: number;
  page_id?: string;
  accountId?: string;
  creative_name?: string;
  titles?: string[];
  bodies?: string[];
  optimization_type?: string;
  link_url?: string;
  call_to_action_type?: string;
  cta_link?: string;   // ← 由 createAd 注入（AdSet.object_store_url）
  link_description?: string;
  url_tags?: string;
  ig_user_id?: string;
  instagram_branded_content?: Record<string, unknown>;
}): Promise<string> {
  if (!input.accountId) throw new Error('内联创建创意需要 accountId');
  if (!input.page_id) throw new Error('内联创建创意需要 page_id');

  const config = await getAdAccountConfig(input.accountId);
  if (!config) throw new Error(`未找到广告账户配置: ${input.accountId}`);

  // 查询素材信息
  const material = await queryOne<{
    channel_material_id: string;
    type: string;
    url: string | null;
    thumbnail_url: string | null;
  }>(
    `SELECT channel_material_id, type, url, thumbnail_url
       FROM ad_account_material WHERE id = $1`,
    [input.material_id],
  );
  if (!material) throw new Error('素材不存在');

  const client = new FacebookClient(config.token);
  const actNum = input.accountId.replace(/^act_/, '');
  const creativeForm = new FormData();

  // 构建 object_story_spec（对齐 fb-build.py build_creative 格式）
  const ctaLink = input.cta_link ?? input.link_url;
  const optType = input.optimization_type ?? 'DEGREES_OF_FREEDOM';

  // 查找同账户的一张图片 hash 作为视频缩略图（FB 拒绝 CDN URL）
  const thumbImage = material.type === 'video'
    ? await queryOne<{ channel_material_id: string }>(
        `SELECT channel_material_id FROM ad_account_material
          WHERE channel_account_id = $1 AND type = 'image' AND status = 'ACTIVE'
          ORDER BY created_at DESC LIMIT 1`,
        [input.accountId],
      )
    : undefined;
  const thumbHash = thumbImage?.channel_material_id;

  if (material.type === 'video') {

    if (optType === 'REGULAR') {
      // REGULAR + SINGLE_VIDEO: 素材放 asset_feed_spec.videos
      const oss: Record<string, unknown> = {
        page_id: input.page_id,
        call_to_action: {
          type: input.call_to_action_type ?? 'INSTALL_MOBILE_APP',
          value: { link: ctaLink ?? '' },
        },
      };
      if (input.ig_user_id) oss['instagram_user_id'] = input.ig_user_id;
      creativeForm.set('object_story_spec', JSON.stringify(oss));
    } else {
      // DEGREES_OF_FREEDOM / NONE: 素材放 object_story_spec.video_data
      const oss: Record<string, unknown> = {
        page_id: input.page_id,
        video_data: {
          video_id: material.channel_material_id,
          ...(thumbHash ? { image_hash: thumbHash } : {}),
          call_to_action: {
            type: input.call_to_action_type ?? 'INSTALL_MOBILE_APP',
            value: { link: ctaLink ?? '' },
          },
        },
      };
      if (input.ig_user_id) oss['instagram_user_id'] = input.ig_user_id;
      creativeForm.set('object_story_spec', JSON.stringify(oss));
    }
  } else {
    // 图片
    const oss: Record<string, unknown> = {
      page_id: input.page_id,
      photo_data: {
        image_hash: material.channel_material_id,
        caption: input.bodies?.[0] ?? '',
      },
    };
    if (input.ig_user_id) oss['instagram_user_id'] = input.ig_user_id;
    creativeForm.set('object_story_spec', JSON.stringify(oss));
  }

  // asset_feed_spec（用户自定义文案）
  const titleList = input.titles?.length ? input.titles : ['默认标题'];
  const bodyList = input.bodies?.length ? input.bodies : ['默认正文'];
  const afs: Record<string, unknown> = {
    titles: titleList.map((t) => ({ text: t })),
    bodies: bodyList.map((b) => ({ text: b })),
  };
  if (optType !== 'NONE') afs['optimization_type'] = optType;
  if (optType === 'REGULAR') {
    // REGULAR 模式必须带 ad_formats（FB 文档 §6.5）
    afs['ad_formats'] = material.type === 'video' ? ['SINGLE_VIDEO'] : ['SINGLE_IMAGE'];
    // REGULAR 必须显式声明 CTA（FB 文档 §6.2）
    afs['call_to_action_types'] = [input.call_to_action_type ?? 'INSTALL_MOBILE_APP'];
    if (ctaLink) afs['link_urls'] = [{ website_url: ctaLink }];
    // SINGLE_VIDEO: 视频信息移到 asset_feed_spec.videos（FB 文档 §6.7.1）
    if (material.type === 'video') {
      afs['videos'] = [
        {
          video_id: material.channel_material_id,
          thumbnail_hash: thumbHash ?? '',
        },
      ];
    }
  }
  creativeForm.set('asset_feed_spec', JSON.stringify(afs));

  // degrees_of_freedom_spec（仅 DEGREES_OF_FREEDOM 时启用）
  if (optType === 'DEGREES_OF_FREEDOM') {
    creativeForm.set('degrees_of_freedom_spec', JSON.stringify({
      creative_features_spec: {
        enhance_cta: { enroll_status: 'OPT_IN' },
        inline_comment: { enroll_status: 'OPT_IN' },
        text_optimizations: { enroll_status: 'OPT_IN' },
        video_auto_crop: { enroll_status: 'OPT_IN' },
      },
    }));
  }

  // IG 共创广告（创作者做主身份）
  if (input.instagram_branded_content) {
    creativeForm.set('instagram_branded_content', JSON.stringify(input.instagram_branded_content));
  }

  if (input.creative_name) creativeForm.set('name', input.creative_name);
  if (input.url_tags) creativeForm.set('url_tags', input.url_tags);

  const ossDebug = creativeForm.get('object_story_spec');
  logger.info(
    `[ad/create-creative] type=${material.type} page_id=${input.page_id ?? '-'} opt_type=${optType} titles=${String(titleList.length)} bodies=${String(bodyList.length)} ig_user_id=${input.ig_user_id ?? '-'} cta=${JSON.stringify(ctaLink)} oss=${JSON.stringify(ossDebug ?? '').slice(0, 3000)}`,
  );

  const result = await client.postMultipart<{ id?: string; error?: { message: string } }>(
    `act_${actNum}/adcreatives`, creativeForm,
  );
  if (!result.id) {
    throw new Error(`内联创建 Creative 失败: ${result.error?.message ?? '未返回 ID'}`);
  }

  return result.id;
}
