/**
 * Next instrumentation —— 进程启动钩子（register 在 server 启动时执行一次）。
 *
 * 只在「生产 + nodejs runtime」起飞书卡片回调长连接：
 * - dev 下 next 会热重载/多次编译，重复起长连接没意义且吵；生产常驻进程才需要。
 * - edge runtime 没有 node API（pg / ws），必须排除。
 * node-only 依赖用动态 import（放在 runtime 判断之后），避免被打进 edge bundle。
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  // next build 阶段也会调 register()：此时不能连 DB / 开飞书长连接，跳过。
  if (process.env['NEXT_PHASE'] === 'phase-production-build') return;

  // 投放平台 ad_* 表初始化（幂等，所有环境）
  const { ensureAdTables, getPool } = await import('@agentic-ug/db');
  try {
    await ensureAdTables(getPool());
  } catch (error) {
    console.error('[instrumentation] ensureAdTables 失败：', error);
  }
  const { reloadTokenService } = await import('@/lib/dashboard/ad/token-service');
  try {
    await reloadTokenService();
    console.log('[instrumentation] Token 内存服务已初始化');
  } catch (error) {
    console.error('[instrumentation] Token 内存服务初始化失败：', error);
  }

  if (process.env.NODE_ENV !== 'production') return;
  const { ensureAuthTables } = await import('@agentic-ug/db');
  try {
    await ensureAuthTables(getPool());
  } catch (error) {
    console.error('[instrumentation] ensureAuthTables 失败：', error);
  }

  // 本地演示可走账密兜底；没有飞书凭据时不启动卡片长连接，避免整个 Web 进程启动失败。
  if (!process.env['FEISHU_APP_ID'] || !process.env['FEISHU_APP_SECRET']) {
    console.warn('[instrumentation] 飞书凭据未设置，已跳过卡片回调长连接');
    return;
  }

  const { startCardConsumer } = await import('@/lib/feishu/card-consumer');
  startCardConsumer();
}
