# syntax=docker/dockerfile:1
#
# 单 Dockerfile 多 target，供三镜像共享构建层（Jenkins 用 --target 分别构建）：
#   --target web            Next.js standalone 看板 + ingest 端点（公网 ingress）
#   --target ingest-worker  inbox 批写 CLI（常驻单副本，无 ingress）
#   --target scheduler      定时抓取守护进程（tsx，北京每整点 :00 fetchAll）
#   --target tag-payment-channel  AD ad_purchase 补支付渠道（有界 Job，k8s CronJob UTC 每小时）
#
# 统一 node:22（对齐 .nvmrc / engines），corepack 提供 pnpm@packageManager 指定版本。

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ── build：安装整仓依赖并编译所有包/服务 ──
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm -r build

# ── web：仅取 Next standalone 产物（自带最小 node_modules + 溯源的 packages/prompts）──
FROM base AS web
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# outputFileTracingRoot=仓库根 → standalone 内布局为 /app/apps/web/server.js 等。
COPY --from=build /app/apps/web/.next/standalone /app
COPY --from=build /app/apps/web/.next/static /app/apps/web/.next/static
COPY --from=build /app/apps/web/public /app/apps/web/public
# server.js 用 join(process.cwd(),'prompts') 读 prompt，故 cwd 必须是 apps/web。
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "server.js"]

# ── ingest-worker：node 跑编译后的 dist ──
FROM build AS ingest-worker
ENV NODE_ENV=production
WORKDIR /app/services/ingest-worker
CMD ["node", "dist/main.js"]

# ── scheduler：tsx 直接跑 TS 源；抓取时 spawn scripts/ 下 bash 脚本 ──
FROM build AS scheduler
ENV NODE_ENV=production
# fetcher 默认 SCRIPTS_DIR 相对自身 dist；显式指向仓库内 scripts/ 以免布局漂移。
ENV SCRIPTS_DIR=/app/scripts
WORKDIR /app/services/scheduler
CMD ["pnpm", "start"]

# ── tag-payment-channel：node 跑编译后的 dist（有界一次性 Job，k8s CronJob 拉起）──
FROM build AS tag-payment-channel
ENV NODE_ENV=production
WORKDIR /app/services/tag-payment-channel
CMD ["node", "dist/main.js"]
