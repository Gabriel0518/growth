# Agentic-UG-Demo → Next.js 全量改造计划

> 目标：将现有 **Python FastAPI 数据中心** + **Express 数据看板** 整体改造为一套
> **Next.js（App Router）+ Node.js CLI Worker** 的 TypeScript 单体仓库，数据统一到
> **单个 PostgreSQL 实例**，功能与现网**零差异**。
>
> 分支：`personal/duhuan/production`。本文件仅为方案，代码分阶段落地。

---

## 0. 决策基线（已与需求方确认）

| 维度                     | 决策                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| Dashboard                | 迁移到 Next.js（App Router + React + TS）                             |
| 数据中心 HTTP 逻辑       | 原 FastAPI 端点**完全迁到 Next.js** Route Handlers                    |
| 数据中心 uvloop/批写逻辑 | 改用 **Node.js CLI 常驻进程**重写（不再用 Python）                    |
| 数据库                   | 三层存储（PG + SQLite postback.db + JSON 文件）**统一到一个 PG 实例** |
| 语言/运行时              | TypeScript 最新版、Node.js LTS（22.x）、pnpm 11                       |
| 代码规范                 | 最严格 ESLint（flat config, type-checked）+ 最新 Prettier             |

---

## 1. 现状盘点（量化）

### 1.1 数据中心 `dataserver/`（Python，490 行）

- **10 个端点**：`GET/POST /adjust`、`GET/POST /appsflyer`、`POST /data`（上报）、
  `GET /data`（查询）、`GET /stats`、`GET /`（健康）、`POST/GET /admin`（雅典娜收入）。
- **核心异步管线**：`asyncio.Queue(maxsize=20000)` 有界队列 → `enqueue_record()`
  在请求线程内做字段抽取（`extract_fields`）并入队，**队列满则丢弃返回 503**；
  后台 `batch_writer()` 单协程按 `BATCH_SIZE=500` / `FLUSH_INTERVAL=1.0s` 批量
  `executemany` 写入 `records_YYYYMM`，并从 `af_complete_registration` 事件里
  解析 `user_id` 落 `user_lookup`（`ON CONFLICT DO NOTHING`）。
- **按月分表**：`records_YYYYMM`，7 个索引；写入时惰性 `ensure_record_table`。
- **维护协程**：每日 04:00 记录库大小。
- 部署：uvicorn 2 workers + uvloop + httptools，端口 5000。

### 1.2 数据看板 `dashboard/`（Express，server.js 5003 行）

- **37 个 HTTP 路由**（见 §6 映射表），其中约 30 个 `/api/*` 数据接口 + 登录/登出/面板解锁。
- **85 处 `db.prepare(...)`**：SQLite→PG 查询体尚未落地（当前 PR 遗留项）。
- **鉴权**：`express-session`（Cookie）+ 共享口令兜底（`?key=` / `Bearer`），
  `requireAuth` 中间件；面板二级口令 `panelAccess`。
- **定时任务**（自纠偏 `setTimeout`，防漂移）：`scheduleSummary`（每小时抓数）、
  `scheduleXmpWarm`（每小时预热 XMP）、`scheduleXmpYesterdayBackfill`（每日回补）、
  `cleanXmpCache`（每 6h）。
- **外部集成**：XMP Open API、雅典娜收入 API、LLM（SiliconFlow GLM，`/api/llm/chat`）。

### 1.3 前端 `dashboard/public/`（原生 SPA）

- `app.js` **3447 行** 原生 JS + `index.html` 614 行 + `style.css` 41KB。
- 多 Tab 面板：总览 / 汇总卡片、明细表、图表、Postback、个人号、素材(creative)、AIGC 等
  （`<section class="summary-cards|table-section|chart-section">` 多区块）。

### 1.4 三层存储（**统一目标的关键**）

1. **PostgreSQL**（`db.js` pg pool）：`records_YYYYMM`、`user_lookup`、`athena_revenue`。
2. **SQLite `postback.db`**（`better-sqlite3`，`POSTBACK_DB_PATH`，只读为主）：
   校正因子（correction-factors）、postback 明细、ELTV 相关。
3. **JSON 文件**（`dashboard/data/`）：`YYYY-MM-DD.json` 每日快照（fetcher 写）、
   `xmp-cache/*.json`、`eltv-cache.json`、`eltv-hwm.json`。

### 1.5 脚本生态 `scripts/`（70 个 js/py/sh）

- **运行时被 fetcher 调用**（必须迁移）：`fetch-revenue.sh`、`fetch-xmp-api.sh`、
  `fetch-af.sh`、`fetch-personal-{xmp-api,ad,af}.sh`——这些 `.sh` 内部再 `node scripts/*.js`
  或 `curl`。`backfill-check.js` 每日校验回补。
- **一次性/分析类**：审计、对账、论文图表等（不进运行时，保留或归档）。

---

## 2. 目标架构

```
Agentic-UG-Demo/                 # pnpm workspace 单体仓库
├─ pnpm-workspace.yaml
├─ package.json                  # 根：私有、workspaces、共享 devDeps（ESLint/Prettier/TS）
├─ tsconfig.base.json            # 严格 TS 基线
├─ eslint.config.mjs             # flat config，type-checked，全仓库统一
├─ .prettierrc.mjs
├─ apps/
│  └─ web/                       # Next.js（App Router）——承载：
│      ├─ 数据看板 UI（React）
│      ├─ 看板 /api/* 接口（Route Handlers）
│      └─ 数据中心上报端点（/ingest/adjust /ingest/appsflyer /ingest/data …）
├─ services/
│  ├─ ingest-worker/             # Node.js CLI 常驻进程（uvloop 批写逻辑的替代）
│  │   └─ src/main.ts            # 消费 inbox → 批量写 records_YYYYMM + user_lookup
│  └─ jobs/                      # 一次性 CLI 命令集（由 k8s CronJob 触发）
│      └─ src/{fetch-summary,xmp-warm,xmp-backfill,clean-cache}.ts
├─ packages/
│  ├─ db/                        # 共享：pg Pool、schema DDL、迁移、查询封装
│  ├─ core/                      # 共享：字段抽取(extract_fields)、类型、时间/表名工具
│  └─ integrations/              # 共享：XMP / 雅典娜 / LLM 客户端（替代 .sh+node 脚本）
└─ migrations/                   # 单 PG 实例的建表 + 三层存储数据迁移脚本
```

**数据流（上报）**：

```
广告网络 postback ──HTTP──▶ Next.js Route Handler（apps/web）
        │  extract_fields() 后 append 到 PG ingest_inbox（UNLOGGED 表，轻量单行插入）
        │  inbox 行数超阈值 → 返回 503（复刻"队列满丢弃"语义）
        ▼
services/ingest-worker（单实例 CLI）
        │  批量 SELECT ... FOR UPDATE SKIP LOCKED / DELETE RETURNING（BATCH_SIZE/FLUSH_INTERVAL）
        ▼
  records_YYYYMM（7 索引）+ user_lookup（ON CONFLICT DO NOTHING）
```

### 2.1 为什么 uvloop 逻辑要拆成独立 CLI 进程

Next.js Route Handler 是**请求作用域 + 多副本/多 isolate**，无法在其中稳定持有
「常驻内存队列 + 单例后台 flush 协程」。因此把「接受上报」（可水平扩容）与
「批量写库」（必须单实例、有序、可优雅退出）解耦：

- **接受端**（Next.js）：只做解析 + 抽字段 + 向 `ingest_inbox` 追加一行（未加重索引，开销远低于直接写 `records_YYYYMM` 的 7 索引表）。
- **写入端**（CLI worker）：复刻原 `batch_writer` 的批量/定时 flush、月表惰性建表、
  `user_lookup` 派生、优雅退出 flush。用 `FOR UPDATE SKIP LOCKED` 保证多次启动/单实例安全。

> 备选：`instrumentation.ts` 内进程内队列——**否决**，多副本时各自持队列、worker 无法单例，且丢失优雅退出保证。
> 备选：Redis LIST 作为 inbox——吞吐更高，但违背「统一到一个 PG 实例」，仅在压测证明 PG inbox 成为瓶颈时再引入。

---

## 3. 工程规范与工具链

### 3.1 pnpm 11 workspace

- `packageManager: "pnpm@11.x"`，根 `pnpm-workspace.yaml` 纳管 `apps/*` `services/*` `packages/*`。
- 内部包用 `workspace:*` 依赖；`pnpm -r` 统一构建/lint/test。

### 3.2 TypeScript（最新）+ Node LTS

- `tsconfig.base.json`：`"strict": true` 全开，另加
  `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、
  `noFallthroughCasesInSwitch`、`verbatimModuleSyntax`、`moduleResolution: "bundler"`。
- `engines.node: ">=22 <23"`（Node 22 LTS）；`.nvmrc` 锁定。
- 目标 `ES2023`，`module: ESNext`，全仓库 ESM。

### 3.3 最严格 ESLint（flat config，type-checked）

- `eslint.config.mjs`：`@eslint/js` recommended + `typescript-eslint`
  `strictTypeChecked` + `stylisticTypeChecked`，接入 `languageOptions.parserOptions.projectService`。
- 叠加 `eslint-plugin-import`（顺序/循环依赖）、`eslint-plugin-unicorn`、
  `@next/eslint-plugin-next`（apps/web）、`eslint-plugin-react-hooks`。
- `--max-warnings=0`，CI 阻断。

### 3.4 最新 Prettier

- `prettier` 最新 + `.prettierrc.mjs`：`printWidth 100`、`singleQuote`、`semi`、
  `trailingComma: "all"`、`endOfLine: "lf"`。ESLint 侧用 `eslint-config-prettier` 关闭风格冲突，
  格式化交给 Prettier（不用 eslint-plugin-prettier 以免噪声）。
- `pnpm format` / `pnpm format:check`；pre-commit（lint-staged + husky 或 simple-git-hooks）。

---

## 4. 数据层统一到单个 PG（三合一）

在 `packages/db` 定义**唯一** schema，`migrations/` 提供幂等建表 + 数据迁移。

| 现存储                      | 现内容                                        | 目标 PG 表                                                         | 迁移脚本                                            |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| PG（已迁）                  | records_YYYYMM / user_lookup / athena_revenue | 原样保留                                                           | 复用 `migrate_sqlite_to_pg.py` 逻辑改写为 TS        |
| SQLite `postback.db`        | 校正因子、postback 明细、ELTV                 | `postback_records`、`correction_factors`、`eltv_*`（结构化表）     | `migrations/import-postback-sqlite.ts` 读旧 db → PG |
| JSON `data/YYYY-MM-DD.json` | 每日快照（snapshots[] 含 athena/xmp/ad/af）   | `daily_snapshots(date PK, payload JSONB, updated_at)`              | `migrations/import-json-snapshots.ts`               |
| JSON `xmp-cache/*.json`     | XMP 抓数缓存                                  | `xmp_cache(cache_key PK, payload JSONB, expires_at)`               | 同上（可选：过期即弃）                              |
| JSON `eltv-cache/hwm.json`  | ELTV 计算缓存                                 | `eltv_cache(key PK, payload JSONB, updated_at)`                    | 同上                                                |
| 内存/新增                   | 上报缓冲                                      | `ingest_inbox`（UNLOGGED：id BIGSERIAL, row JSONB/列, created_at） | 新建                                                |

要点：

- SQLite-ism 全部转 PG（`julianday`→`EXTRACT(EPOCH ...)`、`strftime`→`to_char`、
  `INSERT OR IGNORE`→`ON CONFLICT`、`sqlite_master`→`pg_tables`、`?`→`$N`）。
- `daily_snapshots`/`xmp_cache` 用 JSONB 保留原始结构，**先求零差异**，后续再逐步结构化下沉。
- 所有连接参数走环境变量（`DATABASE_URL` 优先），沿用现 `.env.example`。

---

## 5. 数据中心改造（FastAPI → Next.js + CLI Worker）

### 5.1 上报端点 → `apps/web/app/(ingest)/...`（Route Handlers）

| 原 FastAPI            | 新 Route Handler                | 说明                                               |
| --------------------- | ------------------------------- | -------------------------------------------------- |
| `GET/POST /adjust`    | `app/ingest/adjust/route.ts`    | query/body 归一，`network                          | platform` 取 source，`_platform=ad` |
| `GET/POST /appsflyer` | `app/ingest/appsflyer/route.ts` | `media_source                                      | af_channel                          | platform` 取 source，`_platform=af` |
| `POST /data`          | `app/ingest/data/route.ts`      | JSON body，`source` 缺省 unknown                   |
| `GET /data`           | `app/api/records/route.ts`      | 分页查询（$N 占位、月表选择）                      |
| `GET /stats`          | `app/api/stats/route.ts`        | `pg_database_size` + 月表计数                      |
| `GET /`（健康）       | `app/api/health/route.ts`       | 返回 inbox 深度、当前月表                          |
| `POST/GET /admin`     | `app/api/athena/route.ts`       | 雅典娜收入 upsert（JSONB items，ON CONFLICT date） |

- 抽字段逻辑 `extract_fields` → `packages/core/extract.ts`（**逐字段对齐** Python 版：
  币种优先 USD、`is_retargeting` 0/1、payload JSON 序列化、`created_at` 本地时刻串）。
- 「队列满丢弃」→ 接受前 `SELECT count(*) FROM ingest_inbox`（或维护计数），超 `QUEUE_MAXSIZE` 返回 503。

### 5.2 uvloop 批写 → `services/ingest-worker`（Node CLI）

逐条复刻 `batch_writer()` 语义：

- `pg` 连接池；循环：`FLUSH_INTERVAL` 内累计到 `BATCH_SIZE` 或超时即 flush。
- 消费：`DELETE FROM ingest_inbox WHERE id IN (SELECT id FROM ingest_inbox ORDER BY id LIMIT $n FOR UPDATE SKIP LOCKED) RETURNING *`（单实例下有序、可并发安全）。
- 写入：`INSERT INTO records_YYYYMM (...) VALUES ...`（批量），月表切换时惰性 `ensureRecordTable`。
- 派生 `user_lookup`：`af_complete_registration` 且 payload 含 `user_id`（复刻嵌套 JSON 解析），`ON CONFLICT (user_id) DO NOTHING`。
- 优雅退出：`SIGTERM` → 停止取新、flush 残余、关池。
- 维护：每日 04:00 记录库大小（可并入 worker 或独立 cron）。
- CLI 形态：`pnpm --filter ingest-worker start`，容器 `CMD ["node","dist/main.js"]`。

---

## 6. Dashboard 改造（Express → Next.js）

### 6.1 API 路由映射（37 → Route Handlers / Server Actions）

| 分组      | 原路由                                                                                                     | 新位置                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 鉴权      | `/login` `/logout` `/api/panel-access`                                                                     | `app/login` + `middleware.ts` + `app/api/panel-access` |
| 主数据    | `/api/data` `/api/data/latest` `/api/dates` `/api/status`                                                  | `app/api/data/*`                                       |
| 个人号    | `/api/personal/{data,status,refresh}`                                                                      | `app/api/personal/*`                                   |
| Postback  | `/api/postback/{data,personal,dates}`                                                                      | `app/api/postback/*`                                   |
| 校正/ELTV | `/api/correction-factors` `/api/eltv-multipliers`                                                          | `app/api/correction-factors` 等                        |
| 抓数/回补 | `/api/refresh` `/api/xmp-backfill`                                                                         | `app/api/refresh` `app/api/xmp-backfill`               |
| 素材/AIGC | `/api/creative/data` `/api/aigc/data`                                                                      | `app/api/creative` `app/api/aigc`                      |
| 汇总/分析 | `/api/af-summary` `/api/channel-summary` `/api/overview` `/api/campaign-context` `/api/revenue-by-install` | `app/api/*`                                            |
| 外部/扩展 | `/api/ext/*`（records/xmp/xmp-report/material/fields/meta）                                                | `app/api/ext/*`                                        |
| LLM       | `/api/llm/chat`                                                                                            | `app/api/llm/chat`（流式用 `ReadableStream`）          |
| 用户查询  | `/api/user-lookup`                                                                                         | `app/api/user-lookup`                                  |

- **85 处 `db.prepare`** → `packages/db` 里的参数化查询（$N）。逐条建立
  「SQL → 期望结果」快照用例（见 §9），迁移一条、比对一条。

### 6.2 鉴权

- `express-session` Cookie → Next.js `middleware.ts` 校验会话 Cookie（`iron-session` 或
  签名 Cookie）；机器访问 `?key=`/`Bearer` 兜底逻辑等价复刻；`panelAccess` 二级口令保留。
- 口令仍来自 `DASHBOARD_ADMIN_PASS` 环境变量，常量时间比较。

### 6.3 定时任务（**已定：k8s CronJob**）

- 现 `setTimeout` 自纠偏调度**不放进 Next.js**（多副本会重复触发）。
- **统一改用 k8s CronJob**（复用 dora-k8s-config 的 cronjob 能力，天然单实例、与平台一致），
  每个定时任务对应一个「一次性 CLI 命令」，命令集中在 `services/jobs`：
  | 原调度                         | 频率   | 新 CronJob 命令                                          |
  | ------------------------------ | ------ | -------------------------------------------------------- |
  | `scheduleSummary`              | 每小时 | `node dist/fetch-summary.js`（抓数写 `daily_snapshots`） |
  | `scheduleXmpWarm`              | 每小时 | `node dist/xmp-warm.js`                                  |
  | `scheduleXmpYesterdayBackfill` | 每日   | `node dist/xmp-backfill.js`（并入 `backfill-check`）     |
  | `cleanXmpCache`                | 每 6h  | `node dist/clean-cache.js`（清 `xmp_cache` 过期行）      |
- CronJob 清单写进 dora-k8s-config（`charts/service` 的 `cronjob.enabled`），
  与 `ingest-worker`、`web` 共用同一镜像/环境变量。

### 6.4 前端（3447 行原生 JS → React）

- `index.html` 的多 Tab 区块 → App Router 布局 + 客户端组件；每个 Tab 一个路由段或
  一个 `"use client"` 面板组件。
- `app.js` 的渲染/取数/图表逻辑按 Tab 拆分为组件 + hooks（`useSWR`/`fetch`）。
- 图表库沿用现方案（若为 Chart.js/ECharts，按现调用迁移，保持视觉一致）。
- `style.css`（41KB）先整体迁入 `globals.css` 保证像素一致，后续再模块化。
- **验收以视觉/交互零差异为准**（见 §9 前端 QA）。

---

## 7. 脚本生态处理

- **运行时抓数脚本**（`fetch-*.sh` + 其调用的 `node scripts/*.js`）→ 重写为
  `packages/integrations` 内的 TS 客户端（XMP/雅典娜/AF），由 Next.js `/api/refresh`
  与 scheduler 直接调用，**去掉 shell + curl + python3 依赖链**，镜像更干净。
- **`backfill-check.js`** → `services` 内 TS 任务或 k8s CronJob。
- **一次性/分析脚本**（审计、对账、论文）→ 迁到 `scripts/legacy/` 保留，不进生产镜像；
  与业务无关的个人脚本按现 `.gitignore` 规则继续排除。

---

## 8. 分阶段实施计划

| 阶段             | 内容                                                                         | 产出/验收                    |
| ---------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| **P0 骨架**      | pnpm workspace、TS 基线、ESLint/Prettier、CI lint 门禁、`packages/db` schema | `pnpm -r lint && build` 通过 |
| **P1 数据统一**  | `migrations/` 三层→单 PG；本地跑通迁移、行数/校验和比对                      | 迁移报告：各表行数与源一致   |
| **P2 数据中心**  | ingest 端点（Next.js）+ ingest-worker（CLI）+ inbox；压测                    | QPS/丢弃/落库与旧版对齐      |
| **P3 看板 API**  | 37 路由 + 85 查询逐条迁移，鉴权/中间件                                       | 每路由 golden 用例比对通过   |
| **P4 前端**      | index.html/app.js → React，逐 Tab 搬迁                                       | 视觉/交互 QA 零差异          |
| **P5 调度/脚本** | scheduler/CronJob + integrations TS 客户端                                   | 抓数产物与旧脚本一致         |
| **P6 部署衔接**  | 更新 jenkins-projects / dora-k8s-config（见 §10）                            | dev 环境两镜像跑通           |

---

## 9. 「功能零差异」验证策略

- **DB 层**：迁移后对每张表做 `count(*)` + 关键列校验和（如 `sum(revenue)`、
  按天分组）源/目标比对，输出差异报告。
- **数据中心**：录制真实 postback 样本，回放到新旧两端，比对落库行（字段级 diff）；
  用 `autocannon` 压测 ingest 端点，核对丢弃阈值与批写吞吐。
- **看板 API**：对 37 路由建**黄金查询集**（固定 date/product/channel 参数），
  新旧响应 JSON 做结构化 diff（复用现 `dashboard/validate-rbi.sh` 思路，扩展到全部接口）。
- **前端**：用 `/qa` 或 `browse` skill 逐 Tab 走查金路径 + 边界，与现网截图对比。
- **回归门禁**：CI 跑 lint（0 warning）+ typecheck + 迁移比对 + API 黄金集。

---

## 10. 对现有部署三件套的影响

改造后由「Python dataserver + Node dashboard 两服务」变为
「**Next.js web 一镜像 + ingest-worker 一镜像**」：

- **jenkins-projects**（PR #27 已开）：`dev.yaml` 两 service 改为
  `agentic-ug-demo-web`（Next.js `output: standalone`，多阶段 pnpm 构建）与
  `agentic-ug-demo-ingest-worker`（node CMD）。Dockerfile 相应替换。
- **dora-k8s-config**（PR #135 已开）：`agentic-ug-demo-web` 用 `runtime: nodejs`
  （承载看板 + ingest 端点，含公网 ingress）；`ingest-worker` 用 `runtime: nodejs`
  但 `deployment` 常驻单副本（或 CronJob 承载调度），无 ingress。
  DB 仍指向单一 `agentic_ug` 库。
- **源码 PR #1**：本改造在其之上推进；PG schema 从「dataserver 写、dashboard 读」
  扩展为「统一 schema + inbox + snapshots + postback + eltv」。

---

## 11. 已定决策与剩余风险

**已定决策**

- **调度**：统一走 **k8s CronJob**（`services/jobs` 一次性命令，单实例、与平台一致），
  不再用常驻 scheduler。见 §6.3。
- **inbox 吞吐**：**用 PG `ingest_inbox` 抗**。评估：本服务是低频 postback（非高并发写热点），
  每条一次轻量插入 UNLOGGED 表 + worker 批量下沉到带索引的 `records_YYYYMM`，DB 足以承载；
  **不引入 Redis**，坚持「单 PG 实例」约束。P2 仍做一次压测确认阈值，但默认不改架构。

**剩余风险**

1. **前端 3447 行**：视觉零差异成本高，先整体样式迁入 + 逐 Tab 组件化，避免一次性重写。
2. **85 查询体**：SQLite-ism 与业务口径（校正因子、ELTV、install 归因）需连真库逐条比对，
   工作量集中在 P3。
3. **雅典娜/XMP 凭证**：迁移期需同时对旧脚本与新 TS 客户端可用，密钥仍走环境变量。

---

## 12. 结论

- Dashboard→Next.js、数据中心 HTTP→Next.js、批写→Node CLI、三层存储→单 PG，
  方案自洽且与现有 k8s/Jenkins 平台衔接顺畅。
- 关键设计点是**用 PG `ingest_inbox` 解耦「Next.js 接受」与「CLI 单实例批写」**，
  以在 Next.js 的多副本模型下复刻原 uvloop 队列语义。
- 建议按 P0→P6 分阶段落地，每阶段以「零差异比对」为验收门禁，降低一次性大重写风险。
