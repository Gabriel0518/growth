# 服务器环境概览（SERVER_OVERVIEW）

> **MoE 架构文档**：本文件是主索引，包含全局架构和每个模块的关键信息摘要。
> 详细内容拆分到 `docs/` 目录下的专家文档中，按需加载。
>
> 路径：`/home/admin/.openclaw/workspace/SERVER_OVERVIEW.md`
> 最近更新：2026-07-04 23:00

---

## 文档索引

| 专家文档 | 内容 | 关键词（用于路由判断） |
|---------|------|----------------------|
| [`docs/dashboard.md`](docs/dashboard.md) | 投放看板完整技术细节 | 面板, 修正系数, eLTV, AI建议, campaign-context, XMP缓存, 新用户收入, 快照, 个人面板, 汇总面板, 素材面板, app_id映射, 渠道分类, API一览, LLM, 投放大师, SiliconFlow, 查用户, user-lookup, 用户归因, adset, 广告组, 对外取数, api-guard, 接口保护, 限流, 速率限制, 并发, 429 |
| [`docs/dataserver.md`](docs/dataserver.md) | 数据接收与存储层 | dataserver, SQLite, records_YYYYMM, 回传, postback, AF, AD, Adjust, event_time, install_time, 索引, 告警 |
| [`docs/scheduling.md`](docs/scheduling.md) | 定时任务与 UG 早报 | 早报, cron, 定时, gen-ug-report, 飞书群, 调度 |
| [`docs/ad-platform-apis.md`](docs/ad-platform-apis.md) | 雅典娜API + Google/TikTok/Meta API对接 | 雅典娜, Athena, admin-api-prod, Google Ads, TikTok, Facebook, Meta, API对接, Developer Token, 申请 |
| [`docs/tiktok-marketing-api.md`](docs/tiktok-marketing-api.md) | TikTok Marketing API 对接（✅已打通全链路） | TikTok, TT, Marketing API, access_token, advertiser, report/integrated, 消耗, 授权, auth_code, App ID, 官方文档, 报表 |
| [`docs/tiktok-create-ads.md`](docs/tiktok-create-ads.md) | TikTok Smart+ 从0建广告（✅已打通，含一键 SOP） | TikTok, TT, 建广告, 新建广告, 投放, 上新素材, 换皮, 同名寻址, Smart+, smart_plus, campaign/create, adgroup, ad create, AEO, VO, D0 ROAS, CPA, dark_post, 复刻, 安卓模板, identity, BC_AUTH_TT, creative_list, 素材, 一键脚本, URL直传, UPLOAD_BY_URL, suggestcover, op_status, 开投, ENABLE |
| [`docs/tiktok-advertiser-accounts.md`](docs/tiktok-advertiser-accounts.md) | TikTok 授权的 148 个广告主账户清单 | TikTok, advertiser_id, 广告主, 账户清单, 省广, 148 |
| [`docs/scripts-and-tools.md`](docs/scripts-and-tools.md) | 脚本目录、常用查询、Git管理 | scripts, git, push, 提交, fetch-revenue, fetch-xmp, write-sheet, 常用查询, 目录结构 |
| [`docs/changelog.md`](docs/changelog.md) | 完整变更日志 | 变更, 历史, 什么时候改的, 上次, 回顾 |
| [`docs/factor-analysis.md`](docs/factor-analysis.md) | 量化因子分析（广告数据驱动优化） | 因子分析, 量化, 日历因子, 动量因子, 波动率, 消耗响应, 加预算, 均值回归, 弹性, 收敛, AI投放决策, 重新分析, ROAS分析, campaign分析 |
| [`docs/daily-report.md`](docs/daily-report.md) | 飞书日报数据自动填写 | 日报, daily report, 飞书表格, 日活, DAU, PWA, 自动填写, Multi-App Data Center |
| [`docs/daily-report-audit.md`](docs/daily-report-audit.md) | 日报核查（飞书表格 vs Dashboard 对比） | 日报核查, 对比, 差异, 热力图, 审计, audit, 柱状图, 折线图 |
| [`docs/byteplus-datafinder.md`](docs/byteplus-datafinder.md) | BytePlus/火山引擎 DataFinder OpenAPI 接入（产品行为数据源，✅端到端已跑通） | BytePlus, DataFinder, 火山引擎, volcengine, analytics.byteplusapi.com, 用户行为, 留存, 付费率, 漏斗, 事件分析, DSL, AK/SK, HMAC, RangersClient, Doni_Android, app_id 812405, 产品行为侧, 人群查询, 人均收发消息, user_id圈人, profile_filters, 归因人群, byteplus-df-query, extract-campaign-uids, 人均指标 |

**路由规则**：读到本文件后，根据用户的问题匹配关键词，只读取相关的 1-2 个专家文档。

---

## 1. 主机环境

- 用户：`admin`（UID 1000）
- 工作根目录：`/home/admin/.openclaw/workspace/`
- 反向代理：Caddy（`/etc/caddy/Caddyfile`）
  - `datareceive.chickenkiller.com` → `localhost:5000`（dataserver）
  - Dashboard 通过 `http://47.251.10.7:8081/` 公网直接访问

---

## 2. 核心服务

| 服务 | 端口 | 启动方式 | 作用 |
|------|------|---------|------|
| **dataserver** | 5000 | systemd: `dataserver.service` | 接收 AF / Adjust / 雅典娜推送，SQLite 存储 |
| **sitin-dashboard** | 8081 | systemd: `sitin-dashboard.service` | 投放数据看板（Express + better-sqlite3） |
| **user-lookup-api** | 9090 | systemd: `user-lookup-api.service` | 用户归因查询 API（独立服务，Bearer Token 认证，含 `[Query]` 访问日志） |
| **caddy** | 80/443 | systemd | HTTPS 反代 |
| **openclaw-gateway** | 8080 | 用户态 systemd | OpenClaw 平台（不要动） |

查看状态：`systemctl status dataserver sitin-dashboard caddy --no-pager`

---

## 3. dataserver 概要

详细文档：[`docs/dataserver.md`](docs/dataserver.md)

- FastAPI + SQLite（WAL），按月分表 `records_YYYYMM`，当前约 1GB / ~90 万条（records_202605: 76.5万 + records_202606: 13.6万）
- 接收 AF（`af_purchase` / `af_complete_registration`）和 AD（`ad_purchase` / `ad_complete_registration`）回传
- **AF 数据**：event_time/install_time 是 ISO 格式文本（UTC）
- **AD 数据**：event_time/install_time 是 **Unix 时间戳（秒）**，campaign 是 URL 编码+尾部 `(id)`
- AD（Adjust）仅限 iOS 产品（Dora iOS / Romi iOS / Luma）
- **索引**：每张月表有 `(event_name, event_time)`、`(event_name, install_time)`、`(event_name, app_id, event_time)` 复合索引（2026-06-10 新增），以及 `(event_name, app_id, campaign)` 和 `(event_name, app_id, media_source)` 组合索引
- ⚠️ 新月份需手动建索引（详见专家文档）

---

## 4. dashboard 概要

详细文档：[`docs/dashboard.md`](docs/dashboard.md)

`server.js`（~221KB）+ `fetcher.js` + `api-guard.js` + `public/`（前端）

### 四个面板

| 面板 | 数据来源 | 更新频率 |
|------|---------|---------|
| **汇总面板** | 雅典娜 API + XMP API + AF DB 实时 | 每小时 + 页面刷新 |
| **渠道明细** | XMP 缓存 + AF/AD DB 实时聚合 | 页面刷新实时 |
| **素材面板** | XMP 素材报表 + AF/AD postback | 每天首次访问 |
| **个人面板** | SQLite + XMP API 实时聚合 | 每次访问实时 |

> ⚠️ **素材工厂面板已下线**（2026-06-29，项目停止，前后端及数据已删除）。
> ⚠️ **「🔍 查用户」前端入口已下线**（2026-06-29），后端 API `/api/user-lookup`（8081）与独立服务 `user-lookup-api`（9090）仍保留可用。

### 日期范围查询

所有面板支持**日期范围选择**（起始日期 → 终止日期），前端使用 **Flatpickr 单个区间日历**（`mode:"range"`，CDN 引入 `flatpickr@4.6.13` + 中文 locale）：
- **交互**：在同一个日历面板里，第一次点选定一个端点、第二次点选定另一个端点，按时间先后自动判定起止；**第一次点选不触发数据加载**（根除旧双 input 版"改起始日期就先加载一次旧区间"的浪费），只在区间选完后加载一次。
- 起止相同（点同一天两次）= 单日模式（与原有行为完全一致）
- 起止不同 = 多日聚合模式（遍历范围内每天数据求和）
- **范围护栏 `MAX_RANGE_DAYS=31`（前端真人软护栏）**：超过 31 天弹提示并回退（防跨月大范围慢查询拖垮服务）。注意：这是**前端浏览器**的软护栏（弹 alert）；**机器取数（`?key=`/Bearer）另有后端 `api-guard` 硬护栏，日期跨度上限 14 天、返 429**，两者是不同层，见「对外取数接口 + 接口保护」小节。
- 「今天」按钮 → 回到今天单日。
- 多日模式下隐藏趋势图、昨日对比、小时增量
- 数据缺失时显示 ⚠️ 图标（hover 显示缺失日期）
- AI 建议和素材面板始终使用终止日期
- 修正系数在多日模式下由后端按每天各自系数预计算 `correctedRevenue`/`correctedNewUserRevenue`
- **多日查询性能**：后端有多日结果缓存（`_rangeResultCache`，历史范围长 TTL / 含今天短 TTL，channel-summary 用 XMP 缓存 mtime 做指纹失效），跨月查询缓存命中后秒开（<0.04s）。DB 启用性能 PRAGMA（mmap 3GB + 256MB cache + temp_store=MEMORY，只读不影响结果），启动时 `ensureMonthlyIndexes()` 自动补齐月表复合索引（根治"新月份缺索引"）。

### 11 个产品

GraceChat、Dora iOS、Dora And、Doni、Romi iOS、Romi And、Luma、Jovia And、Kira iOS、Kira And、Nalo And（共 11 个）

### AI 投放建议

campaign 行 ✨AI 按钮 → `/api/campaign-context`（过去7天+实时数据，Markdown 表格）→ `/api/llm/chat`（SiliconFlow GLM-5.1）

- 数据口径对齐个人面板：AF + AD 新用户收入（install_time 当天 + 跨天补查）+ 修正系数 + XMP 实时补查
- System prompt = `投放大师.md`（经验框架 + 输出格式）+ `AI投放决策.md`（数据驱动的量化规则）
- 两份文档同时加载，明确声明：**当经验与数据结论冲突时，以数据结论为准**
- 飞书同步版：https://presence.feishu.cn/docx/JAWKdWIgso8a98xBdKTcfQbDn5e
- 输入数据 = Markdown 表格（LLM 可见）

### 关键指标

- **新用户收入** = install_time 在当天（北京时间）且 diff < 24h
- **修正系数** = 雅典娜收入 / AF+AD 非自然量收入 × 0.95（安卓单系数，iOS 分 FB/非FB）
- **eLTV ROAS** = 新用户ROAS × D30 LTV 倍数（双指数衰减拟合，**最近 30 天新用户，按产品×渠道独立拟合**）
- **eLTV 可信度 HWM**：可信度只升不降（🔴→🟡→🟢 单向），按产品×渠道粒度，启动时自动预热
  - 🟢 可信：D1天数 ≥ 30
  - 🟡 供参考：D1天数 ≥ 10
  - 🔴 不可信：不满足上述条件

### 登录认证

用户名 `admin` / 密码 `<DASHBOARD_ADMIN_PASS>`

### 对外取数接口 + 接口保护（机器取数）

外部 agent 拿看板地址+密码即可取数（`?key=`/Bearer）。核心接口 `/api/ext/{meta,records,xmp,xmp-report,xmp-material,xmp-fields}` + 所有看板原生 `/api/*`。配套 skill `richang-daily-data`（个人面板可下载，含 adset 维度 + 分批取数指引）。

**XMP 消耗已细化到 adset 广告组级**（2026-07-03）：个人面板 adset 节点现有真实消耗（守恒 Σadset==campaign，实测匹配率 95.9%）。

**接口保护 `api-guard.js`**（2026-07-03 上线，2026-07-04 升级）：防外部 agent 大范围/高并发打爆单线程。护栏（仅 HEAVY 重接口）：
- **绝对硬范围 `HARD_MAX_RANGE_DAYS=45`（对所有人含真人 session 生效，谁都不能绕）** —— 防单个超大范围同步查询卡死事件循环（新增 07-04）
- 单请求日期跨度 ≤ 14 天（仅机器取数，超返 429）
- 每 IP ≤ 30 请求/分钟（429 + Retry-After）
- **每 IP 并发 ≤ 4 + 全局并发 ≤ 8**（原全局共享 4 → 分级：单 IP 打满只堵自己不连累别人，07-04 改）
- **单请求硬超时 180s → 掐断连接+释放并发+503**（新增 07-04）
- 阈值 env 可调（`GUARD_HARD_MAX_RANGE_DAYS`/`GUARD_MAX_RANGE_DAYS`/`GUARD_IP_RATE_PER_MIN`/`GUARD_PER_IP_CONCURRENT`/`GUARD_MAX_CONCURRENT`/`GUARD_REQUEST_TIMEOUT_MS`）。与 XMP 上游限速 `xmpExtRateOk` 叠加。详见 [`docs/dashboard.md`](docs/dashboard.md)。

> ⚠️ **重要认知（同步接口的并发闸局限）**：`postback/personal`、`channel-summary`、`data` 等重接口虽写 async 但首段全是 better-sqlite3 **同步查询、零 await**，独占事件循环。多请求在 JS 层**天然串行**，所以**并发闸对纯同步接口基本不触发**；真正拦住滥刷的是**频率闸（30/min）+ 硬范围闸（45天）**。request-timeout **无法中断同步 SQLite 执行**（Node 单线程特性），单个超大范围同步查询能把进程卡死数分钟（低CPU/无日志/ESTAB 堆积）——这就是加"硬范围闸"的直接原因。

---

## 5. 定时任务概要

详细文档：[`docs/scheduling.md`](docs/scheduling.md)

### UG 早报
- 每天 06:00 CST 自动生成推送到飞书群（OpenClaw cron `ug-morning-report`）
- 内容：营收 + 消耗 + CPI + eLTV 收入（昨日/7日均值）
- 脚本：`gen-ug-report.py` + `send-ug-report.sh`

### 投手日报（v2，飞书表格数据源）
- 每工作日 14:30 CST 自动发送到飞书群「投放UG」（`oc_6518b783dd17e543f84d1636ee380598`）
- **仅工作日发送**：周一至周五 + 法定调休上班日，周末和法定节假日跳过（内置 2026 年国务院节假日日历）
- 数据源：飞书知识库表格「投手排行榜」（wiki token: `U8okwa43Yi9EoMkRRS3cmA5Dn6f`，spreadsheet token: `QF2UsntX6hCRwwtqTXlc4GQsnFd`）
  - Data 表（sheet_id: `YiWQtE`）：每个投手的日期、消耗、收入、运营净利润
- 内容：文字日报（昨日消耗/收入/纯利润/纯利润率） + 月初至今收入趋势图 + 纯利润率趋势图 + @无数据投手
- 纯利润 = 运营净利润 - 收入 × 7%（其他成本）
- 纯利润率折线图纵坐标：-20% ~ +30%，超出范围 clamp 到边界值
- 脚本：`operator-report-v2.js`（数据+文字+发送）+ `operator-charts.py`（图表）+ `send-operator-report-v2.sh`
- 投手列表（12人）：苏屹恒(syh)、张苗(zm1)、曹永麟(cyl)、武春香(wcx)、张梦凡(zmf)、马崇岩(mcy)、刘欢(lh)、杨梅亭(ymt)、吴天越(wty)、王维维(wvv)、张嘉铖(zjc)、陈祎(cy1)
- @功能：昨日消耗、收入、利润全为0的投手会被 @ 提醒（通过 open_id 精确匹配）
- 替代了旧版 v1（基于 XMP 缓存 + AF 数据库聚合的 `operator-daily-report.js` + `operator-multiday-data.js` + `send-operator-report.sh`）

### 调度时间线
| 时间 | 任务 |
|------|------|
| 00:05 | fetcher 抓前一天完整数据 |
| 00:50 | XMP 昨天缓存补拉（捕获 23:05~24:00 缺失消耗） |
| 05:30 | 数据补全检查（backfill-check） |
| 06:00 | UG 早报 |
| 08:10 | AF/AD 付费金额写入「投放日报模板」（新版手动输入数据sheet） |
| 08:30 | 飞书日报表格写入 |
| 08:40 | 日报数据 → 日报数据汇总(wiki) 同步（含全产品汇总插行 + 产品分表空白填0） |
| 08:50 | 苏屹恒个人日报全链路（填模板 → 补20分表 → 同步汇总，失败飞书私信） |
| 13:20 | XMP 缓存补全（backfill-xmp-cache，失败重试×2） |
| 14:30 | 投手日报 v2（文字+图表+@无数据投手，飞书表格数据源） |
| xx:00 | 每小时实时数据快照（自校准整点触发） |
| xx:05 | XMP campaign 缓存预热（自校准整点触发） |

---

## 6. 广告平台 API 概要

详细文档：[`docs/ad-platform-apis.md`](docs/ad-platform-apis.md)

| 平台 | 状态 | 核心阻塞 |
|------|------|---------|
| **雅典娜** | ✅ 已完成 | — |
| Google Ads | 📋 规划中 | 需公司商业信息申请 Developer Token |
| TikTok | ✅ 已打通（2026-07-02） | ①拉数据/报表已通（`docs/tiktok-marketing-api.md`）②**从0建 Smart+ 广告已通**（`docs/tiktok-create-ads.md`，Jovia首条成功，已固化一键脚本） |
| Meta/Facebook | 📋 规划中 | 需公司商业信息 + 🔴 IP 关联风控最严格 |

### 产品行为数据源：BytePlus DataFinder（≠广告平台）

详细文档：[`docs/byteplus-datafinder.md`](docs/byteplus-datafinder.md)

- **定位**：字节/火山的用户行为分析平台（类 GA4/神策），补齐投放看板没有的**产品内行为侧**视角（留存/付费/漏斗/收发消息等）。**覆盖所有产品的后台行为数据源，不止 Doni。**
- **状态**：✅ **端到端已跑通（2026-07-03）**。OpenAPI 走 AK/SK + HMAC-SHA256，地址 `analytics.byteplusapi.com`（SaaS-非云原生海外/BytePlus 环境），凭据在 `/etc/environment`（`BYTEPLUS_DATAFINDER_AK/SK`）。**全程只读，不碰写/元数据接口。**
- **首个打通场景**：本地 AF 归因圈某 campaign 人群 → user_id → DataFinder 查该人群行为指标（已算出 `Doni And_syh_260701_AEO` 人群人均收发消息数）。
  - 前半段 `scripts/extract-campaign-uids.js`（本地 data.db 提 user_id）→ 后半段 `scripts/byteplus-df-query.js`（喂 DataFinder 聚合）。
  - 关键结论：本地业务 user_id == DataFinder user_unique_id == profile 属性 `user_id`，**无需 id 映射**。Romi iOS 用 Adjust 无 user_id 不适用。

---

## 7. 脚本与 Git 概要

详细文档：[`docs/scripts-and-tools.md`](docs/scripts-and-tools.md)

- **GitHub**：`presence-io/Agentic-UG-Demo`（main 分支）
- **主要目录**：`dashboard/` + `dataserver/` + `scripts/` + `docs/` + `analysis/`
- **analysis/ 目录**：量化因子分析相关脚本、数据和报告（4.5MB），详见 [`docs/factor-analysis.md`](docs/factor-analysis.md)
- **数据来源凭据**：雅典娜 API Key 在 `fetcher.js`；XMP 在 `server.js` 和 `/etc/environment`（XMP_CLIENT_ID / XMP_CLIENT_SECRET）；LLM 在 `/etc/environment`
- **投手日报校准工具**（`scripts/`）：`calibrate-operator-report.js`（按「新版汇总」标准公式重算各投手分表 G:L 修正收入）+ `fix-empty-cells-to-zero.js` + `detect-fix-text-numbers.js`，说明见 [`scripts/README-投手日报校准.md`](scripts/README-投手日报校准.md)

---

## 8. 最近变更摘要

> 完整变更日志：[`docs/changelog.md`](docs/changelog.md)

### 2026-07-04（api-guard 升级：分级并发闸 + 单请求硬超时 + 绝对硬范围闸）

- 🛡️ **`dashboard/api-guard.js` 从"全局共享并发闸"升级为"分级 + 硬超时 + 硬范围"**（起因：外部 agent IP `203.118.53.30` 逐天遍历刷 `postback/personal`，撞满旧版全局共享 4 坑，导致真人也被 429 挡在门外）：
  - **每 IP 并发 ≤ 4 + 全局并发 ≤ 8**（原全局共享 4 → 分级）：单 IP 打满只堵它自己，不再连累别人。
  - **单请求硬超时 180s**：跑超时 → 掐断连接 + 释放并发计数 + 503，防挂住的请求永久占坑。
  - **绝对硬范围闸 `HARD_MAX_RANGE_DAYS=45`**：对**所有人含真人 session** 生效（在 browser 豁免之前），谁都不能绕。
  - 新增 env：`GUARD_HARD_MAX_RANGE_DAYS`/`GUARD_PER_IP_CONCURRENT`/`GUARD_REQUEST_TIMEOUT_MS`。
- ⚠️ **关键教训**：同步 heavy 接口（personal/channel-summary/data 首段全是 better-sqlite3 同步查询、零 await）**独占事件循环、多请求天然串行**，所以**并发闸对纯同步接口基本不触发**——真正防滥刷的是**频率闸(30/min) + 硬范围闸(45天)**。request-timeout **无法中断同步 SQLite 执行**；单个超大范围同步查询会把进程卡死数分钟（低CPU/无日志/ESTAB 堆积，即"低CPU卡死"同族）。排查时用"真人 session + 60天范围"复现了此卡死（旧 range 闸只拦 M2M、session 豁免绕过），遂加硬范围闸根治。实测：session+61天 → 429 instant(0.03s) 不再卡死。
- 📄 **取数 skill `richang-daily-data` 同步更新**：加「保守取数守则」+ 护栏参数表 + bash 退避模板 + 顶部「📅 最近更新：2026-07-04」小字；重新打包到个人面板下载按钮；前端 `index.html` 下载按钮旁加灰色小字「最近更新：2026-07-04」（提醒过期重新下载）。

### 2026-07-03（TikTok 上新素材首次真实开投 + 同名寻址 + SOP 手册）

- 🍬 **上新素材链路打通并首次真实开投**（详见 [`docs/tiktok-create-ads.md`](docs/tiktok-create-ads.md) §0 SOP）：为 Jovia And + Doni And 各建 VO(D0 ROAS 0.3) + AEO(CPA $16) 共 **4 条广告，各 $50/天，均 ENABLE 真实开投**（之前都是 DISABLE 验证）。
  - **★ 核心逻辑“同名寻址”**（屹恒纠正）：看板看到某产品表现好的素材，把产品 token 改成目标产品，拿新名回 XMP 搜 → 得到**目标产品自己那套同款**的链接（不是把原产品文件借给别人）。每产品各一套同名素材（file_url 不同）；新产品可能缺部分同款（Jovia 缺 1 个，跳过 → 6 个）。XMP 同名搜 `POST /v1/media/material/list`（material_name 数组带 .mp4，响应 data.data[]）。
  - **URL 直传零下载**：XMP `file_url`（公网 CDN）→ TT `UPLOAD_BY_URL` → video_id（按 advertiser 隔离，换账户重传）；封面 `suggestcover` 取 `data.list[0].id`，刚传要等转码重试。
  - **★ 读取验证坑**：`smart_plus/ad/get` 按 `ad_ids` 过滤不可靠（返回账户里无关 ad、素材数乱跳），必须改按 `campaign_ids` 查再按 ad_name 找；create 响应才是权威。
  - **新增 SOP 一键手册**（§0）：以后屹恒说“读服务概览 + 建 TT 安卓广告”即可照着 5 步执行。Doni app_id 已核实（`7571754591199281159`）。

### 2026-07-03（BytePlus DataFinder 人群行为查询端到端打通）

- ✅ 打通「**本地 AF 归因圈人群 → user_id → DataFinder 查产品行为指标**」全链路，全程只读。算出 `Doni And_syh_260701_AEO` 人群（173 人）近14天**人均收发消息合计 50.19**（发 23.88 + 收 26.31）。
- **两端可复用脚本**：`scripts/extract-campaign-uids.js`（本地 data.db 按 campaign 提 user_id，需 `NODE_PATH=…/dashboard/node_modules`）+ `scripts/byteplus-df-query.js`（纯 Node 零依赖，命令 active/flow/events/cohort-metric/msg-avg）。
- **踩坑固化**（详见 `docs/byteplus-datafinder.md` 第12节）：①签名 sign_key 是 hexdigest 字符串再当下次 hmac 的 key（非 raw bytes）②period 必须 `type:last` ③次数指标叫 `pv` 非 event_count ④人群过滤 condition 字段名照官方 SDK `condition.py`：`property_name/property_type/property_operation/property_values`，`property_type='profile'`，过滤维度用 `user_id`（非 user_unique_id）。
- 破局关键：卡在人群过滤字段名，最终从官方 SDK 源码 `rangersdk/dslcontent/condition.py` 拿到 100% 正确结构（此前靠猜全返回空集）。

### 2026-07-03（个人日报接入 GC FB + Kira And FB 两个新渠道）

- ➕ **09:50 个人日报三步链路接入两个新投放渠道：GraceChat FB(`GC iOS FB`) + Kira And FB**（`scripts/fill-personal-daily-report.js` + `backfill-personal-report-subtabs.js`）。屹恒新投放这两个产品×渠道，模板表 block、分表、公式均已手工建好，仅脚本未纳入。
  - **fill**（`fill-personal-daily-report.js`）：`BLOCKS` 追加 `{row:101, GraceChat|FB}`、`{row:106, Kira And|FB}`（模板 `TAVpj9` 新 block header 行）。dashboard 个人面板数据 key `GraceChat|FB`/`Kira And|FB` 直接命中。
  - **backfill**（`backfill-personal-report-subtabs.js`）：`MAP` 追加 `{dst:'E8JohB', GC iOS FB, srcHeader:101}`、`{dst:'9RZDYG', Kira And FB, srcHeader:106}`（分表在 `V7nysb…UnJc`）。
  - **⚠️ 顺手修 bug**：backfill 预读模板范围写死 `A1:L99`，而两个新 block 在 row 101~109 超出范围 → 新数据永远读不到（dry-run 表现为「无可补日期」）。已扩到 `A1:L130` 并加注释（以后再加 block 需同步上调）。
  - **汇总公式手工补**（「苏屹恒汇总」`jv5kT4` row2）：C/D/E/F/G/H 六个 SUM 列末尾追加 `+'GC iOS FB'!X2+'Kira And FB'!X2`（各列对应分表列字母 C/G/H/I/J/K 不同）。I/J/K/L 是本行内公式（`=H2-K2` 等）不改。**验证**：消耗 C2 7700.42→7938.5，差额 \$238.08 = 两渠道消耗之和，精确对上。
  - **sync 无需改**：`sync-personal-summary.js` 用固定 `REF_SUB=AjugVe` 权威日期 + 跨表引用，与产品数量无关；已验证其 `retarget` 能把新表引用正确平移到未来行号（历史遗留 `++` 不影响容错求和）。
  - 端到端正式跑通：GC iOS FB 7/2 消耗 \$165.29/11人，Kira And FB 7/2 消耗 \$72.79/4人，已入各自分表 + 汇总。次日 09:50 cron 自动带上。

### 2026-07-03（XMP 消耗细化到 adset 广告组级 + 接口保护中间件）

- 🎯 **XMP 消耗从 campaign 级细化到 adset(广告组)级**（详见 [`docs/dashboard.md`](docs/dashboard.md) 「XMP 消耗细化到 adset」）：个人面板此前只到 campaign，adset 节点无消耗。
  - 抓取 `fetchXmpCampaigns` 的 XMP dimension 加 `adset_name`，每行带 `adset` 字段（`backfill-xmp-cache.js` 同步）。个人面板调用带 `needAdset:true`；schema guard 识别旧缓存缺 `adset` 字段时自动重抓（避免旧缓存把匹配率钉死 0%）。
  - `normAdset()` 统一归一化 adset 名，XMP 消耗按 operator→product→channel→campaign→adset 五级 key 注入到 AF/AD 已建 adset 节点，对不上的落该 campaign 的 `(unknown)` adset（不丢消耗）。
  - **守恒 Σadset.cost == campaign.cost**，实测昨日匹配率 **95.9%**，unknown 主要是当天新开/零付费/PWA campaign。单日 live + 快照生成两条路径都注入。
  - **踩坑**：修复中 CC 编辑残留了一段重复 cache 代码块，导致 `fetchXmpCampaigns` 的 async 函数结构被破坏（await 脱离 async 上下文，服务起不来）。教训：CC 改大文件后必须 `node --check` 且检查有无重复块。已用备份对比定位删除修复。

- 🛡️ **新增接口保护中间件 `dashboard/api-guard.js`**（详见 [`docs/dashboard.md`](docs/dashboard.md) 「API 接口保护中间件」）：防止外部 agent（或失控循环）用重接口/大范围查询打爆单线程 Node 事件循环。
  - 三层护栏（仅对 HEAVY 重接口生效，真人 session 浏览器豁免、只拦 `?key=`/Bearer 的机器取数）：①单请求日期跨度 ≤14 天 ②每 IP ≤30 请求/分钟（429+Retry-After）③全局重接口并发 ≤4（超返 429 快速失败不排队）。阈值 env 可调。
  - `app.use(apiGuard)` 挂在静态资源与 authCheck 之后。与 XMP 上游限速 `xmpExtRateOk` 叠加（前者防上游 QPM，后者防本机单线程）。
  - 实测：32 天跨度→429；35 连发→29×200+6×429 且服务全程健康不卡。
  - **背景事故**：一个外部 agent（IP `203.118.53.30`）持续发大范围 `postback/personal`（逐天遍历历史快照），单请求即占满事件循环把服务拖死。当时先用 iptables 临时拦该 IP 止血，上线 api-guard 后解封，实测其请求被 429 正常挡下、服务不再卡死。

- 📦 **下载版 skill `richang-daily-data` 同步更新**：`dashboard/public/downloads/richang-daily-data.skill` 重打包，现同时含 **adset 维度说明** + **面向 agent 的分批抓取指引**（SKILL.md「速率限制与分批抓取」3 条硬规则：串行别并行 / 长区间按 ≤14 天分片 / 429 退避重试；api-reference.md 含 GUARD 阈值表 + 各接口耗时估算）。
- 已 commit+push（`64c1eefd`）。

### 2026-07-02（TikTok Smart+ 从0建广告打通 + 对外取数接口 + XMP 全能力透传）

- 🎯 **TikTok Smart+ 从0建广告全链路打通**（详见 [`docs/tiktok-create-ads.md`](docs/tiktok-create-ads.md)）：在测试账户 `7576940782100430856`（省广_Jovia_And_1_syh）从 0 严格复刻源 VO 广告，建成真 Smart+ AEO 广告（campaign→adgroup→ad 三层、全程 DISABLE 暂停态）。
  - **关键：Smart+ 有专用接口 `smart_plus/{campaign,adgroup,ad}/create`**，普通 `campaign/create` 传 automation_type 会被忽略退化成 MANUAL。字段权威来源=官方 SDK 仓 `github.com/tiktok/tiktok-business-api-sdk`。
  - **1 个 ad 挂多素材**（`creative_list` 数组，共享 1 个 smart_plus_ad_id），不是建 N 条独立 ad（这也是 Smart+ 推荐做法）。
  - **"仅作为广告展示"开关 = ad 层 `ad_configuration.dark_post_status=ON`**（不是 identity 的 ads_only_mode）。BC_AUTH_TT identity 必带 `identity_authorized_bc_id=7118908157199384578`（Presence BC）。
  - **安卓模板定稿**：只 4 类变量（命名/优化事件 AEO或VO/出价/素材）要改，其余全锁死。固化为一键脚本 `scripts/tiktok-create-android-ad.py cfg.json`。最终 Jovia ad `smart_plus_ad_id 1869597550485794`（dark_post=ON，10 素材）。
  - 待办：Doni And 用同模板（待查 app_id/package）；Luma/Romi iOS 模板需单独确认（APP_IOS）；VO 分支字段未逐字校对。

- 🔌 **Dashboard 新增对外取数能力**（详见 [`docs/dashboard.md`](docs/dashboard.md) 「对外取数接口」）：让其它 agent 拿看板地址 + 登录密码就能直接取数。
  - `authCheck` 改造：session **或** 密码（`?key=` / `Authorization: Bearer`，复用登录密码）都放行 → 现有全部 `/api/*` 立即对外可用（口径永不漂移）。密码用 `crypto.timingSafeEqual` 常量时间比对。
  - 新增 3 个原始接口：`/api/ext/records`（AF/AD SQLite 直查，任意过滤+groupBy聚合+includePayload，AD秒/AF ISO 双口径已与真值逐一对齐）、`/api/ext/xmp`（XMP 消耗，缓存优先）、`/api/ext/meta`（数据地图/枚举/接口清单）。
  - 配套 skill **`richang-daily-data`**（`skills/richang-daily-data`，打包为 `dashboard/public/downloads/richang-daily-data.skill`，个人面板有下载按钮）：把"怎么取数"全固化，明文写死 base url+密码。
  - **下线旧 skill `personal-daily-report`**（lark-cli 写飞书表那套）：删源码目录 + 删 downloads 旧包 + 移除个人面板旧下载按钮（旧链接已 404）。

- 📡 **XMP 全能力透传接口**（官方文档 https://help-xmp.mobvista.com/docs/open_api_desc）：之前 `/api/ext/xmp` 只给消耗（cost/impression/click 3 指标），XMP 实际有大量未用能力（FB ad 240 指标/TT 428/GG 125/material 144）。
  - server.js：`xmpApiRequest` 重构为通用 `xmpApiRequestPath(apiPath,body,headers)`；新增 3 个 1:1 透传接口：`/api/ext/xmp-report`→`/v2/media/account/report`（10 QPM）、`/api/ext/xmp-material`→`/v2/media/material_report/list`（20 QPM，注意 cost_currency 非 currency）、`/api/ext/xmp-fields`→`/v1/media/report/fields`（自描述指标，120 QPM）。
  - GET/POST 双支持；鉴权服务端注入（`buildXmpBody` 覆盖 client_id/timestamp/sign，不信客户端）；**本地限速护栏** `xmpExtRateOk`（滑动 60s 窗口按各接口 QPM 上限，超返 429）防打爆与看板共享的 XMP 配额。已验证 12 连打=200×10+429×2。
  - skill `richang-daily-data` 同步更新（SKILL.md 加「XMP 全能力透传」章节 + 官方文档链接，api-reference.md 加 3 接口完整文档），重新打包。meta 接口增补 xmpDocs 链接。
  - 保留 `/api/ext/xmp`（缓存优先）不动：日报高频固定查询走它，透传只给探索性/额外维度用。
  - 已 commit+push（`4c907400`）。

### 2026-07-02（个人日报 cron 改 09:50 + 重写 6/29~7/1 + 固化为可下载 Skill）
- ⏰ **个人日报 cron 08:50 → 09:50**：上游（08:10 AF/AD、08:30 日报表、08:40 日报汇总）就绪后再跑，避免过早写入未稳定数据。crontab 已备份（`output/crontab.bak.*`）。
- 🔧 **重写 6/29~7/1 三天个人日报**：`backfill-personal-report-subtabs.js` 是 insert-only（日期在就跳过、不覆盖已存在行的过时值），无法纠错。流程：`fill`（用最新数据原地刷新模板 SRC，幂等）→ 新脚本 `overwrite-personal-subtabs-3days.js`（逐行严格校验分表 row2/3/4 日期与模板一致后**原地覆盖**最近三天，日期不符则跳过不写）→ `sync`（汇总为 SUM 公式自动重算）。修正示例：Romi iOS FB 6/30 消耗 \$4,529.92 → \$4,536.31，Luma iOS FB 6/30/6/29 消耗与收入。20 分表全通过、零跳过。
- 📦 **固化为可下载 Skill `personal-daily-report`**（`skills/personal-daily-report/`）：6 脚本（fill/backfill/sync/overwrite/feishu-notify/personal-daily.sh）+ SKILL.md + `references/config.md`。团队内部固定格式，敏感值（表 token、dashboard 凭据、投手代号、飞书 App 密钥/通知 open_id、OPENCLAW_HOME/lark-cli PATH）全部占位符化（`__XXX__`），结构映射保留作参考。官方 `package_skill.py` 验证通过并打包。
- ⬇️ **Dashboard 加下载按钮**：个人面板「投手 × 产品 × 渠道明细」标题右侧新增「⬇ 下载日报 Skill」按钮 → `/downloads/personal-daily-report.skill`（放 `dashboard/public/downloads/`）。server.js 静态资源白名单正则加 `skill` 后缀放行（登录态可下）。重启验证：下载 HTTP 200 + 合法 zip + 8 文件齐全。
- **⚠️ 注意**：`overwrite-personal-subtabs-3days.js` 是一次性修正工具，不进 cron；下载的 skill 里 `personal-daily.sh` 的 `__OPENCLAW_HOME__`/`__LARK_CLI_BIN__` 及三个 JS 的占位符需填后方可运行。

### 2026-07-01（日期选择器改 Flatpickr 区间日历 + 跨月查询性能优化 + 修复个人面板历史快照）
- ✅ **日期选择器改 Flatpickr 单个区间日历**（屏恒需求）：双 input（起始`→`终止）改为一个 Flatpickr `mode:"range"` 日历（CDN 引 `flatpickr@4.6.13`+中文 locale，只改前端三文件）。点两次选区间、按时间先后自动定起止、相等即单日；**第一次点选不再触发无谓加载**（根除旧版"改起始日期先加载一次旧区间"的浪费）。加 `MAX_RANGE_DAYS=31` 护栏。无头浏览器端到端验证通过。
- ✅ **跨月/大范围查询性能优化（修 502）**：选跨月区间时 `af-summary`/`channel-summary`/`data` 多日聚合慢（6~63s）拖垮单线程 node → 积压 → 前置反代 502（既有算法问题，与选择器无关）。修复：① 多日结果缓存 `_rangeResultCache`（历史范围长 TTL/含今天短 TTL，channel-summary 用 XMP 缓存 mtime 指纹失效，返回值字节级一致）——缓存命中跨月查询秒开（<0.04s）；② DB 性能 PRAGMA（mmap 3GB + 256MB cache + temp_store=MEMORY，只读不影响结果）；③ 启动 `ensureMonthlyIndexes()` 自动补齐月表 12 个复合索引（**根治"新月份需手动建索引"的坑**——本次 7 月表就因缺 7 个复合索引加剧了慢查询）。
- ✅ **修复个人面板 6-29 及以前历史数据"消失"**（实为快照缓存被清 + XMP 历史缓存残缺）：
  - 根因：`personal-snapshots/` 历史快照被清空（疑系 7-01 移除曹永麟时"清 30 个快照强制重算"误伤），且 5-15~6-29 多个 XMP 缓存 `complete:false`（当时限频只拓到 FB+GG，TT 缺失）。数据未丢（DB 完好），但无缓存 → 每日全量重查 24s → 前端等不及显空白。
  - 修复：先**补全 5-15~6-29 共 46 天 XMP 历史消耗缓存**（已验证 XMP API 可查到历史数据，如 5-16 补回 TT $8332），再**重建 43 个个人面板快照，全部真 complete、零残缺**。
  - **快照保存维持严格判定**（三渠道 cost 齐全才存 complete，`responseHasReasonableCost`），**不放宽**——屏恒明确：不完整数据比没数据更差，绝不用残缺数据冒充 complete。历史 XMP 缺口只能靠"补全 XMP 缓存 + 重建"解决，不走代码放宽。

### 2026-07-01（素材面板全面对齐 AIGC + 动态命名解析 + 性能优化）
- ✅ **素材面板(creative) 全面对齐 AIGC 面板**（屹恒决策：方案A 动态解析 + 全量素材超集）
  - **动态命名解析** `parseCreativeNameDynamic()`（`fetch-creative-data.js`）：三级优先级、**永不丢弃**——① 含 AIGC 段走 AIGC 字段解析；② 老规范 `MMDD_Designer_Product_Series_Number` 走 `parseOldCreativeName`（**把过去被正则吃掉丢弃的产品字段捕获保留**，如 `0317_ZHT_Romi_...`→产品 Romi、`转_1005_KN_Doni_...`→Doni）；③ 都不匹配则兜底保留归一化原名，产品尽力提取、其余留空，仍入表。
  - **换数据源**：素材消耗从 XMP `material_report`(md5聚合、无产品) 改为 `account/report`(`report_type:'ad'`, `dimension:['ad_name','product_name']`)，与 AIGC 同权威源，产品覆盖率 **~99%**。收入匹配键改 `aigcMatchKey`(规范名+基础产品)。
  - **前端对齐 AIGC**：新增「产品」列 + 「跨产品复用」列（下拉+复制，复用 `replaceAigcProduct`）、3/7/14 天窗口切换、原始/修正开关、全字段筛选栏（负责人/产品/形式/类型/创意/日期 + 数值筛选 + 重置）、CSV 加产品列、素材名左对齐。表格列 8→10。
  - **API 对齐**：`/api/creative/data` 加 `days` 参数(3/7/14)+`missingDates`；`aggregateCreative3Days`→`aggregateCreativeDays`，聚合 key 改 `product::name`，兼容迁移前老结构文件。
- ✅ **性能优化：素材面板首屏 37s → 0.33s**（三层瓶颈逐个击破，纯后端+前端调用方式，逻辑零改）
  - **① 首访异步抓取**（`server.js`）：缺昨天数据时不再同步 `await` 阻塞单线程，改 fire-and-forget 后台抓取 + `creativeFetchInProgress` 防重复，请求立即返回现有数据+`missingDates`。**缺数据首访 37s → 0.048s**。
  - **② 聚合结果缓存**（`aggregateCreativeDays`）：`_creativeAggCache` 按窗口缓存，用各数据文件 `mtimeMs` 拼指纹判失效；文件没变直接返回缓存。**重复请求 4s → 0.01s**。
  - **③ 修正系数缓存升级 + 前端非阻塞**：`/api/correction-factors` 缓存策略改「当天首次算/当天内复用/跨自然日失效」（缓存条目记 `computedOn`），单日+多日模式统一接入，**昨天系数当天内只算一次**（1.06s→0.004s）；三面板（个人/AIGC/素材）统一受益。前端 `loadCreativeData` 把修正系数请求从串行 `await` 改为 fire-and-forget（素材数据先出表，系数并行拉，仅修正开关打开时重渲染）。**首屏 37s → 0.33s**。
  - **未动/零改动**：AIGC 面板（代码零改动，仅享受接口缓存红利）、个人面板逻辑（走多日模式，只享缓存）、汇总面板、投手日报。返回结构 100% 不变。
  - **改动文件**：`fetch-creative-data.js` + `server.js` + `public/app.js`（commit `263d1c82`，622 insertions / 230 deletions）。数据文件已回补 6-28/29/30 为新结构。
  - **验证**：首屏 0.33s（稳定两次）、单日系数缓存 1.06s→0.004s(快260倍)、多日昨天复用 9.2s→0.004s、修正开关生效($12619→$17348)、AIGC/个人面板回归正常、产品列 99% 覆盖、动态解析三类不丢弃。

### 2026-07-01（移除投手曹永麟 + AIGC 面板跨产品复用）
- ✅ **个人面板 + 投手日报移除投手曹永麟(cyl)分类**（屹恒要求）
  - **个人面板**（`server.js`）：`OPERATOR_CODES` 删除 `cyl`，并删掉 `'Oc'→cyl` 大小写敏感兜底规则；前端 `app.js` 删除 `OPERATOR_LABELS['cyl']`。曹永麟的消耗/收入按现有逻辑自然落入「未匹配」（正常预期）。清了 30 个 personal-snapshots 缓存强制重算，重启 `sitin-dashboard.service`。
  - **投手日报**（`scripts/operator-report-v2.js` 14:30 + `operator-report-check.js` 17:00）：`SHEET_OPERATORS` 删除 cyl 项（其余投手 `startCol` 绝对列位置**保持不变**，无错位）+ `NAME_TO_OPEN_ID` 删除曹永麟（不再 @他）。日报投手数 12→11。cron 脚本下次定时自动生效。
  - **未动**：飞书「投手排行榜」源表本身（列还在，仅日报不读）、`operator-rank/daily/multiday/sheet-data.js` 等非 crontab 脚本、个人日报与校准工具。
- ✅ **AIGC 素材面板新增「跨产品复用」功能**（提升跨产品复用素材效率）
  - 在「素材名称」与「产品」之间新增「跨产品复用」列：每行含**产品下拉**（8 个 AIGC 产品，默认自动选中≠当前产品的目标）+ **复制按钮**。选目标产品后点复制，把原素材名里的产品字段替换为目标产品，完整新素材名写入剪贴板，按钮反馈「✓ 已复制」。
  - **替换逻辑** `replaceAigcProduct()`：素材名按 `_` 分段定位属于 `AIGC_PRODUCTS` 的产品段并替换，保留其余全部字段（负责人/形式/类型/创意/演员/日期）；兼容复合产品名（GraceChat）和 ` | ` 打包名。以名字里实际产品段为准（不依赖行 product 字段，二者偶有不一致）。剪贴板走 `navigator.clipboard` + `execCommand` 兜底。
  - **素材名左对齐**（单元格 + 表头都左对齐，更美观）。
  - **列宽优化**：「产品」列 96→66px（缩 ~31%）、「跨产品复用」列 127→107px，省出空间给「素材名称」（`max-width` 130→240px，实测 ~412px）。靠减小两列水平 padding + 收窄下拉/按钮实现。
  - **改动文件**：`public/app.js`（替换/复制逻辑 + 行模板新列）、`public/index.html`（FB/TT 表头加列 + colspan）、`public/style.css`（对齐/列宽/复用控件样式）。纯前端静态文件，刷新即生效无需重启。
  - **验证**：无头浏览器端到端 —— `..._Kira_...` 选 Romi 复制 → 剪贴板得 `..._Romi_...` 精准替换；表头列序正确；下拉无溢出（GraceChat 可完整显示）。

### 2026-06-30（AIGC 素材按产品区分重构）
- ✅ **AIGC 素材面板改用 XMP「广告报表」(report_type=ad) 替代「素材报表」，彻底解决产品区分问题**
  - **根因**：素材报表 (`/v2/media/material_report/list`) 按 `md5_file_id` 聚合，同一视频跨产品投放会被 ` | ` 合并成 bundle 行，产品信息丢失；旧方案 `stripProductKey()` 干脆剥掉产品硬匹配，牺牲了产品维度。
  - **新方案**：改用账户报表 (`/v2/media/account/report`) 的 `report_type:'ad'` + `dimension:['ad_name','product_name']`，每条广告天然只属一个产品，`ad_name` 是投手命名的完整素材名（与 AF/AD postback 的 `af_ad`/`creative` 同源同格式），`product_name` 直接给出真实产品。
  - **收入端也加产品**：postback 用 `bundle_id`/`app_id` → `APP_ID_MAP` 解析产品，匹配键改为 `规范化素材名 + 基础产品`（去 iOS/And 后缀，与素材名一致）。
  - **改动文件**：`fetch-creative-data.js`（重写 `fetchXmpAigcData`/`fetchAfAdAigcRevenue`/`aggregateAigcData`，新增 `XMP_PRODUCT_MAP`/`APP_ID_MAP`/`baseProduct`/`productFromName`/`normalizeAigcName`/`aigcMatchKey`，删除 `stripProductKey`；`xmpRequest` 增加 path 参数支持 account/report 端点）+ `server.js`（`aggregateAigc3Days` 按 `product::name` 聚合）+ 前端 `index.html`/`app.js`（FB/TT 表格新增「产品」列、CSV 加产品列、筛选用权威 product 字段）。
  - **验证**：6/29 同名素材 `260620_AIGC_WYM_..._暗示_Lisa` 正确拆成 Kira/Romi/GraceChat 三条独立产品行；3 天聚合 165 行 100% 带产品，收入精确匹配。TT 消耗从虚高 $572 降到真实 $321（旧方案跨产品错误合并所致）。
  - **⚠️ 注意**：account/report 端点用 `currency:'USD'`（不是素材报表的 `cost_currency:'usd'`），且 sign 30 秒过期，ad 报表已改为每页重新签名。旧数据文件（6/26 等）由旧 pipeline 生成无 product 字段，已重跑 6/27~6/29。

### 2026-06-30（AIGC 面板四项交互增强）
- ✅ **在产品区分基础上，AIGC 面板新增时间窗口 / 修正开关 / 数值筛选 / 日期筛选**
  - **时间窗口（3/7/14 天）**：标题右侧加 pill 切换；`/api/aigc/data?days=N` 参数化（`aggregateAigc3Days`→`aggregateAigcDays`，按 N 构建 `[today-N..today-1]` 窗口），返回 `missingDates`（窗口内缺数据文件的日期，前端标题显示 ⚠️）。回填 6/16~6/26 共 11 天历史数据，14 天窗口数据完整。同时放大了 AIGC 标题与筛选栏字号。
  - **修正开关**：标题行加「原始/修正」开关，开启后新用户收入按「产品+渠道」乘**最新一份修正系数**（昨天那份，`/api/correction-factors?date=昨天`），ROAS 据修正收入重算。系数按完整产品名存（区分 iOS/安卓），AIGC 用基础产品名，靠 `AIGC_FACTOR_PRODUCT` 映射（**Romi→Romi iOS**，屹恒定；Jovia/Kira/Nalo→And，Doni/Luma/GraceChat 同名）；安卓单系数忽略渠道，iOS 风格 `{fb,other}` 的 FB 用 fb、TT 用 other。前端独立 `computeAigcMetrics()`，不动共享的 `computeCreativeMetrics`。
  - **数值筛选**：筛选栏加「指标 + 比较(> ≥ = ≤ <) + 数值」，指标含 收入/消耗/ROAS/CPM/CPC/CTR。值取自 `computeAigcMetrics`，**修正开关开启时数值筛选自动用修正后的值**。状态 `aigcNumFilter`，value 为空不生效。
  - **日期筛选**：和负责人/产品一样的枚举筛选，从素材名开头的 `YYMMDD` 制作/上线日期解析（`260620`→`06-20`）。日期选项**从当前窗口数据动态生成**（按从新到旧排序，切窗口时跟着变）。`parseAigcSubName`/`parseAigcName` 新增 `date`/`dates` 字段。
  - **改动文件**：`server.js`（days 参数化 + missingDates）、`public/app.js`（窗口切换、修正逻辑、数值筛选、日期筛选）、`public/index.html`（标题行 + 筛选栏控件）、`public/style.css`（窗口 pill / 修正开关 / 数值筛选 / 放大字号）。
  - **验证**：3天165行/7天307行/14天377行均缺0天；Romi FB 修正示例 原ROAS 0.843→修正后1.088（×1.2897）；数值筛选 ROAS≥1→11行；日期筛选 06-20→28行均 `260620_` 开头。

### 2026-06-30
- ✅ **投手日报「修正收入」批量校准 + 工具入库**
  - 把 10 个投手日报文档（苏屹恒/曹永麟/张苗/武春香/张梦凡/刘欢/马崇岩/王维维/杨梅亭/张嘉铖）各产品分表的 G:L，按「新版汇总」(`bqKVkz`) 标准公式重算并粘回，修正投手手填的口径偏差与单天错误。
  - **新工具 `scripts/calibrate-operator-report.js`**：动态定位 6 月数据段，支持整月连续 / 起步晚（月初未投）/ 月末未投只有月初 / 月内任意孤立连续段四种形态；自动跳过无 6 月数据和中间断裂（缺天/重复）的表。配套 `fix-empty-cells-to-zero.js`（文本空串→0）、`detect-fix-text-numbers.js`（乘 1 法检测文本型数字）。详见 [`scripts/README-投手日报校准.md`](scripts/README-投手日报校准.md)。
  - **关键踩坑**：飞书 cells-get 无法区分文本/数字（靠 `=单元格*1` 公式，#VALUE! 即文本）；粘回空值必须写数字 0 而非文本空串（否则汇总公式 #VALUE!）；定位起点须限定日期≤28（跳过 6/29/6/30 占位行）；GraceChat FB 在汇总里块名是双空格。
  - 3 个中间断裂缺天的表待补行后单独补跑：杨梅亭 Doni And GG（缺 6/15-16）、刘欢 Nalo and TT（缺 6/24）、张梦凡 Jovia And FB。

### 2026-06-30（AF/AD + 个人日报修复）
  - **AF/AD（`daily-af-ad-input.js`）**：应用对「投放日报模板」表（`N1Fcs…DnIg`）权限被降为「可阅读」，应用身份（tenant_access_token）写入报 `91403 Forbidden`。改用**用户身份**（lark-cli）：`readRange`→`+cells-get`、`insertRow`→`+dim-insert`、`writeRange`→`+cells-set`。
  - **个人日报（`personal-daily.sh`）**：cron 精简 PATH 不含 `~/.npm-global/bin`，`lark-cli` ENOENT。两脚本均加 PATH 注入（脚本内 `process.env.PATH` + sh `export PATH`）双保险。
  - **⚠️ 重要踩坑（lark-cli `+dim-insert`）**：`--inherit-style` 不只是样式，**还决定插入位置**——`after` = 在 position **之后**插入（会错位），`before` = 在 position **之前**插入（新行成为目标行，正确）。首次误用 `after` 导致新空行插到第4行、6/29 覆盖了原第3行 6/28。已从 DB 重算补回 6/28，脚本改为 `before`。原飞书 API `insert_dimension_range` 的 `inheritStyle:'AFTER'` 语义与此**不同**，迁移时勿照搬。
  - 补数据：AF/AD 6/29 + 重建 6/28；个人日报全链路三步重跑成功（填模板120区域 / 分表到位 / 汇总同步）。
  - **长期建议**：用户身份依赖 user token 续期（约每周，refresh 到期 7/6）。若把应用重设为「投放日报模板」可编辑协作者，可切回更稳的应用身份。

### 2026-06-29（下午）
- 🗑️ **素材工厂下线**（项目停止）：删除前后端全部内容
  - server.js：移除素材工厂 API 块（`/api/factory/*`）+ `multer` 依赖引用
  - 前端：index.html 删除「🏭 素材工厂」入口与面板；app.js 删除 FACTORY_SERIES、渲染/上传/下载/详情等全部逻辑
  - 数据：`dashboard/data/factory/`（10M，singlemom/custom 已上传素材）+ `docs/material-factory.md` 移入回收站（可恢复，`gio trash`）
- 🗑️ **「🔍 查用户」前端入口下线**：删除 index.html 入口按钮+面板、app.js 查询逻辑（setupUserLookup/doUserLookup/renderUserLookupResults）
  - **后端 API 保留**：8081 `/api/user-lookup` 和独立服务 9090 `user-lookup-api` 均不动，可继续程序化调用
- 验证：dashboard 重启正常；工厂 API → 404；user-lookup API → 200+正常 JSON；前端无残留入口

### 2026-06-29
- ✅ **新增：苏屹恒个人日报全链路自动化**（`scripts/personal-daily.sh`，cron **08:50**）
  - 三步幂等链路：① `fill-personal-daily-report.js` 填「投放日报模板」苏屹恒模版 C/D/F → ② `backfill-personal-report-subtabs.js` 补到「苏屹恒投放日报」20 个产品×渠道分表 → ③ `sync-personal-summary.js` 同步「苏屹恒汇总」顶部到昨天。任一步失败即停 + 飞书私信（`scripts/feishu-notify.js`）。
  - **修复历史 bug**：backfill 原用 `--inherit-style after`（在 row2 后插行）+ 写数据到 row2 → 覆盖老行，导致每天丢一行历史数据。改为 `before`（在 row2 前插行，老行下移保留）+ 写**数字**而非文本（文本会让汇总 SUM 报 #VALUE!）。已删行模拟「昨天缺失」回归测试：补回当天且历史行零丢失。
  - **汇总同步坑**：飞书 insert 不平移跨表引用；汇总公式含分表名 `'Romi iOS FB（W2A）'` 的 `W2A` 含数字 2，retarget 行号正则需先 mask 该子串再替换。
  - 早间时间线：08:10 AF/AD 输入 → 08:30 日报表 → 08:40 日报汇总 → **08:50 个人日报（新）**。

### 2026-06-23
- ✅ **日报汇总同步脚本修复三个 bug**（`sync-daily-report-to-wiki.js`，首跑后屹恒反馈）
  - **Bug 1 — PWA 新行值列全空**：`PWA_SHEET` 配置缺 `product` 字段 → `findSrcRow(blocks, undefined, ...)` → `blocks[undefined]`=null → 值列全留空。修复：加 `product: 'PWA'`。
  - **Bug 2 — 新插第2行格式继承表头**：`insertRow` 用了 `inheritStyle: 'BEFORE'`（继承插入点之前=第1行表头）。修复：改 `'AFTER'`（继承之后=数据行）。
  - **Bug 3 — 公式显示为文本，需点编辑回车才生效**：飞书 v2 `/values` PUT API 把 `"=..."` 字符串当**纯文本**存（`values_batch_update` 同样无效）。正确姿势 = 写**单元格对象** `{type:'formula', text:'=...'}`（实测 UnformattedValue 正确返回计算结果）。修复：公式列 `out.push({type:'formula', text:retargetFormula(...)})`。
  - **关键技术补充**：`insert_dimension_range` 只插**空行**，**不复制相邻行公式**（只 inheritStyle 复制格式），所以公式必须显式写。
- ⚠️ **事故与恢复**：回补 6/22 旧行时用了一次性脚本做「删行+重插」（delete+reinsert），隔离测试通过但在真实多公式表上行为不一致，把 12 个分表的**表头吃掉、行序错乱**。
  - 飞书**自动编辑历史 API 取不到**（`/drive/v1/files/{token}/versions` 只返回手动命名版本，返回空）→ 只能由用户在网页版「查看历史版本」手动回退。
  - 恢复路径：屹恒网页回退到 08:40 之前 → 用修好的 sync 脚本重跑一次 → 全部正确。
  - **教训**：修单行数据只用 `writeRange` 覆盖该行值，**绝不动行结构**（insert/delete），哪怕隔离测试通过了。
- ℹ️ **遗留 `#VALUE!` 均为源数据为空导致，非 bug**（与手填结果一致）：
  1. PWA `E2/F2`（主播成本/PWA提现成本）源表无 → 影响所有表 `I2/K2`（这两列是人工/外部填，非日报源表）
  2. 部分产品源表花费(C)/注册(D) 为空（如 Dora iOS 的 C、Romi And/Kira iOS 的 C+D）→ `E2=C2/D2` 等 `#VALUE!`，雅典源表补数后自动消失
  - 屹恒确认：**不需提醒他，脚本每天自动填即可**

### 2026-06-22
- ✅ **新增：日报数据 → 日报数据汇总(wiki) 自动同步**
  - 需求：源表「日报数据」(08:30 写入)更新后，自动把内容同步到「日报数据汇总」wiki 文档
  - 源表：`KlXHsPavJhpcbOtiZYecbOYun3b` 单 sheet 全产品堆叠；目标表：`LPn7shI4Kh0jeOtvyP0cd6ffnmf` 一产品一 sheet（含 PWA）
  - 逻辑：逐 sheet 读第2行日期——==昨天跳过 / ==前天插行补昨天 / 其它报警告不自动处理
  - **关键发现（跨表公式）**：PWA 分表必须先 insert 行——飞书会在 PWA insert 时**自动**把所有产品表对 PWA 的跨表引用行号 +1，**无需手动修复**（手动再 +1 会重复错位）
  - 其他坑：`valueRenderOption=Formula`（不是 FormulaValue）；Formula 模式下日期返回序列号（如 46194=2026/6/21，从 1899-12-30 起算）
  - 脚本：`sync-daily-report-to-wiki.js`（`--dry-run`/`--first-run`）+ `sync-daily-report-to-wiki.sh`（cron 包装，首跑标记）
  - **写公式必须用单元格对象** `{type:'formula', text:'=...'}`，裸字符串会被当文本存（详见 6-23 条目 Bug 3）
  - 调度：每天 **08:40**；首跑（6/23）发完整报告，之后只在警告/失败时通知屹恒（飞书私信）
  - 已于 6/23 首跑，修复三个 bug 后现稳定运行（详见 6-23 条目）

### 2026-06-12
- ✅ **内存治理：三个 openclaw 实例设堆上限**
  - 现象：dashboard（8081）被 OOM 挤进 swap 卡死（进程 D 状态、HTTP 请求超时），openclaw webui 正常
  - 根因：gateway 未设 `--max-old-space-size`，V8 堆只涨不还给系统，三个实例（admin/friend/friend2）吃掉 2.4G，机器仅 3.5G 内存触发 OOM
  - 处理：三个 user systemd 服务文件各加 `Environment=NODE_OPTIONS=--max-old-space-size=512`（改前均带时间戳备份），daemon-reload + 真正 restart（软重载 SIGUSR1 不读环境变量，须换 PID）
  - 效果：整机已用内存 3.1G→1.8G，free 140M→477M，available→1.7G，脱离 OOM 边缘
- ✅ **9090 user-lookup-api 增加查询日志**
  - 现象：排查「有没有人查过用户」时发现 8081 `/api/user-lookup` 和 9090 两个查询 API 均无访问日志，历史请求无法追溯
  - 处理：在 9090 的 POST/GET 两个查询入口各加 `[Query]` 日志，记录 时间(UTC)/方法/调用方IP(兼容 x-forwarded-for)/查询ID列表/命中数
  - 查看：`sudo journalctl -u user-lookup-api --no-pager | grep '\[Query\]'`
  - 验证：GET/POST 测试均跑通且日志正常写入

### 2026-06-11
- ✅ **渠道明细产品展开功能**
  - 渠道行点击展开该渠道下各产品的消耗/收入/CPI/新用户ROAS/D7 ROAS
  - 后端 SQL `GROUP BY media_source, app_id` + 前端 ▶ 展开交互
- ✅ **eLTV 数据窗口改为滚动 30 天**
  - 原来：固定 cutoff `install_time >= 2026-05-10`（随时间推移数据量无限增长）
  - 现在：滚动窗口 `install_time >= today - 30天`（北京时间）
  - 好处：更及时反映近期 LTV 趋势，避免数据量爆炸拖慢计算
  - 已清除 eLTV 缓存，下次访问时重新拟合

### 2026-06-10
- ✅ **渠道明细（Channel Summary）面板上线**
  - 新增 `GET /api/channel-summary?startDate=&endDate=` API
  - 按 FB / GG / TT 三渠道汇总：消耗（XMP）、收入（AF+AD）、CPI、新用户 ROAS、D7 ROAS
  - D7 ROAS 不满 7 天的日期标记 `*`（`d7Incomplete` 列表）
  - 前端：产品明细表格下方新增独立渠道明细表格（三行渠道 + 合计行）
  - `restricted` 渠道仅在此 API 归入 FB（不影响其他面板）
- ✅ **Channel Summary SQL 性能优化（崩溃 → <1s）**
  - 问题：查 5 月数据时 `date(event_time, '+8 hours')` 在 76.5 万行表上全表扫描（单条 25s），14 天循环直接卡死 Node 事件循环 + OOM
  - 修复 1：新建 `(event_name, event_time)` 、`(event_name, install_time)` 和 `(event_name, app_id, event_time)` 复合索引（5 月 + 6 月表）
  - 修复 2：所有 SQL 改为 UTC 范围查询（`event_time >= ? AND event_time < ?`），不再用 `date()` 函数
  - 修复 3：多天查询改为整个范围一条 SQL，不再逐天循环
  - 修复 4：XMP 消耗只读磁盘缓存，不触发实时拉取（避免 QPM 阻塞和内存暴涨），缺失日期前端 ⚠️ 提示
  - 性能结果：5 月单日 超时崩溃→0.95s，5 月 14 天 崩溃→~23s，6 月当天 2.2s→0.95s
- ✅ **全局 SQL 性能优化第二轮（af-summary / correction-factors / AD 查询）**
  - 问题：前端并行请求 3 个 API，better-sqlite3 同步串行执行，总时间叠加到 59s 浏览器超时
  - af-summary：单天+多天统一改为 UTC 范围查询
  - correction-factors：`computeCorrectionFactorsSync` 改范围查询 + 多天模式加内存缓存（历史日期只查一次）
  - AD 数据：`CAST(event_time AS INTEGER)` 改为字符串比较（Unix 时间戳 10 位数字，字典序=数值序，能走索引，20s→4s）
  - 前端：channel-summary 从 Promise.all 拆出独立加载，页面先渲染产品表格（~8s），渠道明细后续追加
  - 新建 `(event_name, app_id, event_time)` 复合索引
  - 性能结果：5 月 14 天并行 59s/崩溃 → **14s**，内存 641MB → **230MB**
- ✅ **XMP 缓存一键补全功能**
  - 后端：`POST /api/xmp-backfill` 接收 dates 数组，逐天拉取 XMP 数据，NDJSON 流式返回进度
  - 前端：渠道明细合计行 ⚠️ 图标改为可点击按钮「⚠️ N天」，点击弹窗显示缺失日期列表 + 预计等待时间 + 进度条
  - 三渠道完整性验证：每天补完后检查 FB/GG/TT 全部有数据才标记 ✅，不完整自动重试（等 60s QPM 重置，最多 2 次）
  - 状态区分：✅ 三渠道全补全 / 🔄 重试中（显示缺失渠道）/ ⚠️ 重试仍未全补全 / ❌ 请求异常
  - 完成后自动刷新 channel-summary 数据

### 2026-06-18
- ✅ **个人面板新增"测素材"分类**
  - campaign 名含"测"或"test"（不分大小写）的，`matchOperator()` 优先返回 `test_creative`，不归入任何投手
  - 前端 `OPERATOR_LABELS` 显示"🧪 测素材"，卡片带淡黄色背景 `rgba(255,193,7,0.08)`
  - 逻辑：`isTestCreative()` 在投手代码匹配前执行，优先级最高
  - 快照缓存已清空，重启后生效

### 2026-06-09
- ✅ **个人面板 XMP 消耗缺失修复（23:05~24:00 数据丢失）**
  - 问题：XMP 缓存最后一次预热在 23:05，最后 ~55 分钟消耗未计入 snapshot（实测 syh 6/8 差 $467 / 5.7%）
  - 修复 1：新增每日 00:50 调度，补拉昨天 XMP 缓存（给 XMP 平台延迟留裕量，与整点预热错开限频）
  - 修复 2：partial snapshot 写入时强制刷新 XMP（不用 staleOk），双保险确保写入时刻拿到最新数据
- ✅ **投手匹配规则：`Oc` 归属曹永麟（cyl）**
  - `matchOperator()` 新增 alias：campaign 原文含严格大小写 `Oc`（大写O+小写c）→ 归到 cyl
  - 放在主 code 循环和现有 alias 之后，已带 `cyl` 的 campaign 不受影响
  - 背景：曹永麟历史 campaign 命名如 `AEOc`、`VOc`、`CBO VOc` 等未含 `cyl`，之前归入 other
  - 影响：昨日（6/8）AF 数据中 37 笔付费（$411.65）从 other 归到 cyl；XMP 消耗无变化（在投 campaign 已含 cyl）
- ✅ **投手日报 v2：数据源切换为飞书表格 + 纯利润指标**
  - 数据源从 XMP 缓存 + AF 数据库切换为飞书知识库表格「投手排行榜」 Data 表
  - 利润指标从运营净利润改为纯利润（运营净利润 - 收入 × 7% 其他成本）
  - 纯利润率折线图纵坐标 -20% ~ +30%，超出范围 clamp
  - 发送群改为「投放UG」，cron 时间改为 14:30
  - 新增 @无数据投手功能（消耗/收入/利润全为0的投手被 @ 提醒）
  - 删除排行榜消息，精简为 3 条消息（文字+2张图）+ 可选第4条（@提醒）
  - 新脚本：`operator-report-v2.js` + `operator-sheet-data.js` + `send-operator-report-v2.sh`
  - 折线图颜色修复：COLORS 从 11 个加到 12 个，解决刘欢/吴天越重色问题
  - 仅工作日发送：内置 2026 年国务院节假日日历（周末 + 法定节假日跳过，调休上班日正常发送）

### 2026-06-08
- ✅ **投手日报图表 XMP 缓存缺失再次修复（6/4 数据）**
  - 症状：利润率折线图 6/4 利润率虚高到 70-80%
  - 根因：backfill 首次在 cron 中运行，连续 fetch 两个日期触发 XMP 10 QPM 限频，6/4 TT 渠道失败，缓存未写入
  - 修复：backfill 加失败重试（1分钟间隔×2次）；日期间等待 7s→20s；拆为独立 cron **13:20** 执行（比投手日报 13:30 提前 10 分钟）
  - 已手动补发修正后的图表
- ✅ **Dashboard “🔍 查用户”面板**
  - 新增第五个面板，与汇总/个人/素材/素材工厂并列
  - 输入 5-10 位数字用户 ID，返回广告归因信息（产品、广告平台 FB/GG/TT、媒体渠道、广告系列、广告组、素材）
  - 数据源：`user_lookup` 辅助表（从 `af_complete_registration` 的 `event_value.user_id` 提取建索引）13.8 万条）
  - 查询性能：<0.25s（索引查询，替代原始 LIKE 全表扫描 16s）
  - 同产品多次触发的注册事件自动折叠，显示触发次数 N×
  - 广告平台归类：同时检查 `af_channel` 和 `media_source` 两层，用 `mapMediaSource()` fallback
  - dataserver 收到新的 `af_complete_registration` 时自动同步写入 `user_lookup` 表
- ✅ **独立用户归因查询 API（端口 9090）**
  - 新增 `user-lookup-api.js`：独立 HTTP 服务，Bearer Token 认证
  - 支持 POST 批量查询（最多 200 个 ID）和 GET 快捷查询
  - systemd 服务 `user-lookup-api.service`，开机自启
  - 飞书文档教学：https://presence.feishu.cn/docx/LkcCdvcQ9oOU6LxT06jcOsf9n5c
- ✅ **eLTV 按渠道分析**
  - 新增 `scripts/eltv-by-channel.js`，按产品×渠道计算 D30 倍数
  - 发现不同渠道 eLTV 差距显著（如 Doni FB 2.61 vs GG 3.43）

### 2026-06-07
- ✅ **投手日报 cron 发送失败修复**
  - 根因：lark-cli 1.0.48 配置存在 `~/.lark-cli/openclaw/` 子目录，需 `OPENCLAW_HOME` 环境变量定位 workspace；cron 最小环境缺少该变量，导致 bot 身份 "not configured"
  - 修复：crontab 投手日报命令加 `OPENCLAW_HOME=/home/admin/.openclaw`
  - UG 早报不受影响（OpenClaw cron 兜底成功发送），删除了系统 crontab 中多余的 UG 早报条目避免重复发送
- ✅ **投手日报图表 XMP 消耗数据缺失修复**
  - 根因：`operator-multiday-data.js` 从磁盘缓存读 XMP 消耗数据，历史日期缓存仅在访问个人面板时创建；缺失时 cost=0，利润率虚高到 70-85%（= 1-平台费率）
  - 新增 `scripts/backfill-xmp-cache.js`：图表生成前自动补全本月所有缺失的 XMP campaign 缓存（XMP API 拉取 + 写磁盘），遵守 10 QPM 限频
  - `send-operator-report.sh` 在图表生成前调用补全脚本

### 2026-06-06
- ✅ **投手日报利润率图表优化**
  - 利润率折线图纵坐标最低限制为 -5%，低于 -5% 的数据点 clamp 到 -5%
  - 避免极端亏损案例污染坐标轴
- ✅ **lark-cli 升级 1.0.33 → 1.0.48**
  - 修复 bot 身份偶发 "not configured" 问题（导致当天 13:30 投手日报发送失败，已手动补发）

### 2026-06-05
- ✅ **AI投放建议 502 修复（性能 115s → 1s）**
  - 根因 1：启动时 eLTV HWM 预热做全表扫描（76万行 records_202605），阻塞 Node 事件循环 ~90s，期间所有 HTTP 请求无响应
  - 根因 2：records_202605 缺少组合索引，campaign-context 查 5 月数据时每天耗时 37s
  - 修复：移除启动时全量预热（改用磁盘持久化的 eLTV HWM 直接加载）；新增 `(event_name, app_id, campaign)` 和 `(event_name, app_id, media_source)` 组合索引
  - 补充：campaign-context 加 try-catch 防止 async 路由未捕获异常导致请求挂起
- ✅ **飞书日报脚本修复 + PWA 行补全 + cron 设置**
  - 修复 better-sqlite3 模块路径（指向 dashboard/node_modules）
  - 修复飞书表格写入方法（POST → PUT）
  - 补全 PWA 行：XMP 空产品名消耗 + Multi-App Data Center 日活数据
  - 设置 cron 每天 08:30 执行
- ✅ **数据补全检查机制**
  - 脚本：`dashboard/backfill-check.js`
  - cron：每天 05:30（UG 早报前）检查前 3 天 midnight snapshot
  - 检查逻辑：雅典娜总收入或0 或 XMP 总消耗0 → 重新拓取
  - 失败后 5 分钟 fallback 重试，再失败放弃
  - 已成功补回 6/4 雅典娜数据（前一天雅典娜平台故障导致全天数据为 0）
- ✅ **投手日报系统**
  - 脚本：`scripts/operator-daily-report.js`（文字报告）+ `scripts/operator-multiday-data.js`（多天数据 JSON）+ `scripts/operator-charts.py`（折线图）+ `scripts/send-operator-report.sh`（发送脚本）
  - 飞书群：「投手日报」`oc_15b383a83d008af776490affcd889b40`
  - 内容：每个投手昨日消耗、修正后收入、投放利润、利润率 + 月初至今收入趋势图 + 利润率趋势图
  - 利润计算：收入 × (1-平台费率) × (1-退款率0.01) - 消耗
  - cron：每天 13:30 自动执行
- ✅ **投手匹配规则扩展**
  - `liuh` → 刘欢（lh），支持全拼音命名
  - `zm`（且不含 zmf）→ 张苗（zm1）
  - `Oc`（严格大小写，大写O+小写c）→ 曹永麟（cyl），覆盖历史 campaign 如 `AEOc`、`VOc`、`CBO VOc`
  - 删除 DSK（邧世坤，已离职）
  - 清除个人面板 snapshot 缓存以重新计算（`data/personal-snapshots/`）
  - 注意：修改匹配规则后需清除 personal-snapshots 缓存才能生效
- ✅ **投手名单更新**
  - 删除 DSK（邧世坤）—— 从 OPERATOR_CODES 移除，历史数据归入 other
  - 新增 WTY（吴天越）—— 个人面板 + 投手日报同步添加
- ✅ **eLTV 模型切换：三指数D180贴现 → 双指数D30无贴现**
  - 背景：实际数据不足30天，三指数（5参数）拟合D180存在过拟合风险
  - 新模型：双指数衰减 f(t) = a1·e^{-l1·(t-1)} + (1-a1)·e^{-l2·(t-1)}，仅 3 个参数
  - 预测窗口 D30，无贴现（不再外推不确定的远期收入）
  - 主要产品变化：Doni 3.10→2.78（-10%），Dora And 5.76→5.15（-11%），其余产品变化<5%
  - 性能优化：SQL 加 install_time 过滤 + 只扫 202605+ 的表 + iterate() 替代 all() 避免 OOM
  - 更新了静态 fallback 值、清除 eLTV 缓存重算
- ✅ **XMP 汇总拓取失败修复 + 调度器整点对齐**
  - 根因：summary fetch 和 XMP campaign cache warm 同时触发，超 XMP 10 QPM 限频
  - 调度器从 `setInterval` 改为自校准 `setTimeout`，每次执行完重新计算下一个整点
  - summary 固定 xx:00，XMP warm 固定 xx:05，天然错开不撞限频
  - 重启后不再漂移，始终对齐墙钟整点
- ✅ **去除 XMP 凌晨 UTC date clamp**
  - 之前：北京 0-8 点 clamp 到 UTC 前一天，读到的是昨日数据
  - 现在：始终传北京日期，API 拒绝则返回空，面板显示 0
  - 涉及 `server.js`、`fetch-xmp-api.js`、`fetch-personal-xmp-api.js`

### 2026-06-04
- ✅ **飞书日报数据自动填写子项目启动**
  - 目标：自动采集多数据源写入飞书表格，屹恒检验后复制到正式日报
  - 飞书表格已创建：[日报数据](https://presence.feishu.cn/sheets/KlXHsPavJhpcbOtiZYecbOYun3b)（`KlXHsPavJhpcbOtiZYecbOYun3b`）
  - 4 个数据源：雅典娜 API（收入）+ XMP API（消耗）+ AF SQLite（注册数）+ Multi-App Data Center（日活）
  - 11 个投放产品 + PWA 特殊产品，每产品 3 天数据
  - Multi-App Data Center（`http://62.234.39.191:8765/`）发现 POST API 可直接获取结构化 JSON（无需浏览器）
  - ⚠️ XMP 10 QPM 是主要瓶颈，每天请求间隔 ≥ 65 秒，调度设在 08:30 避开 dashboard 整点请求
  - 新建专家文档 `docs/daily-report.md`（完整数据源、列定义、QPM 策略）
  - 脚本：`scripts/daily-report-sheet.js`（待完善为正式定时版）
- ✅ **飞书 lark-cli user token 续期**
  - 上次 5/27 授权的 refresh token 于 6/3 过期
  - 重新授权成功，access token 2h + refresh token 7d 自动续期
- ✅ **素材面板 CSV 下载按钮**
  - FB 和 TT 表格标题旁各加 ⬇ CSV 按钮
  - 按当前前端排序方式导出全量数据（不限分页）
  - CSV 含 BOM 头（Excel 中文兼容），素材名称双引号包裹
  - 纯前端实现（`downloadCreativeCsv()`），无需后端改动

### 2026-05-31
- ✅ **eLTV 倍数改为仅新用户数据拟合 + 贴现率惩罚**
  - 根因：老用户的高 D 值付费系统性拉高 eLTV 倍数（GraceChat 全量 4.74 → 新用户贴现后 1.85）
  - 修改：仅使用 install_time ≥ 2026-05-10 的新用户数据；每日 1% 贴现率惩罚远期外推不确定性（D_d 收入 ÷ 1.01^(d-1)）
  - 可信度阈值调为 10天/3000条 和 30天/10000条；清空 HWM 和缓存在新规则下重建
- ✅ **修复：AI 投放建议 eLTV 可信度与个人面���不一致**
  - 根因：`/api/campaign-context` 取 eLTV 缓存时遍历顺序错误（取到最旧条目）+ 跳过 HWM 机制
  - 修复：缓存倒序查找 + confidence 始终过 HWM，确保两个面板可信度口径一致

### 2026-05-27
- ✅ **量化因子分析上线**
  - 基于 60 天全量投放数据（SQLite 收入 + XMP API 消耗），完成四大量化因子分析：日历 / 动量 / 波动率 / 消耗响应
  - XMP 历史数据批量拉取脚本 `analysis/fetch-xmp-history.js`（48 天增量，含限频退避逻辑）
  - 数据准备 `analysis/prepare_data.py`（SQLite 收入提取 + XMP 消耗合并 + 宽表生成）
  - 分析 `analysis/factor_analysis_v2.py`（四大因子 + 统计检验 + 因果链验证）
  - 核心发现：日历效应不显著；FB/GG 强均值回归（不要追涨杀跌）；TT 加量最安全（翻倍可恢复），GG 最危险（翻倍后 ROAS -72%）
  - 新建 `dashboard/AI投放决策.md`：分平台预算策略 + 梯度逼近收敛区间算法 + 与投放大师差异对照
  - 飞书同步版：https://presence.feishu.cn/docx/JAWKdWIgso8a98xBdKTcfQbDn5e
  - 新建专家文档 `docs/factor-analysis.md`（完整方法论 + 数据来源 + 重新分析指南）
- ✅ **AI 建议 system prompt 升级**
  - server.js 同时加载 `投放大师.md` + `AI投放决策.md`，当经验与数据结论冲突时以数据结论为准
- ✅ **eLTV 可信度标签高水位（HWM）机制**
  - 可信度只升不降：🔴→🟡→🟢 单向升级，避免因缓存时机或数据波动导致可信度回降
  - 后端 HWM 对象 + 启动预热 + `/api/eltv-multipliers` 新增 `confidence` 字段
  - 前端不再独立计算可信度，统一使用后端返回值
  - 修复前后端可信度判断逻辑不一致的 Bug（前端 OR vs 后端 AND）
- ✅ **投手汇总层级新增 eLTV 指标**
  - 投手头部「新ROAS」右侧新增「eLTV」列，按消耗加权平均各产品×渠道的 eLTV ROAS
- ✅ **eLTV 缓存 + HWM 磁盘持久化**
  - `data/eltv-cache.json` + `data/eltv-hwm.json`，重启后不丢失
- ✅ **修复：历史日期个人面板无数据**
  - `afNewUserExtraRows` 循环引用未定义的 `afCamps` 导致无快照日期报错
- ✅ **修复：多日模式服务崩溃**
  - `applyCrossDayPatch` 中 `camp` 未定义导致 ReferenceError 崩进程

### 2026-05-25
- ✅ **素材工厂全流程上线**
  - 立项 & 定义 13 个素材系列（12 个预定义 + 1 个自定义）
  - 创建专家文档 `docs/material-factory.md`
  - 前端：Dashboard 新增「🏭 素材工厂」面板，系列卡片页 + 详情页 6 个内容区块
  - 后端：multer 文件上传 + 内容 CRUD API（list/upload/download/delete）
  - 每个区块支持上传（标题+文本或文件）、在线预览（图片/视频/音频/文本）、下载（图片/视频/BGM）、删除
  - 文件存储：`data/factory/{seriesId}/{section}/`
  - singlemom 系列第一张参考图已用即梦 AI 生成（中文 prompt）
- ✅ 日期范围查询：所有面板支持 startDate → endDate 时间段选择
  - 后端 `/api/data`、`/api/af-summary`、`/api/correction-factors`、`/api/postback/personal` 全部支持 `startDate` + `endDate` 参数
  - 汇总面板：遍历每天 JSON 文件聚合 athena/xmp 数据
  - AF summary：SQL `BETWEEN` 跨月表聚合
  - 个人面板：复用快照缓存（历史日期不查 XMP，避免限频），多日聚合到 campaign/adset/ad 全层级
  - 修正系数：多日模式后端预计算每天修正值（`correctedRevenue`/`correctedNewUserRevenue`），前端切换开关直接使用
  - 前端双日期选择器 + missingDates ⚠️ 标记
- ✅ Campaign 名称空格不匹配修复：XMP API 返回的 `campaign_name` 和 AF 的 `campaign` 末尾可能带空格，导致同一 campaign 在面板中分成两行
  - XMP 入口 trim（`fetchXmpCampaigns`）
  - AF campaign key trim（paidRows、extraNewUserRows、installMap）
  - 多日聚合 merge 时 trim（兼容历史快照）

### 2026-05-21
- ✅ AI 输入数据文本框列对齐优化（自动 pad、CJK 1.6宽、移除重复列、日期去年份、小数≤ 3 位、模态框加宽 15%）
- ✅ AI 建议数据对齐个人面板（修复新用户收入口径 + 修正系数 + XMP 缺失）
- ✅ AI 建议补充 AD（Adjust）数据查询（iOS 产品）
- ✅ AI 输入数据改为 Markdown 表格（解决 LLM 混淆列）
- ✅ 雅典娜收入 API 替代 Playwright（30-60s → <1s）
- ✅ 文档拆分为 MoE 架构（主索引 + 6 个专家文档，总内容 66.3KB ≈ 旧版 66.6KB，零丢失）

### 2026-05-20
- ✅ `/api/campaign-context` 性能优化 10.5s → ~100ms
- ✅ 浏览器卡顿修复（移除 backdrop-filter）
- ✅ AI 投放建议功能大幅升级（7天历史+实时+回本ROAS）
- ✅ 投放大师.md 决策指南创建
- ✅ UG 早报 cron 上线
- ✅ 雅典娜 API 对接测试（dev 环境）

### 2026-05-19
- ✅ Nalo And 加入汇总面板
- ✅ LLM API 集成 + AI 投放建议首版上线
