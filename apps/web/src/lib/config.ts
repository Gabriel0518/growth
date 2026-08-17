/**
 * 集中式配置 —— 逐字对齐旧 dashboard/config.js。
 * 敏感信息一律从环境变量读取，缺失仅告警（本地可只跑部分功能，调用处会失败并打日志）。
 * DB 连接不在此处：统一由 @agentic-ug/db 的 resolveDsn 管理，避免双份分叉。
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.warn(`[config] 环境变量 ${name} 未设置`);
  }
  return value ?? '';
}

/** 对应旧代码 `process.env.X || fallback`：undefined / 空串都取回退值。 */
function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

interface XmpConfig {
  clientId: string;
  clientSecret: string;
  apiHost: string;
}

interface AthenaConfig {
  apiUrl: string;
  apiKey: string;
}

interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
}

interface DashboardConfig {
  adminPass: string;
  /** 历史外部回调基址，仍供飞书资料兼容模块读取。 */
  baseUrl: string;
  xmp: XmpConfig;
  athena: AthenaConfig;
  llm: LlmConfig;
  feishu: FeishuConfig;
}

export const config: DashboardConfig = {
  // ── 鉴权 ──
  // DASHBOARD_ADMIN_PASS 仅保留给历史 M2M 口令兼容；网页账号已迁移到 dashboard_user。
  adminPass: envOr('DASHBOARD_ADMIN_PASS', ''),
  baseUrl: envOr('APP_BASE_URL', 'https://ug-data-callback.sitinai.com'),

  // ── XMP Open API ──
  xmp: {
    clientId: required('XMP_CLIENT_ID'),
    clientSecret: required('XMP_CLIENT_SECRET'),
    apiHost: envOr('XMP_API_HOST', 'xmp-open.mobvista.com'),
  },

  // ── 雅典娜收入 API ──
  athena: {
    apiUrl: envOr('ATHENA_API_URL', 'https://admin-api-prod.sitin.ai/api/open/admin/revenue'),
    apiKey: required('ATHENA_API_KEY'),
  },

  // ── LLM（SiliconFlow GLM）──
  llm: {
    apiKey: envOr('SILICONFLOW_API_KEY', ''),
    baseUrl: envOr('SILICONFLOW_BASE_URL', 'https://api.siliconflow.com/v1'),
    model: envOr('LLM_MODEL', 'zai-org/GLM-5.1'),
  },

  // ── 历史飞书资料与投放权限兼容 ──
  feishu: {
    appId: required('FEISHU_APP_ID'),
    appSecret: required('FEISHU_APP_SECRET'),
  },
};
