# Agentic-UG-Demo

Sitin 投放（User Growth）数据平台。TypeScript / Node 22 / pnpm workspace 单体仓库，
存储统一在单个 PostgreSQL 实例，跑在 ACK（阿里云容器服务）上。

---

## 业务背景

给投放团队看的**投放数据平台**：把各路广告与收入数据汇到一处，算出每个产品 / 渠道 /
投手 / 素材的收入、消耗、ROI，供每天盯盘和调优决策。

四路数据源，口径各不相同，**不要混用**：

| 源                  | 是什么                                                               | 进来的方式                              |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| **Athena**          | 自有收入 API（`admin-api-prod.sitin.ai`），产品级总收入 / 新用户收入 | CronJob 每整点拉，写 `daily_snapshots`  |
| **AF**（AppsFlyer） | 归因回传：`af_purchase` 收入、`af_complete_registration` 安装        | 广告网络 S2S 回传打到 `/api/postback/*` |
| **AD**              | 自有埋点回传：`ad_purchase` 等                                       | 同上                                    |
| **XMP**（Mobvista） | 投放平台消耗（campaign / adset 级）                                  | CronJob 每整点拉，写 `xmp_cache`        |

**回传链路读写解耦**：`/api/postback/*` 只把原始回传 append 进 `ingest_inbox`（快、不阻塞
广告网络），`job:ingest` 每 2 分钟把 inbox 排空到月表 `records_YYYYMM`。回传接口**不能**
直接写月表——广告网络的回传量会把它打垮。

**业务口径是从旧系统逐字复刻的，公式不要"顺手优化"**。修正系数、eLTV、去重规则、
匹配算法等都对齐过旧生产环境；代码注释里写着"复刻旧 xxx""勿改""照搬 Python"的地方，
改之前先问清楚业务同学。典型例子：`services/tag-payment-channel` 的金额+时间就近匹配
**故意不做按秒精确匹配**（精确匹配率只有 6%）。

历史包袱：本仓库由旧的「Python FastAPI 数据中心 + Express 看板 + 一堆 shell 脚本」重构而来。
旧代码在 `archive/`，**纯为留存历史**：不参与构建/部署，也**不受 lint / prettier 管辖**
（`eslint.config.mjs` 与 `.prettierignore` 都显式忽略 `archive/`）。只读参考，不要改它，
也不要参考它做新东西。背景见 `AgenticUG.md`。

---

## 目录结构（pnpm workspace）

```
apps/
  web/                  @agentic-ug/web        Next.js 15 App Router：看板 UI + 全部 /api/*
                                               （含广告网络 S2S 回传 /api/postback/*）
packages/               ← 可复用库，被 apps/services 依赖，自己不启动
  core/                 @agentic-ug/core       字段抽取、月表名推导等纯逻辑
  db/                   @agentic-ug/db         PG 连接池 + query/queryOne（DSN 解析见下）
  fetcher/              @agentic-ug/fetcher    Athena / XMP 抓取 + 修正系数
services/               ← 可执行入口，每个都是「跑完就退出」的有界 Job
  scheduler/            @agentic-ug/scheduler          单次 fetchAll（Athena+XMP）后退出
  ingest-worker/        @agentic-ug/ingest-worker      排空 ingest_inbox → records_YYYYMM
  tag-payment-channel/  @agentic-ug/tag-payment-channel  给 AD ad_purchase 补 payment_channel
  migrate/              @agentic-ug/migrate            建表 / schema 迁移
  import-json/          @agentic-ug/import-json        历史 JSON 数据导入（一次性工具）
archive/                旧栈（Python/Express/shell）。纯历史存档：不构建、不部署、
                        不 lint、不格式化。只读参考，别改、也别拿它当新代码的样板
deploy/                 Dockerfile（⚠️ 见下方「部署」——线上不用它）
scripts/                抓取用的 bash 脚本（不在 lint 范围）
```

**workspace 规范**：

- `pnpm-workspace.yaml` 只纳管 `apps/*` / `services/*` / `packages/*`。
- **包间引用一律用包名**（`@agentic-ug/db`），不要写 `../../packages/db` 相对路径。
- 依赖方向单向：`apps` / `services` → `packages`。**`packages` 不许反向依赖 services/apps**，
  包之间也不要成环（`import/no-cycle` 是 error，会直接 lint 失败）。
- 加依赖要指明工作区：`pnpm --filter @agentic-ug/web add xxx`。在仓库根 `pnpm add` 会装到
  根上，通常不是你想要的。
- 装依赖用 `pnpm install --frozen-lockfile`（CI/镜像同款）。`pnpm-lock.yaml` 必须提交。
- Node 版本锁 `>=22 <23`（`.nvmrc` / `engines`），包管理器锁 `pnpm@11.7.0`（`packageManager`
  字段，靠 corepack 生效）。用 Node 24 跑本地脚本会有 engine warning，镜像里是 22。

**新增一个 service 的完整清单**（漏一步就跑不起来）：

1. `services/<name>/`：`package.json`（名字 `@agentic-ug/<name>`，`"type": "module"`，
   要有 `build` / `typecheck` / `start`）+ `tsconfig.json` + `src/main.ts`。
2. **根 `package.json` 加 `job:<name>` 脚本** → `pnpm --filter @agentic-ug/<name> start`。
   k8s 的 CronJob 就是靠 `command: ["pnpm", "job:<name>"]` 启动的，**没有这个脚本，
   线上就起不来**。
3. 要上线的话，去 `dora-k8s-config` 加 cronjob task（见下方「部署」）。

---

## 技术栈与代码规范

**技术栈**：TypeScript 5.7 / Node 22 / pnpm 11 workspace / Next.js 15（App Router, React）/
PostgreSQL（`pg`，不用 ORM）/ ESLint 9 flat config / Prettier。全仓 ESM（`"type": "module"`）。

### Lint 与格式化：严格，且不容商量

这是本仓库最容易踩的地方——**规则配得非常严，但目前仓库里没有 CI（无
`.github/workflows`），没有任何东西替你把关，全靠提交前自觉跑**：

```bash
pnpm lint          # eslint .           —— 必须零 error
pnpm lint:fix      # eslint . --fix
pnpm typecheck     # pnpm -r typecheck  —— 必须零 error
pnpm format:check  # prettier --check .
pnpm format        # prettier --write . —— ⚠️ 全仓写，慎用，见下
```

⚠️ **`pnpm format:check` 目前在 main 上就是红的**（约 23 个存量文件没格式化过，包括
一些 `services/*/src/main.ts`）。所以：

- **别直接跑 `pnpm format`**——它会把那 23 个不相干的文件一起重排，你的 PR 会混进
  一大堆噪声 diff，review 根本看不出你改了什么。
- **只格式化你动过的文件**：`npx prettier --write <你改的文件>`。
- 判断"我有没有把事情弄坏"要用**改动前后对比**，而不是看门禁是红是绿——它本来就是红的。

⚠️ **改 ignore 配置时注意：两边语义不一样，踩过坑。**

- `.prettierignore` 是 **gitignore 语义**：不带前导斜杠的 pattern 在**任意层级**都匹配。
  写 `dashboard/` 会把 `apps/web/src/lib/dashboard/`（活代码）一起吃掉。要限定根目录
  必须加前导斜杠（`/scripts/`）。
- `eslint.config.mjs` 的 `ignores` 是**相对配置文件解析**：`'dashboard/**'` 只匹配根级，
  **不会**匹配 `archive/dashboard/`。要忽略整棵子树得写 `'archive/**'`。

这两条语义差异曾同时导致：eslint 漏掉 `archive/` 而报 3471 条存量错误（门禁形同虚设），
prettier 却反过来把活代码 `apps/web/src/lib/dashboard/` 静默跳过。**改完务必用探针验证**
（往目标目录塞个乱格式的临时文件，跑 `npx prettier --check .` / `npx eslint <file>`
看它到底管不管得到），别靠读 pattern 猜。

**格式化完全交给 Prettier，不要手动排版、也不要跟它对着干。**
配置见 `.prettierrc.mjs`：`printWidth: 100` / 单引号 / 带分号 / `trailingComma: all` /
LF 换行 / 箭头函数参数永远带括号。ESLint 末尾挂了 `eslint-config-prettier`，
**格式类规则一律由 Prettier 说了算**，别在 ESLint 里找格式规则改。

ESLint（`eslint.config.mjs`）开了这些**类型感知**的严格档位：

- `tseslint.configs.strictTypeChecked` + `stylisticTypeChecked` —— 比 recommended 严得多。
- `unicorn/flat/recommended`。
- `import/order`：分组之间**必须空行**，组内**按字母升序**。改 import 后跑 `pnpm lint:fix`
  最省事。
- `import/no-cycle`: error。
- `@typescript-eslint/consistent-type-imports`: error —— 只用于类型的 import 必须写
  `import type { Foo }`。

`tsconfig.base.json` 也是顶格严格，写代码时心里有数：

- `strict` + `noUncheckedIndexedAccess` —— `arr[0]` 的类型是 `T | undefined`，**必须处理**。
- `exactOptionalPropertyTypes` —— `{ a?: string }` 不接受显式 `a: undefined`。
- `noPropertyAccessFromIndexSignature` —— 索引签名必须用括号访问。这就是为什么全仓写
  **`process.env['FOO']` 而不是 `process.env.FOO`**（ESLint 的 `dot-notation` 为此
  专门放行了索引签名）。
- `noUnusedLocals` / `noUnusedParameters` —— 有意不用的参数用 `_` 前缀。
- `verbatimModuleSyntax` + `isolatedModules`。
- **`packages/*`** 的跨文件 import **必须带 `.js` 扩展名**（`tsc --module NodeNext` 要求）。
- **`apps/web/`** 内跨文件 import **绝不能带 `.js`**（Next.js webpack 按字面文件名查找，
  带 `.js` 会找不到 `.ts` 源文件 → 生产构建 `Module not found`。已踩坑 3 次，勿再犯）。

**注释用中文**，写"为什么"和"业务口径/坑"，不写"这行在干嘛"。仓库现有注释是这个风格
（如"复刻旧 xxx""勿改""与 web 端逐字一致"），跟着来。

### 数据库

- 统一用 `@agentic-ug/db` 的 `query` / `queryOne`，它读 **`DATABASE_URL`**（或
  `DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME` 分量）。
- **参数一律用 `$1` 占位符**，绝不字符串拼 SQL。
- 回传数据在**月表** `records_YYYYMM`，跨月查询要 UNION ALL 多张表（见
  `packages/core` 的 `currentTable` / `getTablesForRange`）。**推月份时注意时区**：
  按 UTC 还是北京日推表，不同任务口径不同，别照抄。

---

## 部署

**GitOps：本仓库不管部署。** 所有 k8s 资源由 `dora-k8s-config`（ArgoCD + Helm）声明，
镜像 tag 由 Jenkins 写进 `jenkins-k8s-values`。**不要手动 `kubectl apply`，也不要在本仓库
放 k8s manifest**——放了也不会被应用，只会误导后人。

**一个镜像跑所有东西。** 镜像由 **`jenkins-projects/projects/agentic-ug-demo/Dockerfile`**
构建（不是本仓库的 `deploy/Dockerfile`，⚠️ 那个是重构期遗留、线上不用，别照着它改），
内含完整 monorepo，默认 `CMD ["pnpm", "start"]`。deployment 用默认 CMD 跑 web；
各 CronJob 用 `command` 覆写成 `pnpm job:*`。**这样 web 与所有 Job 跑的是同一份代码。**

| 线上工作负载                | 启动命令                       | 频率                        |
| --------------------------- | ------------------------------ | --------------------------- |
| deployment（web）           | `pnpm start`                   | 常驻，:3000                 |
| cronjob/fetch               | `pnpm job:fetch`               | 每整点 :00（Asia/Shanghai） |
| cronjob/ingest              | `pnpm job:ingest`              | 每 2 分钟                   |
| cronjob/tag-payment-channel | `pnpm job:tag-payment-channel` | 每 UTC 整点 :20             |

### 要上线 / 改线上配置

改 **`dora-k8s-config`（默认分支 `aliyun-migration`）的 `projects/agentic-ug-demo/dev-values.yaml`**。
配置能写什么、字段怎么生效，**以 `charts/service` 的实现为准**（`charts/service/values.yaml`
有逐字段中文注释，`templates/cronjob.yaml` 是 CronJob 的渲染逻辑）——别猜字段名。

加一个周期任务 = 往 `cronjob.tasks` 里加一条：

```yaml
cronjob:
  enabled: true # 总开关；false 则本服务所有 task 都不渲染
  timeZone: 'Asia/Shanghai' # 块级默认，task 可覆盖
  tasks:
    - name: <name> # → CronJob agentic-ug-demo-<name>
      enabled: true
      schedule: '20 * * * *'
      timeZone: 'Etc/UTC' # 覆盖块级默认
      command: ['pnpm', 'job:<name>']
      ttlSecondsAfterFinished: 86400
      backoffLimit: 2 # chart 默认 0（失败不重试）
      resources: { ... }
      # DB 连接走 features，别手写 secretKeyRef（见下）
      features:
        databases:
          - name: dev-pg-advertisement
            framework: nodejs-pg-connecting-string
            db: agentic_ug
            # 服务读的环境变量名不是 DATABASE_URL 时，用 envName 改名即可
            # envName: { url: AGENTIC_UG_DATABASE_URL }
      env: [...] # 只放业务自己的 env
```

几个**真会咬人**的点：

- **DB 连接一律用 `features.databases`，不要手写 `DATABASE_*` 的 `secretKeyRef` + 手拼 DSN。**
  chart 的 `service.databaseEnv` 会生成 `DATABASE_HOST/PORT/TYPE/USERNAME/PASSWORD` 和拼好
  的连接串；服务读的变量名不同时用 `envName` 改名（如 `url: AGENTIC_UG_DATABASE_URL`），
  需要区分多个库时用 `envPrefix`。
- ⚠️ **`features` 的继承规则容易被误读**：CronJob **不回退顶层** `.Values.features`（顶层
  语义上只作用于常驻 deployment），但 **task 自己声明的 `features` 是消费的**。
  「CronJob 用不了 features」是错的——踩过这个坑。
- **task 的 `env` 是整体替换，不继承顶层 `env`**（`dig` 语义：task 设了就用 task 的）。
  每个 task 得把自己要的 env **列全**。
- **`$(VAR)` 只能引用在它之前定义的 env**。用 `features` 时 helper 已保证顺序正确
  （`nodejs-pg-connecting-string` 的注入顺序是 host/port/type/username/password/url，
  url 排最后）；只有手写 env 时才需要自己盯着，顺序错了会拼出字面量 `$(DATABASE_HOST)`。
- `timeZone` 作用于**调度**，不是 Pod 的 TZ。任务内部按哪个时区切数据窗口，
  就把 `timeZone` 写成哪个，别让配置和代码各说各话。
- 改完**必须 `helm template` 渲染验证**再提交（`dora-k8s-config/AGENTS.md` 的硬规矩）：
  ```bash
  helm template agentic-ug-demo charts/service \
    -f projects/agentic-ug-demo/dev-values.yaml \
    --set image.repository=backend/agentic-ug-demo --set image.tag=test
  ```
  改动前后各渲染一次做 diff，确认**只有你想要的那点变化**。

### Secret：绝不进 Git

**任何密钥、token、口令、DSN 都不许明文写进代码或提交到仓库**，包括"临时测试用"。
线上密钥走 K8s Secret 注入：

- 应用密钥在 `agentic-ug-demo-secret`（ESO 同步），env 里用 `valueFrom.secretKeyRef` 引用。
- DB 凭据在 `dev-pg-advertisement`（ESO 从 PG 实例同步，含 `HOST/PORT/TYPE/USERNAME/PASSWORD`）。
- **要新增一个 secret key，得联系运维添加和配置**——`infra-values/dev.yaml` 里的 key 列表
  只是声明，实际值在外部密钥系统里，开发侧加不了，自己在 values 里引用一个不存在的 key
  会让 Pod 直接起不来。
- 现有 key（`infra-values/dev.yaml` 的 `agentic-ug-demo-secret`）：`DASHBOARD_ADMIN_PASS`、
  `XMP_CLIENT_ID`、`XMP_CLIENT_SECRET`、`ATHENA_API_KEY`、`SILICONFLOW_API_KEY`、
  `SESSION_SECRET`、`PAID_ORDERS_API_TOKEN`。**要用的 key 已经在列表里的话，直接引用，
  不用找运维。**
- 本地开发照着 `.env.example` 填一份 `.env`（`.gitignore` 已挡 `.env` / `.env.*`，
  只放行 `.env.example`）。**不要把真实值回填进 `.env.example`。**

---

## 提交前自检

**没有 CI 兜底，这一步就是最后一道关。**

```bash
pnpm lint && pnpm typecheck && pnpm build   # 这三条必须零 error
npx prettier --check <你改过的文件>          # 只查你动过的（全仓 format:check 存量就是红的）
```

- `lint` / `typecheck` / `build` 必须过。
- 改了 `services/*` 的启动方式 → 确认根 `package.json` 的 `job:*` 脚本还对得上。
- 改了业务口径/公式 → 在 commit 或 PR 里**说清楚为什么**，这类改动默认是可疑的。
- 提交信息用中文，`type(scope): 说明` 的格式（照着 `git log` 的现有风格来）。
