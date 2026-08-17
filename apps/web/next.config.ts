import type { NextConfig } from 'next';

/**
 * 单体 Web 应用配置。
 * - transpilePackages：workspace 源码包（TS）交给 Next 编译。
 * - serverExternalPackages：pg 是纯服务端原生依赖，禁止打进 bundle；飞书 SDK
 *   （@larksuiteoapi/node-sdk，含 protobufjs/ws）同理——体积大且仅服务端用，外置既省
 *   构建内存又符合 standalone 语义（运行时从 node_modules require）。
 * - output: 'standalone'：产出自包含 server（含最小 node_modules），供多阶段镜像瘦身。
 * - outputFileTracingRoot：monorepo 根，确保 standalone 正确追踪跨包依赖。
 * - outputFileTracingIncludes：/api/campaign-context 运行时 readFile(prompts/*.md)，非静态导入，
 *   standalone 默认不追踪，需显式纳入；否则生产环境投放大师/AI投放决策 prompt 缺失。
 * - eslint.ignoreDuringBuilds：next build 内置的 ESLint 与仓库的 `pnpm lint`（flat config，
 *   type-checked）重复，且 Next 未装其 eslint 插件（构建时会告警 plugin not detected）。
 *   由 `pnpm lint` 单独把关（AGENTS 提交前自检），构建阶段跳过内置 lint——既去重，也避免
 *   在小内存机器上重复起 type-aware lint worker 触发 OOM。类型仍由 build 内置 tsc 校验。
 * - rewrites：旧 dataserver 的裸路径 /appsflyer、/adjust 兼容到新 /callback/*。
 *   归档的旧服务用 /appsflyer、/adjust 收 postback；新应用只挂 /callback/*，
 *   若 AF/Adjust 后台仍配旧路径则全部 404 → 无数据。此处做后向兼容，method/body/query 原样透传。
 */
const config: NextConfig = {
  transpilePackages: ['@agentic-ug/core', '@agentic-ug/db'],
  serverExternalPackages: ['pg', '@larksuiteoapi/node-sdk'],
  output: 'standalone',
  eslint: { ignoreDuringBuilds: true },
  outputFileTracingRoot: `${import.meta.dirname}/../..`,
  outputFileTracingIncludes: {
    '/api/campaign-context': ['./prompts/**/*.md'],
  },
  rewrites() {
    return Promise.resolve([
      { source: '/appsflyer', destination: '/callback/appsflyer' },
      { source: '/adjust', destination: '/callback/adjust' },
      // /mia 公开静态页（同事「投放协同中心」单文件 HTML，放 public/mia/index.html）。
      // 无尾斜杠的 /mia 在 standalone 下不会自动命中目录下 index.html，显式 rewrite。
      { source: '/mia', destination: '/mia/index.html' },
    ]);
  },
};

export default config;
