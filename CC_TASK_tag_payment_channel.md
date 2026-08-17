# CC 任务：给 AD ad_purchase 事件补「支付渠道」字段（PG 生产版，新建 service + CronJob）

## 目标
在 monorepo `/home/admin/projects/agentic-ug-web` 里新建 `services/tag-payment-channel`，
把已在旧 SQLite 环境跑通的 `/home/admin/dataserver/tag_payment_channel.py` 逻辑**逐字搬到 PG**，
做成「有界一次性 Job + k8s CronJob 周期拉起」的同形态服务（与 `services/scheduler` / `services/ingest-worker` 完全一致的风格）。

## 背景/口径（已用真实数据验证，直接照搬，别自作主张改算法）
- 数据源：`POST https://admin-api-prod.sitin.ai/api/open/admin/paid-orders`，body `{"start":"<UTC ISO>","end":"<UTC ISO>"}`（如 `2026-07-14T23:00:00Z`）。返回 `data.orders[]`，每条含 `paidAt`（UTC ISO 带毫秒，如 `2026-07-14T23:00:08.000Z`）、`amount`（字符串如 `"3.99"`）、`channel`（支付渠道）、`appName`、`userId`、`orderKey`。响应有 `success` 布尔。订单按 paidAt 升序。
- 支付渠道 3 种：`Apple Pay`、`WAFFO`、`ONERWAY`。（curl 只返回 Romi/Luma 两个 iOS 产品；AD 库里还有 Dora iOS，curl 不返回，这些走默认 Apple Pay。）
- AD `ad_purchase` 的 `event_time` 是 Unix 秒（UTC），与订单 paidAt 对应，但两系统有 1~30s 双向抖动（p95≈140s，最大 632s）。**绝不能按秒精确匹配**（精确匹配率仅 6%）。
- 认证头：`Authorization: Bearer ${PAID_ORDERS_API_TOKEN}`（生产 k8s Secret 注入；本地验证用 `.env` 里的真实值）。
- PG 连接用 **`AGENTIC_UG_DATABASE_URL`**，**`ssl: false`**（DSN 里已带 `?sslmode=disable`，但仍显式在 Pool 配置写 `ssl:false` 以防万一）。

## 关键 PG 适配点（务必注意，别踩坑）
1. **`event_time` 在 PG 月表里是 TEXT 存的 Unix 秒**（见 `packages/db/src/schema.ts` 建表 DDL：`event_time TEXT`）。查询/比较必须 `CAST(event_time AS BIGINT)`。
2. **月表名要按 UTC 算**。`packages/core/src/tables.ts` 的 `tableForDate` 是**本地时区**推月份 → 跨月边界会算错。**不要复用它**，在本 service 内写一个 UTC 版助手：给定 Unix 秒 → `records_YYYYMM`（用 `new Date(sec*1000).getUTCFullYear()/getUTCMonth()`）。跨月边界（每月 1 号 0 点那一小时）winStart/winEnd 各自算表名，可能得两张表，**只查实际存在的表**（先查 `information_schema.tables` 或 `to_regclass('public.<name>')` 判断存在）。
3. **DSN 不复用 `packages/db` 的 `resolveDsn()`**（那个只认 `DATABASE_URL`、没设 ssl）。本 service 自己 `new pg.Pool({ connectionString: process.env.AGENTIC_UG_DATABASE_URL, ssl: false })`。不要改动 `packages/db`（会影响 ingest-worker）。
4. **写回用 JSONB**：`UPDATE <table> SET payload = jsonb_set(payload, '{payment_channel}', to_jsonb($1::text)) WHERE id = $2`。幂等（重跑覆盖，可安全补跑）。
   - ⚠️ 注意：`schema.ts` 里 payload 列是 **TEXT**（不是 jsonb 列！AF_UID_EXPR 里用的是 `payload::jsonb->>...`）。**先确认 payload 列真实类型**：若是 TEXT，则要 `payload = (jsonb_set(payload::jsonb, '{payment_channel}', to_jsonb($1::text)))::text`；若是 JSONB 直接 jsonb_set。用 `SELECT data_type FROM information_schema.columns WHERE table_name=... AND column_name='payload'` 先探一次，代码里按实际类型走（或直接用 `payload::jsonb` 再 `::text` 回写，对两种情况都安全——但要保证非法 JSON 行不炸：ad_purchase 的 payload 应都是合法 JSON 对象，先小样本验证）。

## 处理流程（照搬 Python 逻辑）
1. **目标小时窗口** `[winStart, winEnd)`（UTC 整点，winEnd=winStart+3600）。默认=上一个完整 UTC 整点小时。**支持传参**指定某小时（`process.argv[2]`，格式 `2026-07-14T23:00:00Z`，对齐到整点）便于回补。
2. **拉订单（带缓冲）**：fetch `[winStart-120s, winEnd+120s]`（前后各 2 分钟缓冲）。只保留 paidAt 落在该缓冲窗口内的订单。用 Node 原生 `fetch`（Node 22 有）。请求时**清掉 http(s)_proxy 环境变量影响**——本机直连该 API 即可，别走代理（旧脚本就是 unset 代理直连）。加超时（如 60s，用 AbortController）。
3. **取待打标行**：查 PG `records_YYYYMM` 中 `event_name='ad_purchase'` 且 `CAST(event_time AS BIGINT) ∈ [winStart, winEnd)` 的行，按 `(CAST(event_time AS BIGINT), id)` 升序。跨月按 winStart/winEnd 各自表名，只查存在的表。取字段：`id, event_time(bigint), revenue`。
4. **匹配算法**（一个订单只用一次）：
   - 订单按金额分组，金额转分 `Math.round(amount*100)`。
   - 对每条 db 行（按金额分组内），选未占用、`|paidAtSec - eventTimeSec|` 最小的订单，标占用，写其 channel。
   - 若最小时间差 > 600s 或同金额组无可用订单 → 默认 `Apple Pay`。
5. **写回** payload 的 `payment_channel` 字段（jsonb_set，幂等）。批量更新，用事务。
6. **匹配完丢弃订单数据，不落库**。
7. **记日志**：目标窗口、订单数、待打标数、匹配数/默认数、渠道分布（`{Apple Pay: n, WAFFO: n, ONERWAY: n}`）。日志用 `console.log`（k8s 收集 stdout，参考 scheduler/ingest-worker 风格）。
8. **有界退出**：跑完 closePool 干净退出（参考 ingest-worker/migrate 结尾的 try/catch + closePool，否则事件循环不退出进程挂起）。单进程一次性任务，不需要常驻轮询。

## 产物清单
1. `services/tag-payment-channel/package.json`（仿 ingest-worker：deps 只需 `pg`，不强依赖 @agentic-ug/db；scripts build/typecheck/start=`node dist/main.js`）。
2. `services/tag-payment-channel/tsconfig.json`（仿 ingest-worker）。
3. `services/tag-payment-channel/src/main.ts`（主逻辑，严格 TS，过 tsconfig.base 的 strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes 等）。
4. `deploy/Dockerfile` 增加 `--target tag-payment-channel`（仿 ingest-worker target：`FROM build AS tag-payment-channel` + WORKDIR + `CMD ["node","dist/main.js"]`）。
5. `deploy/tag-payment-channel.cronjob.yaml`（k8s CronJob manifest，仓库现无 k8s yaml 样板，新建一份规范的）：
   - schedule：**每小时 20 分** `"20 * * * *"`，**timeZone 用 UTC**（因为窗口按 UTC 整点算；给 AD 回传留足落库延迟）。⚠️注意 scheduler 是按 Asia/Shanghai 整点，但本任务窗口是 UTC，所以这里 timeZone 明确写 `Etc/UTC`，避免混淆。
   - `concurrencyPolicy: Forbid`，`successfulJobsHistoryLimit: 3`，`failedJobsHistoryLimit: 3`，`backoffLimit: 2`，`restartPolicy: OnFailure`。
   - env：`AGENTIC_UG_DATABASE_URL`（from Secret）、`PAID_ORDERS_API_TOKEN`（from Secret）。给出 Secret/ConfigMap 引用占位（用 `secretKeyRef`，注明生产自行创建）。
   - image 用构建出的 tag-payment-channel target 镜像（占位 image 名，注释说明 Jenkins `--target tag-payment-channel` 构建）。

## 构建 & 验证（必须做，别只写代码）
1. `cd /home/admin/projects/agentic-ug-web && pnpm install`（如需，workspace 已装大部分）。
2. `pnpm --filter @agentic-ug/tag-payment-channel build` 通过；`pnpm --filter @agentic-ug/tag-payment-channel typecheck` 无错。
3. `pnpm -r typecheck` 整仓不被你破坏。
4. **基线验证**：用真实数据跑 `2026-07-14T23:00:00Z` 那一小时。本地临时设：
   - `AGENTIC_UG_DATABASE_URL`（从 `/etc/environment` 读，DSN 指向阿里云 RDS，sslmode=disable）
   - `PAID_ORDERS_API_TOKEN=ak_10b07cd6023aeded6a1167e65a1e3b38411a9e41d00a06e2`（旧脚本里的真实 token）
   跑：`AGENTIC_UG_DATABASE_URL="$(grep -oP '(?<=AGENTIC_UG_DATABASE_URL=).*' /etc/environment)" PAID_ORDERS_API_TOKEN=ak_10b07cd6023aeded6a1167e65a1e3b38411a9e41d00a06e2 node services/tag-payment-channel/dist/main.js 2026-07-14T23:00:00Z`
   - **期望基线**：db 663 行全打标，渠道分布 **Apple Pay 538 / WAFFO 106 / ONERWAY 19**（curl 核心窗口真实 535/104/19，误差 <2 单可接受）。
   - ⚠️ 这是**幂等重跑**，之前 Python 版可能已经在 SQLite 打过，但这是 PG 新库——先确认 PG 里 7/14 那一小时确实有 663 行 ad_purchase（`SELECT count(*) FROM records_202607 WHERE event_name='ad_purchase' AND CAST(event_time AS BIGINT) >= <winStart> AND < <winEnd>`）。若 PG 库里根本没有 7/14 数据（新环境可能没导入），则改用「有数据的最近某一小时」自测跑通流程，并在结果里说明「基线小时 PG 无数据，改用 X 小时验证流程通过，渠道分布 = …」。
5. 输出一份 `CC_RESULT_tag_payment_channel.md`：说明改了哪些文件、build/typecheck 结果、基线验证实际数字对比、任何偏差与原因。

## 约束
- 代码注释用中文，风格对齐现有 service（看 ingest-worker/main.ts 的注释密度）。
- 别动 `packages/db`、`packages/core`、其他 service。
- 别把真实 token 写进任何提交的源码/manifest（manifest 用 secretKeyRef 占位；验证时只在命令行临时传）。
- TS 严格模式全开，别用 `any` 糊弄，别 `// @ts-ignore`。
