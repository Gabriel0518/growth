# REFACTORY NOTE —— Next.js 全量改造重点

> 分支：`personal/duhuan/production`
> 目标：把 **Python FastAPI 数据中心** + **Express 数据看板** + **一批独立脚本**，
> 整体改造为一套 **Next.js（App Router）+ Node.js CLI** 的 TypeScript pnpm 单体仓库，
> 三层存储统一到 **单个 PostgreSQL 实例**，功能与现网**零差异**。
>
> 完整方案见 [`REFACTOR-PLAN-NEXTJS.md`](./REFACTOR-PLAN-NEXTJS.md)；旧代码见 [`archive/`](./archive/README.md)。

---

## 1. 为什么重构

- **多套语言/运行时并存**：Python（FastAPI + uvloop）+ Node（Express）+ 一堆 `.sh`→`node`
  脚本链，部署、依赖与可观测性割裂。
- **三层存储割裂**：PostgreSQL、SQLite `postback.db`、`dashboard/data/*.json` 三处并存，
  一致性与迁移成本高。
- **部署要求变化**：需要「Next.js server 与各周期任务跑完全相同的代码/镜像」，
  以单镜像 + k8s CronJob 承载常驻 web 与周期任务（对应 dora-k8s-config PR #141）。

## 2. 改造重点

### 2.1 一份代码、一套运行时（TypeScript + pnpm workspace）
- pnpm workspace 单体仓库，只纳管 `apps/*`、`services/*`、`packages/*`。
- Node 22.x、TypeScript 5.7、pnpm 11；最严格 ESLint（flat config，type-checked）+ Prettier。

### 2.2 数据中心：FastAPI → Next.js Route Handler + CLI Worker（读写解耦）
旧 `dataserver/app.py` 的「常驻内存队列 + 单例后台 flush 协程」在 Next.js 的
请求作用域/多副本模型下无法稳定持有，故拆成两端：
- **接受端**（`apps/web` Route Handlers）：解析 + `extract_fields` 抽字段 →
  向 PG `ingest_inbox`（UNLOGGED 表）追加一行；inbox 超阈值返回 503，
  **复刻旧「队列满丢弃」语义**。
- **写入端**（`services/ingest-worker`，k8s CronJob 单实例）：
  事务内 `DELETE ... FOR UPDATE SKIP LOCKED` 取批 → 批量 INSERT 当月表
  `records_YYYYMM` → 派生 `user_lookup`（`ON CONFLICT DO NOTHING`）。
  失败 ROLLBACK，行留在 inbox 下轮重试，**比旧内存队列更不易丢数据**。

### 2.3 数据看板：Express + 原生 SPA → Next.js（React + Route Handlers）
- 37 个旧路由中的 `/api/*` 数据接口迁为 App Router **Route Handlers**
  （`apps/web/src/app/api/*`），业务逻辑收敛到 `apps/web/src/lib/dashboard/*`。
- 鉴权（session cookie + 共享口令兜底 + 面板二级口令）在 `lib/dashboard/auth.ts` 复刻。
- 前端 3447 行原生 JS SPA 改为 React（App Router 页面）。

### 2.4 常驻定时任务 → 一次性 CronJob（重构收尾的关键一步）
- 旧看板用自纠偏 `setTimeout` 常驻调度（scheduleSummary / XMP 预热 / 昨日回填）。
- 改为 **k8s CronJob 拉起一次性 Job**：`services/scheduler` 每整点运行一次
  `fetchAll` 后退出（北京 0 点自动收尾抓昨日）；无常驻进程、无漂移。
- 各服务补 `closePool()`，**错误分支也关连接池**，避免进程挂起卡死 CronJob。
- XMP 缓存周期预热暂缓——改由 web 请求按需惰性填充（3 天 TTL），仅延迟优化非正确性所需。

### 2.5 三层存储 → 单 PostgreSQL 实例
- 统一到一个 PG：`records_YYYYMM`、`user_lookup`、`athena_revenue`、`daily_snapshots`、
  `xmp_cache`、`eltv_cache`、`fetch_status`、`ingest_inbox`。
- 原 SQLite `postback.db` 与 `dashboard/data/*.json` 快照 → 迁入 PG。
- `services/migrate`：**幂等** 应用全部建表/索引 DDL。
- `services/import-json`：把旧 `dashboard/data/` 的按日快照 / eLTV 缓存
  以 JSONB passthrough 一次性灌入 PG，历史日期零差异。
- `scripts/pg-backfill/`：历史明细数据的一次性回填工具。

### 2.6 抓取链路原生 TS 化
- 旧 `fetch-*.sh`→`node scripts/*.js`→`curl` 的 shell 调用链，重写为
  `packages/fetcher`（XMP、雅典娜等抓取）纯 TypeScript 实现，移除 shell 依赖。

### 2.7 密钥治理
- 旧脚本内硬编码的飞书 APP_ID/SECRET 等改为读环境变量（见 `.env.example`）；
  生产由 k8s Secret/ConfigMap 注入（对应 dora-k8s-config secret 配置）。

## 3. 改造后仓库结构

```
apps/web/            Next.js App Router：看板 UI(React) + /api/* + 上报端点
packages/core/       字段抽取(extract)、月表名、类型等共享逻辑
packages/db/         pg Pool、schema DDL、建表封装
packages/fetcher/    XMP / 雅典娜等抓取（原生 TS，替代 .sh+node 链）
services/scheduler/     CronJob：每整点 fetchAll 一次
services/ingest-worker/ CronJob：排空 ingest_inbox 批量落库
services/migrate/       幂等 PG 建表迁移
services/import-json/   旧 JSON 快照一次性导入 PG
deploy/              Dockerfile + k8s（web / scheduler / ingest-worker / configmap / secret 示例）
scripts/pg-backfill/ 历史数据一次性回填
archive/             旧架构代码归档（dashboard / dataserver / 旧 scripts / 等）
```

## 4. 部署形态

- **单镜像**（`deploy/Dockerfile`）同时承载常驻 web 与周期任务：
  - web：`pnpm start`（`@agentic-ug/web`）
  - CronJob `fetch`：`pnpm job:fetch`（`@agentic-ug/scheduler`）
  - CronJob `ingest`：`pnpm job:ingest`（`@agentic-ug/ingest-worker`）
- k8s 清单与配置/密钥由 dora-k8s-config 平台维护，
  与其 `charts/service` + `features.databases` 对齐。

## 5. 零差异校验要点

- 上报「队列满丢弃 → 503」语义复刻；落库批量/月表惰性建表/`user_lookup` 派生一致。
- 历史快照与 eLTV 缓存经 `import-json` 灌入后，看板历史日期与旧实现一致。
- 修正系数、eLTV D180 拟合等业务口径保持不变（迁移逻辑不改公式）。
