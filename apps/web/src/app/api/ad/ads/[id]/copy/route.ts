/**
 * POST /api/ad/ads/[id]/copy?accountId=xxx
 *
 * 复制广告：读取源 Ad + Creative → 剥离废弃字段 → 创建新 Creative → 创建新 Ad。
 *
 * 不走 FB copies 端点的原因：源 Creative 可能含有已废弃的
 * standard_enhancements 字段，FB 内部复制时无法剥离，导致
 * code=100 subcode=3858504。
 */

import { FacebookClient } from '@agentic-ug/fetcher';

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import { getAdAccountConfig } from '@/lib/dashboard/ad/token-service';
import { requireApiAuth } from '@/lib/dashboard/auth';
import { withGuard } from '@/lib/dashboard/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── 类型 ──

interface CopyBody {
  adset_id?: string;
  status_option?: 'ACTIVE' | 'PAUSED' | 'INHERITED_FROM_SOURCE';
  rename_strategy?: 'DEEP_RENAME' | 'ONLY_TOP_LEVEL_RENAME' | 'NO_RENAME';
  rename_prefix?: string;
  rename_suffix?: string;
  creative_parameters?: Record<string, unknown>;
  page_id?: string;
}

interface FbAdData {
  name?: string;
  adset_id?: string;
  status?: string;
  creative?: Record<string, unknown>;
}

interface FbCreateResult {
  id?: string;
}

// ── 工具函数 ──

/** 从对象中递归移除废弃/冲突字段 */
function cleanCreativeSpec(obj: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'standard_enhancements') continue;

    if (Array.isArray(v)) {
      cleaned[k] = v.map((item: unknown) =>
        typeof item === 'object' && item !== null
          ? cleanCreativeSpec(item as Record<string, unknown>)
          : item,
      );
    } else if (typeof v === 'object' && v !== null) {
      cleaned[k] = cleanCreativeSpec(v as Record<string, unknown>);
    } else {
      cleaned[k] = v;
    }
  }

  if ('image_hash' in cleaned && 'image_url' in cleaned) {
    delete cleaned['image_url'];
  }
  if ('video_id' in cleaned && 'image_url' in cleaned) {
    delete cleaned['image_url'];
  }

  return cleaned;
}

// ── 主路由 ──

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  const perm = await requireAdOperator(auth);
  if (perm instanceof Response) return perm;

  return withGuard(request, auth, async () =>
    withTrace(async () => {
      const { id: adId } = await params;
      const q = new URL(request.url).searchParams;
      const accountId = q.get('accountId');
      if (!accountId) return Response.json({ error: '缺少 accountId 参数，请在右上角选择广告账户' }, { status: 400 });
      const config = await getAdAccountConfig(accountId);
      if (!config) {
        return Response.json({ error: `未找到广告账户配置: ${accountId}` }, { status: 400 });
      }

      const body = (await request.json()) as CopyBody;
      const client = new FacebookClient(config.token);
      const actNum = accountId.replace(/^act_/, '');

      // ── Step 1: GET 源 Ad ──
      logger.info('[ad/copy] === Step 1: 读取源 Ad ===');

      const adFields = [
        'name', 'adset_id', 'status',
        'creative{id,title,body,object_story_spec,asset_feed_spec,image_hash,link_url,call_to_action_type}',
      ].join(',');

      let adData: FbAdData;
      try {
        adData = await client.get<FbAdData>(adId, { fields: adFields });
      } catch (error_: unknown) {
        return Response.json(
          { error: `读取源 Ad 失败: ${error_ instanceof Error ? error_.message : '请求失败'}` },
          { status: 500 },
        );
      }

      const sourceCreative = adData.creative;
      const rawCreativeId = sourceCreative?.['id'];
      if (!rawCreativeId || typeof rawCreativeId !== 'string') {
        return Response.json({ error: '源 Ad 缺少创意信息' }, { status: 500 });
      }

      logger.info(
        `[ad/copy] 源 Ad → name=${adData.name ?? '-'} adset_id=${adData.adset_id ?? '-'} status=${adData.status ?? '-'} creative_id=${rawCreativeId}`,
      );

      // ── Step 2: 创建新 Creative ──
      logger.info('[ad/copy] === Step 2: 创建新 Creative ===');

      const cleaned = cleanCreativeSpec(sourceCreative);
      if (body.creative_parameters && Object.keys(body.creative_parameters).length > 0) {
        Object.assign(cleaned, body.creative_parameters);
      }
      delete cleaned['id'];

      // 如果传了 page_id，注入到 object_story_spec 中
      if (body.page_id) {
        const oss = cleaned['object_story_spec'] as Record<string, unknown> | undefined;
        if (oss) {
          oss['page_id'] = body.page_id;
        }
        logger.info(`[ad/copy] 注入 page_id=${body.page_id}`);
      }

      logger.info(
        `[ad/copy] 清洗后 Creative spec: ${JSON.stringify(cleaned).slice(0, 2000)}`,
      );

      const creativeForm = new FormData();
      const creativeParams: Record<string, unknown> = {};
      const hasSpec = !!cleaned['object_story_spec'] || !!cleaned['asset_feed_spec'];

      if (cleaned['object_story_spec']) creativeParams['object_story_spec'] = cleaned['object_story_spec'];
      if (cleaned['asset_feed_spec']) creativeParams['asset_feed_spec'] = cleaned['asset_feed_spec'];

      if (hasSpec) {
        for (const f of ['name', 'image_hash', 'link_url']) {
          if (typeof cleaned[f] === 'string') creativeParams[f] = cleaned[f];
        }
      } else {
        for (const f of ['name', 'title', 'body', 'image_hash', 'link_url', 'call_to_action_type']) {
          if (typeof cleaned[f] === 'string') creativeParams[f] = cleaned[f];
        }
      }

      if (body.creative_parameters) {
        for (const key of ['object_story_spec', 'asset_feed_spec']) {
          if (body.creative_parameters[key] !== undefined) {
            creativeParams[key] = body.creative_parameters[key];
          }
        }
      }

      // 写入 FormData：复杂对象 → JSON 字符串，标量 → String
      for (const [key, value] of Object.entries(creativeParams)) {
        if (value === undefined || value === null) continue;
        if (key === 'object_story_spec' || key === 'asset_feed_spec' || (typeof value === 'object' && !Array.isArray(value))) {
          creativeForm.set(key, JSON.stringify(value));
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          creativeForm.set(key, String(value));
        }
      }

      let creativeResult: FbCreateResult;
      try {
        creativeResult = await client.postMultipart<FbCreateResult>(
          `act_${actNum}/adcreatives`,
          creativeForm,
        );
      } catch (error_: unknown) {
        return Response.json(
          { error: `创建 Creative 失败: ${error_ instanceof Error ? error_.message : '请求失败'}` },
          { status: 500 },
        );
      }

      const newCreativeId = creativeResult.id;
      if (!newCreativeId) {
        return Response.json({ error: '创建 Creative 成功但未返回 ID' }, { status: 500 });
      }

      // ── Step 3: 创建新 Ad ──
      logger.info('[ad/copy] === Step 3: 创建新 Ad ===');

      const adForm = new FormData();
      adForm.set('name', deriveNewName(
        adData.name ?? adId,
        body.rename_strategy ?? 'ONLY_TOP_LEVEL_RENAME',
        body.rename_prefix,
        body.rename_suffix,
      ));
      adForm.set('adset_id', body.adset_id ?? (adData.adset_id ?? ''));
      adForm.set('creative', JSON.stringify({ creative_id: newCreativeId }));
      adForm.set(
        'status',
        body.status_option === 'INHERITED_FROM_SOURCE'
          ? (adData.status ?? 'PAUSED')
          : (body.status_option ?? 'PAUSED'),
      );

      let adCreateResult: FbCreateResult;
      try {
        adCreateResult = await client.postMultipart<FbCreateResult>(
          `act_${actNum}/ads`,
          adForm,
        );
      } catch (error_: unknown) {
        return Response.json(
          { error: `创建 Ad 失败: ${error_ instanceof Error ? error_.message : '请求失败'}` },
          { status: 500 },
        );
      }

      const copiedAdId = adCreateResult.id;
      if (!copiedAdId) {
        return Response.json({ error: '创建 Ad 成功但未返回 ID' }, { status: 500 });
      }

      logger.info(
        `[ad/copy] ✅ 复制完成: 新 Ad=${copiedAdId}, 新 Creative=${newCreativeId}`,
      );

      return Response.json({ copied_ad_id: copiedAdId });
    }).catch((error_: unknown) => {
      logger.exception(error_, '/api/ad/ads/[id]/copy');
      return Response.json(
        { error: error_ instanceof Error ? error_.message : '复制失败' },
        { status: 500 },
      );
    }),
  );
}

/** 根据重命名策略生成新广告名称 */
function deriveNewName(
  originalName: string,
  strategy: string,
  prefix?: string,
  suffix?: string,
): string {
  if (strategy === 'NO_RENAME') return originalName;
  let name = originalName;
  if (prefix) name = `${prefix} ${name}`;
  if (suffix) name = `${name} ${suffix}`;
  return name;
}
