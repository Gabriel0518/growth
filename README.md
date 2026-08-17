# Agentic UG Demo

Sitin 广告投放数据平台：数据采集、看板展示、AI 投放建议全链路。
本仓库为 **Next.js（App Router）+ Node.js CLI** 的 TypeScript pnpm 单体仓库，
三层存储统一到 **单个 PostgreSQL 实例**。

> 本仓库已由旧的「Python FastAPI 数据中心 + Express 看板 + 独立脚本」全量改造而来。
> 改造重点见 [`REFACTORY_NOTE.md`](./REFACTORY_NOTE.md)，完整方案见
> [`REFACTOR-PLAN-NEXTJS.md`](./REFACTOR-PLAN-NEXTJS.md)，旧代码归档见
> [`archive/`](./archive/README.md)。

## 架构概览

```
广告网络 postback ──HTTP──▶ apps/web (Next.js Route Handler)
                                │ extract_fields() → append PG ingest_inbox
                                ▼
                     services/ingest-worker (CronJob) ──批量──▶ records_YYYYMM + user_lookup
XMP / 雅典娜 API ──▶ services/scheduler (CronJob 每整点 fetchAll) ──▶ daily_snapshots
                                                                │
apps/web 看板 UI (React) ◀── /api/* Route Handlers ◀──── 统一 PostgreSQL
                                │
                          AI 投放建议 (SiliconFlow GLM)
```

## 仓库结构

```
apps/
  web/                 Next.js App Router：看板 UI(React) + /api/* + 上报端点
packages/
  core/                字段抽取(extract)、月表名、共享类型
  db/                  pg Pool、schema DDL、建表封装
  fetcher/             XMP / 雅典娜等抓取（原生 TS）
services/
  scheduler/           CronJob：每整点运行一次 fetchAll 后退出
  ingest-worker/       CronJob：排空 ingest_inbox，批量落库
  migrate/             幂等 PG 建表迁移
  import-json/         旧 dashboard/data JSON 快照一次性导入 PG
deploy/                Dockerfile + k8s 清单（web/scheduler/ingest-worker/configmap/secret 示例）
scripts/pg-backfill/   历史数据一次性回填
archive/               旧架构代码归档（不参与构建/部署）
```

## 工作区（pnpm workspace）

| 包 | 说明 | 启动脚本 |
|----|------|----------|
| `@agentic-ug/web` | Next.js：看板 UI + `/api/*` 接口 + 广告回传上报端点 | `pnpm start` |
| `@agentic-ug/scheduler` | 定时抓取 Job（雅典娜收入 + XMP 消耗） | `pnpm job:fetch` |
| `@agentic-ug/ingest-worker` | 上报批写 Job（`ingest_inbox` → 月表 + `user_lookup`） | `pnpm job:ingest` |
| `@agentic-ug/migrate` | 统一 PG schema 迁移器（幂等） | `pnpm --filter @agentic-ug/migrate start` |
| `@agentic-ug/import-json` | 历史 JSON 快照导入 PG | `pnpm --filter @agentic-ug/import-json start` |
| `@agentic-ug/core` / `@agentic-ug/db` / `@agentic-ug/fetcher` | 共享库（不单独部署） | — |

## 数据存储（统一 PostgreSQL）

主要表：`records_YYYYMM`（按月分表，7 索引）、`user_lookup`、`athena_revenue`、
`daily_snapshots`、`xmp_cache`、`eltv_cache`、`fetch_status`、`ingest_inbox`（UNLOGGED 上报缓冲）。

上报采用「接受端 append inbox / 写入端批量落库」读写解耦：Route Handler 只做解析 +
抽字段 + 追加 inbox（inbox 超阈值返回 503，复刻旧「队列满丢弃」语义）；
`ingest-worker` 用 `FOR UPDATE SKIP LOCKED` 批量取走并落库，单实例安全、失败可重试。

## 本地开发

```bash
pnpm install
cp .env.example .env          # 填入 DATABASE_URL / XMP / 雅典娜 / LLM 等密钥
pnpm --filter @agentic-ug/migrate start   # 建表
pnpm dev                       # 或 pnpm --filter @agentic-ug/web dev
```

常用命令：

```bash
pnpm build          # 递归构建所有包
pnpm typecheck      # 全仓库类型检查
pnpm lint           # ESLint（flat config, type-checked）
pnpm format         # Prettier
```

环境变量清单见 [`.env.example`](./.env.example)。生产环境的密钥/配置由 k8s
Secret/ConfigMap 注入（与 dora-k8s-config 对齐）。

## 部署

单镜像（`deploy/Dockerfile`）同时承载常驻 web 与周期任务，配合 k8s CronJob：

- **web**（常驻）：`pnpm start`，端口 3000，含看板与 `/api/*`（含 S2S postback 回传）。
- **CronJob `fetch`**：`pnpm job:fetch`，每整点（Asia/Shanghai）抓一次雅典娜收入 + XMP 消耗。
- **CronJob `ingest`**：`pnpm job:ingest`，周期排空 `ingest_inbox` 落库。

k8s 清单与配置/密钥由 dora-k8s-config 平台维护（见其 PR #141）。

## 产品矩阵

共 11 个产品，覆盖 Android 与 iOS：

- **Android**：Dora And、Doni、Jovia And、Romi And、Kira And、Nalo And
- **iOS**：Dora iOS、Romi iOS、GraceChat、Luma、Kira iOS

投放渠道：Facebook (Meta)、Google Ads、TikTok，消耗数据经 XMP 统一管理。

## 看板功能

- **汇总面板** — 全产品营收概览（雅典娜 API + AF/AD 回传 + XMP 消耗）
- **个人面板** — 按投手下钻至 campaign/adset/ad，支持修正系数与 eLTV ROAS
- **素材面板** — 素材级投放效果分析
- **AI 投放建议** — 基于历史 + 实时数据，由 LLM（SiliconFlow GLM）生成优化建议

## 核心业务口径

- **修正系数**：`雅典娜收入 / AF 非自然量收入 × 0.95`，校准 AF 归因偏差。
- **eLTV**：基于三指数衰减拟合的 D180 LTV 预估。

## 技术栈

- **运行时**：Node.js 22.x、TypeScript 5.7、pnpm 11
- **Web**：Next.js（App Router + React）
- **CLI 服务**：Node.js 一次性 Job（由 k8s CronJob 拉起）
- **数据库**：PostgreSQL（单实例统一存储）
- **AI**：SiliconFlow GLM（投放建议）
- **部署**：单镜像 + k8s（Deployment + CronJob）
