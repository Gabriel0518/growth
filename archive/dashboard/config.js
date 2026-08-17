'use strict';

// 集中式配置：所有敏感信息（密钥、密码、外部 API 凭证、DB 连接）一律从环境
// 变量读取，禁止硬编码。生产环境由 k8s Secret / ConfigMap 注入（见
// dora-k8s-config projects/agentic-ug-demo-dashboard/dev-values.yaml）。
//
// 本地开发可复制仓库根目录 .env.example 为 .env 并 `node -r dotenv/config`。

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    // 不抛异常以便本地只跑部分功能；缺失的凭证在调用处会失败并打日志。
    console.warn(`[config] 环境变量 ${name} 未设置`);
  }
  return v || '';
}

module.exports = {
  port: parseInt(process.env.DASHBOARD_PORT || '8081', 10),

  // ── 鉴权 ──
  adminUser: process.env.DASHBOARD_ADMIN_USER || 'admin',
  adminPass: required('DASHBOARD_ADMIN_PASS'),

  // ── XMP Open API ──
  xmp: {
    clientId: required('XMP_CLIENT_ID'),
    clientSecret: required('XMP_CLIENT_SECRET'),
    apiHost: process.env.XMP_API_HOST || 'xmp-open.mobvista.com',
  },

  // ── 雅典娜收入 API ──
  athena: {
    apiUrl: process.env.ATHENA_API_URL || 'https://admin-api-prod.sitin.ai/api/open/admin/revenue',
    apiKey: required('ATHENA_API_KEY'),
  },

  // ── LLM（SiliconFlow GLM）──
  llm: {
    apiKey: process.env.SILICONFLOW_API_KEY || '',
    baseUrl: process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.com/v1',
    model: process.env.LLM_MODEL || 'zai-org/GLM-5.1',
  },

  // ── PostgreSQL ──
  // 优先 DATABASE_URL；否则用分量变量（与 dora-k8s-config features.databases
  // 注入的 secret key 对齐）。
  db: {
    connectionString: process.env.DATABASE_URL || '',
    host: process.env.DATABASE_HOST || process.env.PGHOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || process.env.PGPORT || '5432', 10),
    user: process.env.DATABASE_USERNAME || process.env.PGUSER || 'postgres',
    password: process.env.DATABASE_PASSWORD || process.env.PGPASSWORD || '',
    database: process.env.DATABASE_NAME || process.env.PGDATABASE || 'agentic_ug',
    poolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
  },
};
