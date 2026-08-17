/**
 * POST /api/ad/sync —— 从 FB 拉取现有投放数据并同步到本地库。
 * body: { accountId?: string } —— 指定广告账户，可选（从前端账户选择器传入）
 */

import { createFbAdapter } from '@agentic-ug/fetcher';

import { requireAdOperator } from '@/lib/dashboard/ad/auth';
import { logger, withTrace } from '@/lib/dashboard/ad/logger';
import { markSyncTime, syncCooldownRemaining, syncFromFb } from '@/lib/dashboard/ad/sync';
import { getAdAccountConfig, getAdAccountConfigs } from '@/lib/dashboard/ad/token-service';
import { requireApiAuth } from '@/lib/dashboard/auth';
import { withGuard } from '@/lib/dashboard/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  const perm = await requireAdOperator(auth);
  if (perm instanceof Response) return perm;

  return withGuard(request, auth, async () =>
    withTrace(async () => {
      try {
        const body = (await request.json().catch(() => ({}))) as { accountId?: string };
        const acctId = body.accountId;

        // 冷却保护：请求级，防止高频重复同步撞 FB 账户级读限流。
        const cooldown = syncCooldownRemaining();
        if (cooldown > 0) {
          return Response.json({ error: `同步冷却中，剩余 ${String(cooldown)} 秒` }, { status: 429 });
        }

        // 单账户同步（向后兼容：前端账户选择器仍可指定账户）
        if (acctId) {
          const config = await getAdAccountConfig(acctId);
          if (!config) {
            return Response.json(
              { error: `未找到广告账户配置: ${acctId}，请先在 Token 管理页面添加` },
              { status: 503 },
            );
          }
          try {
            const adapter = await createFbAdapter(config.token);
            const result = await syncFromFb(adapter, config.accountId);
            markSyncTime();
            return Response.json(result);
          } catch (error) {
            const message = error instanceof Error ? error.message : '未知错误';
            console.error('[ad/sync] 同步失败：', message);
            return Response.json({ error: `同步失败：${message}` }, { status: 500 });
          }
        }

        // 全量同步：遍历所有 token 所属广告账户，按 accountId 去重（多 token 重复直接跳过）。
        const configs = await getAdAccountConfigs();
        const seen = new Set<string>();
        let campaigns = 0;
        let adsets = 0;
        let ads = 0;
        let skippedAccounts = 0;
        const failures: string[] = [];

        for (const config of configs) {
          if (seen.has(config.accountId)) {
            skippedAccounts += 1;
            continue;
          }
          seen.add(config.accountId);
          try {
            const adapter = await createFbAdapter(config.token);
            const r = await syncFromFb(adapter, config.accountId);
            campaigns += r.campaigns;
            adsets += r.adsets;
            ads += r.ads;
          } catch (error) {
            const message = error instanceof Error ? error.message : '未知错误';
            logger.warn(`[ad/sync] 账户 ${config.accountId} 同步失败: ${message}`);
            failures.push(`${config.accountId}: ${message}`);
          }
        }

        markSyncTime();
        return Response.json({
          campaigns,
          adsets,
          ads,
          accounts: seen.size,
          skippedAccounts,
          failures,
        });
      } catch (error) {
        logger.exception(error, '/api/ad/sync');
        return Response.json(
          { error: error instanceof Error ? error.message : '内部错误' },
          { status: 500 },
        );
      }
    }),
  );
}
