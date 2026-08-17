# AgenticUG 工程化版概览（AgenticUG）

> **这是什么**：`presence-io/Agentic-UG-Demo` **工程化重构版（新 main 分支）** 的主索引文档。
> 全量把旧的「Python FastAPI 数据中心 + Express 看板 + 一堆 .sh→node 脚本」改造为
> 一套 **Next.js（App Router）+ Node.js CLI** 的 TypeScript pnpm 单体仓库，
> 三层存储统一到 **单个 PostgreSQL 实例**，功能与旧现网**零差异**。
>
> **与 `SERVER_OVERVIEW.md` 的关系**：两者是**并列**的两份顶层概览，不是补丁关系。
>
> - `SERVER_OVERVIEW.md` = 旧线上架构（服务器上正在跑的 dataserver + Express dashboard + scripts），描述**当前生产环境**。
> - `AgenticUG.md`（本文件）= **工程化重构版**，以后新 main 分支基于它继续开发。屹恒说「读 AgenticUG.md」即加载本文件切入工程化版上下文。
>
> **仓库**：`presence-io/Agentic-UG-Demo`（`origin/main`，工程化版已合入 main；重构分支 `personal/duhuan/production`）
> **权威依据**：`README.md` + `REFACTORY_NOTE.md` + `REFACTOR-PLAN-NEXTJS.md`（仓库根目录）+ 源码实读（`packages/db/src/schema.ts`、`services/*/src/main.ts`、`apps/web/src/lib/*`）
> 最近更新：2026-07-09（第二轮：补入源码级细节）

---

## 0. 快速定位（新旧对照）

| 维度        | 旧版（SERVER_OVERVIEW.md）                                           | 工程化版（本文件）                                         |
| ----------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| 语言/运行时 | Python(FastAPI+uvloop) + Node(Express) + shell 脚本链                | 单一 TypeScript / Node 22 / pnpm 11                        |
| Web 框架    | 原生 SPA（3447 行 JS）+ Express 路由                                 | Next.js App Router（React + Route Handlers）               |
| 数据中心    | FastAPI 常驻内存队列 + 后台 flush 协程                               | 接受端 append inbox + ingest-worker 批量落库（读写解耦）   |
| 定时任务    | 常驻 `setTimeout` 自纠偏调度                                         | 一次性 k8s CronJob（每整点跑一次即退出）                   |
| 存储        | PostgreSQL + SQLite `postback.db` + `dashboard/data/*.json` 三处割裂 | **单个 PostgreSQL 实例**统一                               |
| 抓取链路    | `fetch-*.sh`→`node`→`curl`                                           | `packages/fetcher` 原生 TS                                 |
| 部署        | systemd（dataserver/dashboard/caddy）                                | 单镜像 + k8s（Deployment + CronJob，dora-k8s-config 维护） |
| 密钥        | 部分脚本内硬编码                                                     | 环境变量 / k8s Secret+ConfigMap（`.env.example`）          |
| 旧代码      | ——                                                                   | 全部归档到 `archive/`，不参与构建/部署                     |

**业务口径不变**：产品矩阵、修正系数、eLTV、去重、AI 建议 prompt 等业务逻辑迁移时**逐一复刻，公式不改**。

---

## 1. 文档 / 代码路由索引

> 本仓库不再拆多份专家 md，业务逻辑收敛在代码里。读到本文件后，按关键词直接定位到对应**代码模块**（相对仓库根）。

| 模块 / 文件                                    | 内容                                         | 关键词（路由判断）                                       |
| ---------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `README.md`                                    | 架构概览、workspace、本地开发、部署          | 上手, 跑起来, 目录, 命令, dev, build                     |
| `REFACTORY_NOTE.md`                            | 重构重点（为什么改、改了什么）               | 重构, 为什么, 改造重点, 读写解耦, CronJob                |
| `REFACTOR-PLAN-NEXTJS.md`                      | 完整迁移方案（最详细）                       | 迁移方案, 完整计划, 逐条对照, 零差异                     |
| `apps/web/src/lib/dashboard/*`                 | **看板全部业务逻辑**（口径核心）             | 汇总, 个人, 素材, 修正系数, eLTV, 去重, 归因             |
| `apps/web/src/app/api/*`                       | 看板 REST 接口（Route Handlers）             | 接口, api, af-summary, channel-summary, campaign-context |
| `apps/web/src/app/callback/*`                  | 广告回传上报端点（AF / Adjust）              | postback, 回传, appsflyer, adjust, 上报                  |
| `apps/web/src/app/api/ext/*`                   | 对外取数接口（?key= / Bearer）               | 对外取数, ext, records, xmp 透传, 机器取数               |
| `apps/web/src/lib/dashboard/guard.ts`          | 接口保护（限流/范围/并发）                   | api-guard, 限流, 429, 硬范围, 并发闸                     |
| `apps/web/src/components/*`                    | 前端 React（看板 UI / 各面板 / 图表）        | 前端, React, 面板 UI, 甘特图, 图表                       |
| `apps/web/prompts/*`                           | AI 投放建议 system prompt                    | 投放大师, AI投放决策, LLM 建议                           |
| `apps/web/src/lib/dashboard/auth.ts`           | 鉴权（无状态 HMAC cookie + 面板二级口令）    | 登录, session, cookie, 二级口令, panel-access            |
| `apps/web/src/lib/ingest.ts`                   | 上报接受端（抽字段 → 写 inbox）              | enqueue, inbox, 队列满, 503, popFirst                    |
| `apps/web/src/app/callback/*` + `datacenter/*` | 回传上报端点 + 数据中心接口                  | callback, appsflyer, adjust, datacenter, admin, stats    |
| `apps/web/src/app/health/route.ts`             | 健康检查（version/queue_size/current_table） | health, 健康, 探活                                       |
| `packages/core/src/extract.ts`                 | 字段抽取（回传解析核心，含 py 语义复刻）     | extract, 抽字段, event_name, 解析, pyStr, pyTruthy       |
| `packages/core/src/tables.ts`                  | 月表命名 `records_YYYYMM`                    | 月表, 分表, 表名                                         |
| `packages/db/src/schema.ts`                    | 统一 PG schema DDL（建表/索引）              | schema, 建表, 索引, DDL                                  |
| `packages/db/src/pool.ts`                      | PG 连接池 + `closePool()`                    | 连接池, pool, pg, DATABASE_URL                           |
| `packages/fetcher/src/*`                       | XMP / 雅典娜 / 素材抓取（TS）                | 抓取, fetcher, XMP, 雅典娜, 素材                         |
| `services/scheduler/src/main.ts`               | CronJob：每整点 `fetchAll` 一次              | 定时抓取, scheduler, fetch job, 整点                     |
| `services/ingest-worker/src/main.ts`           | CronJob：排空 inbox 批量落库                 | 落库, ingest, inbox, SKIP LOCKED                         |
| `services/migrate/src/main.ts`                 | 幂等 PG 建表迁移器                           | migrate, 迁移, 建表, 幂等                                |
| `services/import-json/src/main.ts`             | 旧 JSON 快照一次性导入 PG                    | import, 历史快照, JSON 导入, JSONB                       |
| `scripts/pg-backfill/*`                        | 历史明细数据一次性回填                       | 回填, backfill, 历史数据, 灌数                           |
| `deploy/Dockerfile`                            | 单镜像（web + 两个 job）                     | 部署, 镜像, docker, k8s                                  |
| `archive/`                                     | 旧架构代码归档（只读参考，不构建）           | 旧代码, 归档, 老版本, dashboard 旧, dataserver 旧        |

**路由规则**：读到本文件后，按用户问题匹配关键词，直接 `read` 对应 1~3 个代码文件（业务口径优先看 `lib/dashboard/*`）。

---

## 2. 架构总览

```
广告网络 postback ──HTTP──▶ apps/web (Next.js Route Handler)
                                │ extract_fields() → append PG ingest_inbox (UNLOGGED)
                                ▼
                   services/ingest-worker (CronJob) ──批量──▶ records_YYYYMM + user_lookup
XMP / 雅典娜 API ──▶ services/scheduler (CronJob 每整点 fetchAll) ──▶ daily_snapshots / xmp_cache
                                                                │
apps/web 看板 UI (React) ◀── /api/* Route Handlers ◀───── 统一 PostgreSQL
                                │
                          AI 投放建议 (SiliconFlow GLM)
```

**一份代码、一套运行时**：pnpm workspace 单体仓库，只纳管 `apps/*` `services/*` `packages/*`；
Node 22.x / TypeScript 5.7 / pnpm 11；最严格 ESLint（flat config, type-checked）+ Prettier。

---

## 3. 工作区（pnpm workspace）

| 包                                                            | 说明                                                  | 启动脚本                                      |
| ------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| `@agentic-ug/web`                                             | Next.js：看板 UI + `/api/*` + 广告回传上报端点        | `pnpm start`（端口 3000）                     |
| `@agentic-ug/scheduler`                                       | 定时抓取 Job（雅典娜收入 + XMP 消耗）                 | `pnpm job:fetch`                              |
| `@agentic-ug/ingest-worker`                                   | 上报批写 Job（`ingest_inbox` → 月表 + `user_lookup`） | `pnpm job:ingest`                             |
| `@agentic-ug/migrate`                                         | 统一 PG schema 迁移器（幂等）                         | `pnpm --filter @agentic-ug/migrate start`     |
| `@agentic-ug/import-json`                                     | 历史 JSON 快照导入 PG                                 | `pnpm --filter @agentic-ug/import-json start` |
| `@agentic-ug/core` / `@agentic-ug/db` / `@agentic-ug/fetcher` | 共享库（不单独部署）                                  | —                                             |

> `pnpm-workspace.yaml`：`allowBuilds` 里 `esbuild:true`（scheduler 的 tsx 运行时依赖）、`sharp:false`（数据中心不用 next/image 图片优化）。

---

## 4. 数据存储（统一 PostgreSQL）

一个 PG 实例承载全部三层数据（旧的 SQLite `postback.db` + `dashboard/data/*.json` 均已并入）。

主要表：

| 表                | 作用                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records_YYYYMM`  | 广告回传明细，按月分表（7 个索引，惰性建表）                                                                                                             |
| `user_lookup`     | 用户归因派生表（`ON CONFLICT DO NOTHING`）                                                                                                               |
| `athena_revenue`  | 雅典娜收入                                                                                                                                               |
| `ingest_inbox`    | **UNLOGGED** 上报缓冲（接受端 append，写入端排空；重启丢失可接受）                                                                                       |
| `daily_snapshots` | 每日/整点快照，`(kind, date)` 复合主键统一承载所有按日 JSON blob（`kind` ∈ `main`/`personal`/`creative`/`aigc`，替代旧 `dashboard/data/{date}.json` 等） |
| `xmp_cache`       | XMP 消耗缓存（`expires_at`，3 天 TTL，web 请求惰性填充）                                                                                                 |
| `eltv_cache`      | eLTV 拟合缓存                                                                                                                                            |
| `fetch_status`    | 抓取状态（`kind='main'`，scheduler 写 / `/api/status` 读 / `/api/refresh` 判并发；替代旧 fetcher 进程内 `fetchStatus` 对象，单进程内存 → 跨进程 PG）     |

**记录表列顺序**（`packages/db/src/schema.ts` 的 `RECORD_COLUMNS`，16 列，与旧 `dataserver/db.py` **逐字一致**，批量写入元组必须按此序）：`source, app_id, event_name, event_time, revenue, currency, campaign, media_source, ad_id, adset, country, device_id, install_time, is_retargeting, payload, created_at`。

**月表 7+2 索引**（`ensureRecordTable`，惰性建表）：source/app/event/time/created 单列 + `(event_name,event_time)` / `(event_name,install_time)` range 复合（支撑看板单日范围扫描，删了退化全表扫）+ **AF/AD `user_id` 表达式局部索引**（`AF_UID_EXPR`/`AD_UID_EXPR`，供注册去重命中；schema 与 dashboard 查询共用同一字符串以便规划器命中）。

**接受端语义**（`apps/web/src/lib/ingest.ts`）：`enqueue()` 先查 inbox 积压，`≥ QUEUE_MAXSIZE=20000` 返回 **503**（复刻旧内存队列「满则丢弃」）；`buildRecordRow` 抽字段后以 16 元组 JSONB 写 inbox。`popFirst` 逐字复刻 Python `params.pop(a) or params.pop(b) or fallback` 短路语义（命中即停，未命中的 key 保留随 payload 落库）。积压 `≥2000` 每千行告警一次（提示 worker 未在消费）。

**上报读写解耦**（关键改造）：

- **接受端**（`apps/web` Route Handler）：解析 + `extract` 抽字段 → 向 `ingest_inbox` 追加一行；inbox 超阈值返回 **503**，复刻旧「队列满丢弃」语义。
- **写入端**（`services/ingest-worker`，单实例 CronJob）：事务内 `DELETE ... FOR UPDATE SKIP LOCKED` 取批（≤500）→ 批量 INSERT 月表 → 派生 `user_lookup`（仅 `af_complete_registration` 且 payload 含整型 user_id，`ON CONFLICT DO NOTHING`）；失败 ROLLBACK 行留 inbox 下轮重试，**比旧内存队列更不易丢数据**。

> ⚠️ **ingest-worker 历史坑（已写进代码注释，别再踩）**：早期「排空即退出」且部署为 Deployment → 退出即被 k8s 重启 → **CrashLoopBackOff** → inbox 只涨不落。现改为「**定时退出**」：单次运行有时间上限（`INGEST_MAX_RUNTIME_MS`，默认 2 分钟），到点干净退出（`closePool` 后进程结束），靠 CronJob 而非常驻进程维持周期消费。形状不符的畸形行会被丢弃并告警；单轮异常不退出，退避后继续（避免毒行卡死整条管道）；支持 SIGTERM/SIGINT 优雅排空后退出。

schema DDL 见 `packages/db/src/schema.ts`；`services/migrate` 幂等应用全部建表/索引。所有服务在正常与错误分支都调 `closePool()`（否则事件循环不退出 → CronJob 挂起卡死）。

---

## 5. 看板（apps/web）

- **接口**：37 个旧路由中的 `/api/*` 数据接口迁为 App Router **Route Handlers**（`apps/web/src/app/api/*`），业务逻辑收敛到 `apps/web/src/lib/dashboard/*`。
- **鉴权**（`apps/web/src/lib/dashboard/auth.ts`）：旧 express-session（内存 store + 每启动随机 secret）→ 改为**无状态 HMAC 签名 cookie**：密钥优先 `SESSION_SECRET`，未设时从 admin 口令稳定派生（而非每进程随机）——否则**多副本/重启时会「刷新即掉登录」**。cookie 7 天，带 `authenticated`+`panelAccess`（面板二级口令）两位标志。token 另含可选 `oid`(openId)/`nm`(name) 做审计，老 token 无此字段仍有效（向后兼容）。
- **飞书 OAuth + 卡片确认登录（方案 C）**：登录不再靠统一账密，改为「飞书授权拿 open_id → bot 推交互卡片 → 员工在飞书点确认 → 网页种 session」。首次登录走 OAuth（`/auth/start`→`/auth/callback`），二次登录走「你是谁」下拉直接推卡片（`/login/pick`）；网页轮询 `/login/status` 等确认。卡片按钮回调走**飞书长连接**（`@larksuiteoapi/node-sdk` 的 `WSClient`+`EventDispatcher('card.action.trigger')`，公网关闭也能收），在 `apps/web/src/instrumentation.ts` 单例启动。飞书封装在 `apps/web/src/lib/feishu/{client,store,card-consumer}.ts`，用户/挑战存 PG 表 `fs_user`/`login_challenge`（幂等 DDL 在 `packages/db/src/schema.ts` 的 `ensureAuthTables`，migrate 自动应用）。账密兜底仅 `LEGACY_ADMIN_LOGIN=1` 时保留（应急，默认关）。配置见 `config.ts` 的 `feishu`/`baseUrl`/`legacyAdminLogin`（env：`FEISHU_APP_ID`/`FEISHU_APP_SECRET`/`APP_BASE_URL`/`LEGACY_ADMIN_LOGIN`）。规格全文见 `docs/feishu-oauth-card-login-spec.md`。
- 面板定义集中在 `apps/web/src/lib/panels.ts`（URL 以路径表达当前面板，刷新可直达，未知路径归一到汇总）：汇总`/` / 个人`/personal` / 素材`/creative` / AIGC`/aigc` / 「API接收数据」`/postback`。
- **前端**：旧 3447 行原生 JS SPA 改为 React（App Router 页面 `apps/web/src/app/*/page.tsx` + `apps/web/src/components/*`）。
- **健康检查**：`GET /health` 返 `{status,version,queue_size,current_table}`（对齐旧 dataserver 根路由）；`/api/status` 读 `fetch_status`，`/api/refresh` 判抓取并发。
- **接口保护 `guard.ts`**（复刻旧 `api-guard.js`，四层）：
  1. **绝对硬范围闸** `HARD_MAX_RANGE_DAYS=45`（对所有人含真人 session 生效，超返 429，防单个超大同步查询卡死事件循环）；
  2. **浏览器 session 豁免**（登录真人不计账、不设超时）；
  3. **M2M 总闸** `BLOCK_M2M=1`（带 `?key=` 或 `Authorization` 的机器取数一律 503，复刻旧「M2M 已禁用」止血策略）；
  4. 机器取数才受的细闸：单请求日期跨度≤ `MAX_RANGE_DAYS=14`（超 429）、每 IP `≤30/min`、每 IP 并发`≤4`、全局并发`≤8`、单请求硬超时 `180s` → 提断+503。
     阈值均 env 可调（`GUARD_*`）。计数器为进程内单例，**单副本部署与旧版逐字对齐；多副本需将计数器外部化**（Redis 等，见部署说明）。
- **对外取数**：`apps/web/src/app/api/ext/*`（records / xmp / xmp-report / xmp-material / xmp-fields / meta），配套 skill 包 `apps/web/public/downloads/richang-daily-data.skill`。
  - ⚠️ **这个 skill 包无独立源、直接改 zip**：`.skill` 就是一个 zip（内含 `richang-daily-data/SKILL.md` + `references/api-reference.md`），仓库里没有它的源目录。要改内容：解压 → 改 Markdown → 重新 `zip -r -X` 打包回同名文件（保持 `richang-daily-data/` 目录层级）。

### 面板一览

| 面板             | 逻辑位置                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| 汇总面板         | `lib/dashboard/af-summary.ts` / `channel-summary.ts` + `components/panels/summary-panel.tsx`                   |
| 个人面板         | `lib/dashboard/personal.ts` / `postback.ts` / `personal-snapshots.ts` + `components/panels/personal-panel.tsx` |
| 素材 / AIGC 面板 | `lib/dashboard/creative.ts` / `creative-snapshots.ts` + `components/panels/{creative,aigc,material}-panel.tsx` |
| AI 投放建议      | `lib/dashboard/campaign-context.ts` + `api/llm/chat` + `prompts/{投放大师,AI投放决策}.md`                      |

---

## 6. 核心业务口径（迁移零差异）

- **11 个产品**：Android — Dora And / Doni / Jovia And / Romi And / Kira And / Nalo And；iOS — Dora iOS / Romi iOS / GraceChat / Luma / Kira iOS。投放渠道 Facebook(Meta) / Google / TikTok，消耗经 XMP 统一。
- **修正系数** = `雅典娜收入 / AF+AD 非自然量收入 × 0.95`（安卓单系数，iOS 分 FB/非FB）。逻辑见 `lib/dashboard/correction-factors.ts`。
- **eLTV ROAS** = 新用户 ROAS × D 系列 LTV 倍数（指数衰减拟合，按产品×渠道独立），逻辑见 `lib/dashboard/eltv.ts`。
- **注册去重**：`af/ad_complete_registration` 按 user_id 在查询范围内去重（修正 CPI 虚高），逻辑见 `lib/dashboard/dedup.ts`。
- **新用户收入** = install_time 在当天（北京时间）且 diff < 24h。

> 这些口径与 `SERVER_OVERVIEW.md` 描述的旧线上完全一致，工程化版只是换实现、不改公式。需要更细的口径演进历史，可回查 `SERVER_OVERVIEW.md` 及其 `docs/` 专家文档（那是旧实现的第一手记录）。

---

## 7. 定时任务（一次性 CronJob）

- 旧看板的自纠偏 `setTimeout` 常驻调度 → 改为 **k8s CronJob 拉起一次性 Job**：
  - `services/scheduler`：每整点（Asia/Shanghai）跑一次 `fetchAll`（雅典娜收入 + XMP 消耗）后退出，北京 0 点自动收尾抓昨日（分支在 `fetchAll` 内按北京时刻判定）；素材/AIGC 抓取（`fetchCreativeAll`）因 XMP AD 级分页限速重，**仅在北京 1 点跑一次**（快照 upsert 幂等，重跑安全）；无常驻进程、无漂移。
  - `services/ingest-worker`：周期排空 `ingest_inbox` 批量落库（**定时退出**模式，见「4. 数据存储」CrashLoopBackOff 坑）。
- 各服务补 `closePool()`，**错误分支也关连接池**，避免进程挂起卡死 CronJob。
- XMP 缓存周期预热暂缓 → 改由 web 请求**按需惰性填充**（3 天 TTL），只是延迟优化，不影响正确性。

---

## 8. 部署形态

**单镜像**（`deploy/Dockerfile`）同时承载常驻 web 与周期任务：

| 角色                   | 命令              | 说明                                               |
| ---------------------- | ----------------- | -------------------------------------------------- |
| web（常驻 Deployment） | `pnpm start`      | 端口 3000，看板 + `/api/*` + S2S postback 回传端点 |
| CronJob `fetch`        | `pnpm job:fetch`  | 每整点抓雅典娜收入 + XMP 消耗                      |
| CronJob `ingest`       | `pnpm job:ingest` | 周期排空 `ingest_inbox` 落库                       |

k8s 清单与配置/密钥由 **dora-k8s-config** 平台维护（对应其 PR #141，`charts/service` + `features.databases`）。
密钥（飞书 APP_ID/SECRET、XMP、雅典娜、LLM、DATABASE_URL 等）走环境变量，生产由 k8s Secret/ConfigMap 注入；清单见 `.env.example`。

**Dockerfile 多阶段单镜像**（`deploy/Dockerfile`）：底座 `node:22-slim` + corepack；`build` 阶段 `pnpm install --frozen-lockfile` + `pnpm -r build`；构出三个 target — `web`（Next standalone，`node server.js`，`EXPOSE 3000`）、`ingest-worker`（`node dist/main.js`）、`scheduler`（`pnpm start`）。同一镜像多 target，保证 web 与周期任务跑完全相同代码。

---

## 9. 本地开发

```bash
pnpm install
cp .env.example .env          # 填 DATABASE_URL / XMP / 雅典娜 / LLM 等
pnpm --filter @agentic-ug/migrate start   # 建表（幂等）
pnpm dev                       # 或 pnpm --filter @agentic-ug/web dev

# 全仓库质量门禁
pnpm build          # 递归构建所有包
pnpm typecheck      # 全仓库类型检查
pnpm lint           # ESLint（flat config, type-checked）
pnpm format         # Prettier
```

**首次数据准备（历史迁移）**：

1. `services/migrate` 建表；
2. `services/import-json` 把旧 `dashboard/data/` 按日快照 / eLTV 缓存 JSONB passthrough 灌入 PG；
3. `scripts/pg-backfill/` 回填历史明细。

---

## 10. 零差异校验要点

- 上报「队列满丢弃 → 503」语义复刻；落库批量 / 月表惰性建表 / `user_lookup` 派生一致。
- 历史快照与 eLTV 缓存经 `import-json` 灌入后，看板历史日期与旧实现一致。
- 修正系数、eLTV 拟合等业务口径**不改公式**。

---

## 11. 旧代码归档（archive/）

旧架构已整体 `git mv` 到 `archive/`（历史完整保留，只读参照，**不参与构建/部署**）。需参照旧实现时直接读 `archive/…`。映射：

| 归档路径                          | 旧实现                                                                           | 被谁取代                                                           |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `archive/dashboard/`              | Express `server.js`（~5000 行、37 路由）+ `fetcher.js` + 原生 SPA + `data/` JSON | `apps/web` + `packages/fetcher` + `services/scheduler`             |
| `archive/dataserver/`             | FastAPI `app.py`（~490 行，asyncio.Queue+batch_writer，SQLite）                  | 上报 Route Handlers（写 `ingest_inbox`）+ `services/ingest-worker` |
| `archive/scripts/`                | 旧 js/py/sh 辅助脚本（抓取、飞书写表、UG 早报、审计对账）                        | 抓取逻辑迁入 `packages/fetcher`；一次性脚本不再随运行时保留        |
| `archive/{analysis,config,docs}/` | 一次性分析 / 旧 MCP 配置 / 旧服务技术文档                                        | 大都仅存档；外部 API 参考仍可从 `archive/docs/` 查                 |
| `archive/SERVER_OVERVIEW.md`      | 旧架构完整总览（~74KB）                                                          | 根 `README` + `REFACTORY_NOTE` + 本文件                            |

> ⚠️ 工作区根目录的 `SERVER_OVERVIEW.md`（我平时排查用的那堆运维知识）描述的是**服务器上正在跑的旧生产环境**，与仓库里的 `archive/SERVER_OVERVIEW.md`（归档副本）同源。工程化版上线前，生产仍是旧架构，旧文档仍是现网一手资料。

---

## 12. 给未来的自己（维护提示）

- **想改业务口径 / 排查数据对不上** → 先看 `apps/web/src/lib/dashboard/*`（那是口径唯一真源），必要时对照 `SERVER_OVERVIEW.md` 的旧口径演进史。
- **想加新接口** → `apps/web/src/app/api/<name>/route.ts` + 逻辑放 `lib/dashboard/`，别把业务塞进 route 文件。
- **改 schema** → 只动 `packages/db/src/schema.ts`（幂等 DDL），靠 `services/migrate` 应用，别手写迁移。
- **改抓取** → `packages/fetcher/src/*`，不要再退回 shell 脚本链。
- **旧实现细节 / 踩坑史** 仍在 `SERVER_OVERVIEW.md` + `docs/` + `archive/`，工程化版遇到相同业务问题先去那边找一手记录。
- 本文件是工程化版的**入口**：以后屹恒说「读 AgenticUG.md」= 从这里切进新 main 分支的上下文。
