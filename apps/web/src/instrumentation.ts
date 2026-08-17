/**
 * Next instrumentation —— 进程启动钩子（register 在 server 启动时执行一次）。
 *
 * nodejs runtime 启动时初始化广告表、账号表与 Token 内存服务。
 * - edge runtime 没有 node API（pg），必须排除。
 * node-only 依赖用动态 import（放在 runtime 判断之后），避免被打进 edge bundle。
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  // next build 阶段也会调 register()：此时不能连接数据库，直接跳过。
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

  const { ensureAuthTables } = await import('@agentic-ug/db');
  try {
    await ensureAuthTables(getPool());
  } catch (error) {
    console.error('[instrumentation] ensureAuthTables 失败：', error);
  }
}
