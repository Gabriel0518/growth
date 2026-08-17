# 变更日志

> 专家文档：完整的项目变更历史。从 SERVER_OVERVIEW.md 拆分。
> 最近 2 周的摘要保留在 SERVER_OVERVIEW.md 主文档中。

### 2026-07-03 XMP 消耗细化到 adset 广告组级 + 接口保护中间件

#### 🎯 XMP 消耗从 campaign 级细化到 adset(广告组)级

- **背景**：个人面板此前 XMP 消耗只到 campaign 级，adset(广告组)节点无消耗数据。
- **抓取层**：`fetchXmpCampaigns` 的 XMP dimension 加 `adset_name`，每行带 `adset` 字段（`scripts/backfill-xmp-cache.js` 同步）。个人面板调用带 `needAdset:true`；**schema guard**：旧缓存缺 `adset` 字段时自动识别为 miss 并重抓（避免旧缓存把 adset 匹配率钉死在 0%），channel-summary 等只需 cost 的调用方 `needAdset:false` 继续用无 adset 缓存不变。
- **注入层**：`normAdset()` 统一归一化 adset 名（去特殊符号、`+`→空格等），XMP 消耗按 operator→product→channel→campaign→adset **五级 key** 注入到 AF/AD 已建的对应 adset 节点，对不上的落到该 campaign 的 `(unknown)` adset（不丢消耗）。单日 live 路径 + 快照生成路径都注入。
- **守恒 + 匹配率**：Σadset.cost == campaign.cost（一分不丢），实测昨日匹配率 **95.9%**（具名 adset 消耗占比），unknown 主要是当天新开/零付费/PWA campaign。日志 `[XMP adset] <date>: rows matched=.. cost matched=$.. (..% matched)`。
- **前端**：`_renderAdsetRows()` 展示 adset 消耗 + CPM/CPC/ROAS。
- **⚠️ 踩坑**：修复过程中 CC（Claude Code）编辑残留了一段重复的 cache 逻辑代码块，导致 `fetchXmpCampaigns` 的 async 函数括号不匹配、函数体内 `await` 脱离 async 上下文，服务启动即 SyntaxError 起不来。**教训：CC 改大文件后必须 `node --check` 且检查有无重复代码块**。已用 `/tmp/server.js.bak` 备份对比定位、删除重复块修复。

#### 🛡️ 新增接口保护中间件 `dashboard/api-guard.js`

- **目的**：防止外部 agent（或失控循环）用重接口/大范围查询打爆单线程 Node 事件循环。
- **三层护栏**（仅对 HEAVY 重接口生效；真人 session 浏览器登录豁免，只拦 `?key=`/Bearer 的 M2M 机器取数）：
  - ① 单请求日期跨度 ≤ 14 天（`endDate - startDate` 超过返 429，附分批提示）
  - ② 每 IP ≤ 30 请求/分钟（滑动 60s 窗口，429 + `Retry-After`）
  - ③ 全局重接口并发 ≤ 4（同时在飞超过则快速失败返 429，不排长队阻塞事件循环）
- **HEAVY 接口**：`/api/postback/personal`、`/api/ext/records`、`/api/data`、`/api/af-summary`、`/api/channel-summary`、`/api/correction-factors`、`/api/revenue-by-install`、`/api/campaign-context`。轻接口（meta/xmp-fields 等）不受范围/并发闸限制。
- **阈值 env 可调**：`GUARD_MAX_RANGE_DAYS` / `GUARD_IP_RATE_PER_MIN` / `GUARD_MAX_CONCURRENT`。
- **挂载**：`app.use(apiGuard)` 在静态资源与 authCheck 之后。与 XMP 上游限速 `xmpExtRateOk` 叠加（后者防 XMP 上游 QPM 配额，api-guard 防本机单线程被打爆）。
- **实测**：32 天跨度→429；35 连发单天 heavy 请求→29×200 + 6×429 且服务全程健康秒回不卡。
- **背景事故**：一个外部 agent（公司同事的，IP `203.118.53.30`）持续发大范围 `postback/personal`（逐天遍历历史快照），单请求即占满事件循环把服务拖死（进程 D 状态、HTTP 全超时）。当时先用 `iptables -A INPUT -s 203.118.53.30 -j DROP` 临时拦该 IP 止血，上线 api-guard 后 `iptables -D` 解封，实测其请求被 429 正常挡下、服务不再卡死。

#### 📦 下载版 skill `richang-daily-data` 同步

- `dashboard/public/downloads/richang-daily-data.skill` 重新打包，现同时含 **adset 维度说明**（`/api/ext/xmp` 加 adset 字段）+ **面向 agent 的分批抓取指引**：
  - SKILL.md 新增「🚦 速率限制与分批抓取」章节：3 条硬规则（串行别并行 / 长区间按 ≤14 天分片逐片串行 / 收到 429 按 `retryAfterSeconds` 退避）+ 各接口耗时估算（`postback/personal` 单天 ~1.5-2s、多日 ≈ 天数×单天，据此算总耗时和批次）+ 推荐做法（拉一月拆 3 段串行）。
  - api-reference.md 新增「速率限制与分批」章节：GUARD 三阈值表 + env 覆盖 + 耗时基准。
- **⚠️ 提醒（屹恒发现的缺口）**：改 `skills/richang-daily-data/` 源目录后**必须同步重打包**下载版 `dashboard/public/downloads/*.skill`，否则面板下载的是旧版（本次首打包漏了接口保护指引，屹恒问到才补齐）。

#### Git

- commit `64c1eefd`（server.js / api-guard.js / app.js / .skill / backfill-xmp-cache.js），已 push 到 `presence-io/Agentic-UG-Demo` main。skills/ 源目录被 gitignore 不进 git。

### 2026-07-02（下午）TikTok Smart+ 从0建广告 + 对外取数接口 + XMP 全能力透传

#### 🎯 TikTok Smart+ 从0建广告全链路打通（详见 `docs/tiktok-create-ads.md`）
- 在测试账户 `7576940782100430856`（省广_Jovia_And_1_syh）从 0 严格复刻源 `Jovia And_syh_260605_VO_1`，建成真 Smart+ AEO 广告（campaign `1869593678637202`→adgroup `1869593692832802`→ad `smart_plus_ad_id 1869597550485794`，全程 DISABLE，10 素材）。
- **Smart+ 有专用接口 `smart_plus/{campaign,adgroup,ad}/create`**：普通 `campaign/create` 传 `campaign_automation_type=UPGRADED_SMART_PLUS` 被忽略退化成 MANUAL。建成后 campaign 返回 `smart_plus_adgroup_mode: MULTIPLE` 确认真 Smart+。字段权威来源=官方 SDK 仓 `github.com/tiktok/tiktok-business-api-sdk`（git tree API 拿文件名再 grep）。
- **结构纠错：1 个 ad 挂多素材**（`creative_list` 数组塑多个 video，共享 1 个 smart_plus_ad_id），不是建 N 条独立 ad。删 ad 用 `smart_plus/ad/status/update` 传 `smart_plus_ad_ids`。
- **"仅作为广告展示"开关 = ad 层 `ad_configuration.dark_post_status=ON`**（不是 identity 的 `ads_only_mode`，那是干扰项）。定位法：diff `smart_plus/ad/get` 源 vs 新的 `ad_configuration` 全字段。
- **BC_AUTH_TT identity 必带 `identity_authorized_bc_id=7118908157199384578`**（Presence BC）。Smart+ ad 强制要 `ad_text_list` 非空（即使源广告 ad_text 全空）。增强策略合法枚举只有 IMAGE_QUALITY/IMAGE_RESIZE/MUSIC_REFRESH/TRANSLATE_AND_DUB/VIDEO_QUALITY。封面用 `file/video/suggestcover` 取。并发限制 41021 需 sleep。
- **安卓模板定稿**：只 4 类变量（命名/优化事件 AEO或VO/出价/素材）要改，其余全锁死（Campaign APP_PROMOTION/APP_INSTALL/REGULAR/日预算$50/CBO/Smart+；Adgroup APP_ANDROID/自动版位/OCPM/定向美国仅男Android英语；Ad 1广告多素材/dark_post ON/CTA DOWNLOAD_NOW/3固定文案）。固化为 `scripts/tiktok-create-android-ad.py cfg.json`。
- 待办：Doni And 用同模板（待查 app_id/package）；Luma iOS `7553499098226819079`/Romi iOS `7553497951788728328` 模板需单独确认（APP_IOS，SKAN/归因窗口可能变）；VO 分支字段未逐字校对源 VO。

#### 🔌 Dashboard 对外取数能力（详见 `docs/dashboard.md`）
- `authCheck` 改造：session **或** 密码（`?key=<登录密码>` / `Authorization: Bearer`）都放行 → 现有全部 `/api/*` 立即对外 agent 可用，零重复代码、口径永不漂移。密码 `crypto.timingSafeEqual` 常量时间比对，`[Ext]` 访问日志。
- 新增 3 原始接口：`/api/ext/records`（AF/AD SQLite 直查，任意过滤+groupBy聚合+includePayload；AD unix秒/AF ISO 双日期口径已与 SQLite 真值逐一对齐）、`/api/ext/xmp`（XMP 消耗缓存优先，`refresh=1` 才实时，注意 10 QPM）、`/api/ext/meta`（数据地图/新鲜度/枚举/全接口清单）。
- 配套 skill `richang-daily-data`（`skills/richang-daily-data` → `dashboard/public/downloads/richang-daily-data.skill`，个人面板有"取数接口 Skill"下载按钮）：把"怎么取数"全固化，明文写死 base url `http://47.251.10.7:8081`+密码（拿 skill 本就得知道密码）。
- **下线旧 skill `personal-daily-report`**（lark-cli 写飞书表那套）：删源码目录 + 删 downloads 旧包 + 移除个人面板旧下载按钮（旧链接已 404）。
- 注：`workspace/.gitignore` 排除 `skills/`，skill 源码不进 `Agentic-UG-Demo` repo，只有打包的 `.skill` 入库（与旧 skill 一致做法）。已 commit+push `25c26d0f`。

#### 📡 XMP 全能力透传接口（官方文档 https://help-xmp.mobvista.com/docs/open_api_desc）
- 背景：`/api/ext/xmp` 只给消耗视角（cost/impression/click 3 指标），XMP 实际能力远超（FB ad 240 指标/TT 428/GG 125/material 144，含 ROAS/CPM/CPC/CTR/CVR/注册/购买/加购/落地页/视频完播率等）。
- 读 XMP 官方文档（请求协议/广告报表/素材报表/枚举值）后，server.js 新增 3 个 1:1 透传接口（通用 helper `xmpApiRequestPath(apiPath,body,headers)`）：
  - `/api/ext/xmp-report` → `/v2/media/account/report`（广告报表，全维度全指标，10 QPM）
  - `/api/ext/xmp-material` → `/v2/media/material_report/list`（素材报表，20 QPM，**用 cost_currency 非 currency**）
  - `/api/ext/xmp-fields` → `/v1/media/report/fields`（自描述指标目录，120 QPM，report_type=ad|material，先调这个发现指标）
- GET/POST 双支持（GET 数组参逗号分隔自动拆）；鉴权服务端注入（`buildXmpBody` 覆盖 client_id/timestamp/sign，不信客户端传的 auth）；`lang=zh-CN|en-US` → Accept-Language。
- **本地限速护栏** `xmpExtRateOk`：滑动 60s 窗口按各接口 QPM 上限，超返 HTTP 429 → 防外部 agent 打爆与看板共享的 XMP 配额。已验证 12 连打=200×10+429×2。
- 实测全通：fields ad=240/material=144/tiktok=428、report 多指标(cost/ctr/cpm...)、material 真数据、错误原样透传(xmp.msg)、GET+POST both。
- skill `richang-daily-data` 同步：SKILL.md 加「XMP 全能力透传」章节 + 官方文档链接；api-reference.md 加 3 接口完整文档（维度/指标/枚举/分页/示例）；重新打包。meta 接口 endpoints 增补 3 新接口 + xmpDocs 链接。
- 保留 `/api/ext/xmp`（缓存优先消耗视图）不动：日报高频固定查询走它，透传只给探索性/额外维度用。已 commit+push `4c907400`。

### 2026-06-29
- ✅ **新增：苏屹恒个人日报全链路自动化**（`scripts/personal-daily.sh`，cron **08:50**）
  - 需求：把苏屹恒个人投放数据从「投放日报模板」填好并联动到「苏屹恒投放日报」的 20 个产品×渠道分表及「苏屹恒汇总」，每日自动补到昨天，幂等可重跑。
  - **三步链路**（后步依赖前步产物）：
    1. `scripts/fill-personal-daily-report.js`：填模板（`N1FcsGvXThXu97t7ZYyccCHDnIg` / sheet `TAVpj9` 苏屹恒模版）C(消耗)/D(男生人数=`af_complete_registration` campaign installs 求和)/F(原始收入=未修正 revenue)，刷新最近 3 天，数据源 dashboard `/api/postback/personal`（投手 syh）
    2. `scripts/backfill-personal-report-subtabs.js`：模板 → `V7nysbQd3huZvStpd6Tcv7HUnJc` 的 20 分表（sheet jv5kT4 汇总不算），每分表 row2 日期距今 ≤4 天才补，新日期顶部
    3. `scripts/sync-personal-summary.js`：「苏屹恒汇总」(`jv5kT4`) 顶部同步到昨天（汇总 row R ↔ 分表 row R，复用 row2 模板公式 retarget 行号）
  - **失败通知** `scripts/feishu-notify.js`：独立脚本，bot tenant_access_token 发给屹恒（`ou_b2467dac5ff1d686fb48ccf1fbaa0c0d`）；wrapper 任一步失败即停 + 私信。
  - **修复历史 bug 1 — 每天丢一行**：backfill 原用 `--inherit-style after`（=side:after，在 row2 **后**插空行，新空行落 3/4/5，老 row2 留存），但脚本把新数据写到 **row2** → 覆盖老 row2（如 6/25），真正新增的空 row5 反而空。改 `before`（在 row2 **前**插，新空行落 2/3/4，老 row2→row5 保留），写入 row2..(1+n) 正好填新空行，永不碰老数据（数学保证：老数据起于 row(2+n)，写入只到 row(1+n)）。
  - **修复历史 bug 2 — 汇总 SUM #VALUE!**：backfill 原「粘贴为文本」（number_format=`@`，值如 `"$309.29"`），汇总 SUM 文本→#VALUE!（汇总引用分表 C/G/H/I/J/K，不引用 E/L）。改为写**数字+货币/百分比格式**（`$309.29`→309.29；`100%`→1.0；`#DIV/0!` 保留文本）。一次性修复脚本 `scripts/fix-subtab-text-to-num.js` 把已粘文本的 row2-5 转回数字。
  - **汇总同步坑**：飞书 insert **不平移跨表引用**（汇总 row2→分表!C2 插行后仍指 C2），所以 cron 必须 backfill 后再同步汇总顶部。retarget 行号正则 `/(?<=[A-Z])2(?![0-9])/g` 会误伤分表名 `'Romi iOS FB（W2A）'` 里的 `W2A`（含数字 2→W3A 致 #REF）→ 必须先 **mask `W2A`→无数字占位符**(`\u0001WXA\u0001`)再替换再 unmask。
  - **删行会毁跨表引用**：回归测试时删分表 row2 会让汇总 `'Romi And GG'!C2`→#REF（被引用格被删）。正常 cron **只 insert 不 delete**，不触发。
  - **端到端回归验证**：删 AjugVe 6/28 行模拟「昨天缺失」→跑修正版 backfill→ 6/28 正确补回顶部且 6/27/26/25/24… 零丢失，C 列为数字格式。汇总 259 数据行 6/28→2025/9/29 日期连续无 gap，零 #REF/#VALUE。
  - **两个子汇总表**（苏屹恒汇总FB+TT `UT3rJe` / 苏屹恒汇总Google `56KYA7`）**已弃用**（顶部停在 6/11），屹恒确认不维护。
  - 早间时间线：08:10 AF/AD 输入 → 08:30 日报表 → 08:40 日报汇总 → **08:50 个人日报全链路（本任务）**。新增脚本：personal-daily.sh / sync-personal-summary.js / feishu-notify.js / fix-subtab-text-to-num.js / restore-625-rows.js。

- ✅ **新增：AF/AD 付费金额自动写入「投放日报模板」**（`scripts/daily-af-ad-input.js`，cron 08:10）
  - 需求：每天 08:10 在「投放日报模板」表的「新版手动输入数据」sheet（`Y64Qk0`）第3行前插入新行，填昨天日期 + 各产品渠道付费金额总和
  - 表: wiki `A2sfw2rnIiavmHkStErca2Wentg` → spreadsheet `N1FcsGvXThXu97t7ZYyccCHDnIg`
  - 数据源：本地 AF/AD 数据库（`/home/admin/dataserver/data.db`），不走任何外部 API
  - **4 大类列定义**（用 6/28 已填数据反推确认，北京时间 event_time 口径）：
    - **AF FB**：`af_purchase` + `source='Facebook Ads'`。列：GC(B)、Dora iOS(C)
    - **AF 非自然**：`af_purchase` + `source!='organic'`（含restricted/FB/GG/TT）。列：GC(E)、Dora iOS(F)、Dora And(G)、Doni(H)、Romi iOS(I)、Jovia And(J)、Romi And(K)、Kira And(L)、Nalo And(M)
    - **AD FB（不含w2a）**：`ad_purchase` + `source IN (Facebook+Installs, Instagram+Installs, Off-Facebook+Installs)`（排除 Facebook+web/W2A）。列：Romi iOS(O)、Luma(P)
    - **AD 非自然**：`ad_purchase` + `source!='Organic'`。列：Romi iOS(R)、Luma(S)、Dora iOS(T)
  - **日期口径**：北京时间当天。AF 用 `date(event_time,'+8h')`（event_time=ISO UTC）；AD 用 `date(datetime(CAST(event_time AS INTEGER),'unixepoch'),'+8h')`（AD event_time=Unix 秒）
  - **插行逻辑**：读第3行日期——==昨天跳过 / ==前天插行补 / 其它报警不处理。`inheritStyle: 'AFTER'` 继承数据行的货币格式($)，写入原始数字自动显示 $
  - **对账结果**：AF 11 个值与已填数据分毫不差；AD 5 个值有 ±几十~几百刀偶偏差（本地 Adjust postback 回传天然有少量丢失，跟 Adjust 平台报表对不齐）。屹恒确认可接受本地 DB 数据
  - 早间时间线：08:10（本任务）→ 08:30（日报表格写入）→ 08:40（日报汇总同步）

- ✅ **日报汇总同步脚本新增两个需求**（`sync-daily-report-to-wiki.js`）
  - **需求1 — 全产品汇总分表自动插行+同步公式**：新增 `processSummarySheet` 函数，处理「全产品汇总」sheet（sheetId: `IpeVKX`，23列全公式）。逻辑与产品分表类似（==昨天跳过 / ==前天插行），但因为全公式、无源表值列，处理方式不同：
    - 插入前保存原始 row2 公式（这些指向各产品分表 row2 = 昨天数据）
    - 插入后修复 row3（旧行）：飞书自动平移本表引用，跨表引用需手动 +1（各产品分表也已 insert，它们的旧 row2 变 row3）
    - 新 row2：使用原始公式（本表引用→row2 ✓，跨表引用→各分表row2=昨天 ✓），A列和U列更新为昨天日期序列号
    - 必须在所有产品分表之后处理（因为它引用所有分表 row2）
  - **需求2 — 产品分表空白格用0填充**：`processSheet` 新增 `fillZero` 参数（仅对产品分表生效，PWA和全产品汇总不填0）。逻辑：找到旧行最后一个非空列，在该范围内的空白格（`''`）全部替换为 0，避免公式引用空值产生 `#VALUE!` 错误
  - `main()` 处理顺序调整：PWA → 产品分表(fillZero=true) → 全产品汇总

### 2026-06-11
- ✅ **渠道明细产品展开功能**
  - 后端：channel-summary SQL 增加 `GROUP BY app_id`，返回 `channels[ch].products` 二级结构
  - 前端：渠道行 ▶/▼ 展开箭头，点击展开产品明细子行，按消耗降序
- ✅ **eLTV 数据窗口改为滚动 30 天**
  - 原来：固定 `install_time >= 2026-05-10`，现在：`install_time >= today - 30 天`（北京时间）
  - 好处：更及时反映近期 LTV + 避免数据量增长拖慢计算
  - 表选择也改为动态（不再硬编码 records_202605）
  - 已清除 eLTV 缓存重新拟合
- ✅ **eLTV 分渠道计算（产品×渠道独立拟合）**
  - 后端：新增 `ELTV_PRODUCTS` / `ELTV_CHANNEL_MAP` / `getEltvQueries()` 定义每个产品×渠道的数据源
  - Romi iOS FB 用 AD 数据，Luma 全渠道用 AD 数据，其他用 AF
  - restricted/Unattributed 归入 FB，organic 排除
  - 可信度改为只看 d1Span（≥ 30 可信 / ≥ 10 供参考 / <10 不可信）
  - HWM 粒度从 `product` 改为 `product_channel`
  - API 返回结构：`multipliers[product][channel] = { d180, confidence, ... }`
  - 前端：`getEltvMultiplier(product, channel)` 分渠道取值
  - AI 投放建议也按 campaign 所属渠道取对应 eLTV

### 2026-06-10
- ✅ **渠道明细（Channel Summary）面板上线**
  - 新增 `GET /api/channel-summary?startDate=&endDate=` API，按 FB / GG / TT 三渠道汇总消耗、收入、CPI、新用户 ROAS、D7 ROAS
  - 消耗：XMP 磁盘缓存（只读，不触发实时拉取）
  - 收入/注册数：AF+AD 实时聚合，`restricted`/`Unattributed` 归入 FB（仅此 API）
  - 新用户收入：install_time + diff<24h；D7：install_time + diff<168h
  - D7 不满 7 天标记 `*`（d7Incomplete），XMP 缓存缺失显示 ⚠️（xmpMissingDates）
  - 前端：产品表格下新增独立渠道明细表格 + 合计行
- ✅ **Channel Summary SQL 性能优化（崩溃 → <1s）**
  - 问题：5 月 76.5 万行表上 `date(event_time, '+8 hours')` 全表扫描（单条 25s），14 天逐天循环卡死 Node + OOM kill
  - 新建复合索引：`(event_name, event_time)`、`(event_name, install_time)`、`(event_name, app_id, event_time)` 在 records_202605 和 records_202606
  - SQL 全部改为 UTC 范围查询：北京日期 D → `[D-1 16:00 UTC, D 16:00 UTC)`
  - 多天查询改为整个范围一条 SQL（不逐天循环）
  - XMP 只读磁盘缓存，不触发实时拉取（避免 QPM 阻塞 + OOM）
  - 性能：5 月单日 崩溃→0.95s，6 月当天 →0.95s
- ✅ **全局 SQL 性能优化第二轮（af-summary / correction-factors / AD 查询）**
  - af-summary：单天+多天统一改为 UTC 范围查询
  - correction-factors：`computeCorrectionFactorsSync` 改范围查询 + 多天加内存缓存
  - AD 数据：`CAST(event_time AS INTEGER)` 改字符串比较（10位数字字典序=数值序，能走索引，20s→4s）
  - 前端：channel-summary 拆出 Promise.all 独立加载，页面先渲染产品表格（~8s），渠道明细后续追加
  - 性能：5 月 14 天并行 59s/崩溃 → **14s**，内存 641MB → **230MB**
- ✅ **XMP 缓存一键补全功能**
  - 后端：`POST /api/xmp-backfill` 接收 dates 数组，NDJSON 流式返回 fetching/done/retrying/partial/error
  - 前端：合计行 ⚠️ 改为可点击按钮，弹窗显示缺失日期 + 预计时间 + 进度条
  - 三渠道完整性验证：补完后检查 FB/GG/TT，不完整自动重试（等 60s QPM 重置，最多 2 次）
  - 完成后自动刷新渠道明细数据

### 2026-06-09
- ✅ **个人面板 XMP 消耗缺失修复（23:05~24:00 数据丢失）**
  - 问题：XMP 缓存最后一次预热在 23:05，最后 ~55 分钟消耗未计入 snapshot（实测 syh 6/8 差 $467 / 5.7%）
  - 修复 1：新增每日 **00:50** 调度（`scheduleXmpYesterdayBackfill`），补拉昨天 XMP 缓存，给平台延迟留裕量且不与整点预热撞限频
  - 修复 2：partial snapshot 写入时强制刷新 XMP（`staleOk: false`），双保险确保写入时刻拿到最新数据
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
  - 症状：利润率折线图 6/4 利润率虚高到 70-80%（= 1-平台费率），与 6/7 修复的 6/3 问题相同
  - 根因：backfill-xmp-cache.js 首次在 cron 中运行，6/1 和 6/4 两个日期连续 fetch，6/4 的 TT 渠道触发 XMP 10 QPM 限频（`request too frequently`），缓存未写入；图表在缺失数据下生成并发出
  - 修复 1：backfill 失败后等 1 分钟重试，最多重试 2 次（共 3 次尝试）
  - 修复 2：日期间等待从 7s → 20s（安全裕量避免撞限频）
  - 修复 3：backfill 从 send-operator-report.sh 拆出为独立 cron **13:20** 执行（比投手日报 13:30 提前 10 分钟）
  - 已手动补发修正后的图表
- ✅ **Dashboard “🔍 查用户”面板上线**
  - 新增第五个 Dashboard 面板，与汇总/个人/素材/素材工厂并列
  - 输入 5-10 位数字用户 ID，返回 AF 广告归因信息（产品、广告平台 FB/GG/TT、媒体渠道、广告系列、广告组、素材、注册时间、安装时间）
  - 后端 `/api/user-lookup`：基于 `user_lookup` 辅助表（13.8 万条，从 `af_complete_registration` 的 `event_value.user_id` 提取建索引），查询 <0.25s
  - 广告平台归类同时检查 `af_channel`（Instagram→FB、ACI_Display→GG、TikTok→TT）和 `media_source`（Facebook Ads→FB、googleadwords_int→GG、tiktokglobal_int→TT）两层，用 `mapMediaSource()` fallback
  - 前端按产品折叠重复注册事件，显示触发次数 N×，广告平台彩色 badge（FB蓝/GG蓝/TT红/自然绿）
  - dataserver (`app.py`) 收到新的 `af_complete_registration` 时自动同步写入 `user_lookup` 表
- ✅ **独立用户归因查询 API（端口 9090）**
  - 新增 `dashboard/user-lookup-api.js`：独立 Node.js HTTP 服务
  - 端口 9090，Bearer Token 认证，支持 POST 批量查询（最多 200 个 ID）和 GET 快捷查询
  - systemd 服务 `user-lookup-api.service`，开机自启
  - 飞书文档 API 使用指南：https://presence.feishu.cn/docx/LkcCdvcQ9oOU6LxT06jcOsf9n5c
- ✅ **eLTV 按渠道分析**
  - 新增 `scripts/eltv-by-channel.js`，按产品×渠道计算 D30 LTV 倍数
  - 发现不同渠道 eLTV 差距显著：Doni FB 2.61 vs GG 3.43 (+31%)，Dora iOS FB 1.77 vs Organic 3.00 (+69%)

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
  - 避免极端亏损案例污染坐标轴，影响整体可读性
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
  - 脚本：`scripts/operator-daily-report.js`（文字）+ `scripts/operator-multiday-data.js`（多天 JSON）+ `scripts/operator-charts.py`（折线图）+ `scripts/send-operator-report.sh`（发送）
  - 飞书群「投手日报」`oc_15b383a83d008af776490affcd889b40`，cron 每天 07:30
  - 内容：每个投手昨日消耗/修正后收入/投放利润/利润率 + 月初至今收入趋势图 + 利润率趋势图
  - 利润 = 收入 × (1-平台费率) × (1-退款率 0.01) - 消耗
  - 平台费率：GraceChat 0.3, Dora And 0.2, Dora iOS 0.3, Doni 0.23, Romi iOS 0.3, Luma 0.125, Jovia And 0.26, Romi And 0.3, Kira And 0.15, Nalo And 0.15
- ✅ **投手匹配规则扩展**
  - 新增 alias：`liuh` → lh（刘欢），`zm`（非 zmf）→ zm1（张苗）
  - 删除 DSK（邧世坤，已离职）
  - 清除个人面板 snapshot 缓存（`data/personal-snapshots/`）以重新计算
  - 注意：修改匹配规则后需清除 personal-snapshots 缓存才能生效
- ✅ **投手名单更新**
  - 删除 DSK（邧世坤）从 OPERATOR_CODES，历史数据归入 other
  - 新增 WTY（吴天越）：个人面板 + 投手日报同步添加
- ✅ **eLTV 模型切换：三指数D180贴现 → 双指数D30无贴现**
  - 背景：实际数据不足30天，三指数（5参数）拟合D180过拟合
  - 新模型：f(t) = a1·e^{-l1(t-1)} + (1-a1)·e^{-l2(t-1)}，3参数
  - D30无贴现，主要变化：Doni 3.10→2.78, Dora And 5.76→5.15
  - 性能优化：SQL install_time过滤 + 只扫202605+表 + iterate()替代all()避免OOM
  - 工具脚本 `scripts/eltv-comparison.js` 用于对比多种模型
- ✅ **XMP 汇总拓取失败修复 + 调度器整点对齐**
  - 根因：summary fetch 和 XMP campaign cache warm 同时触发，超 XMP 10 QPM 限频
  - 调度器从 `setInterval` 改为自校准 `setTimeout`，每次执行完重新计算下一个整点
  - summary 固定 xx:00，XMP warm 固定 xx:05，重启后始终对齐墙钟
- ✅ **去除 XMP 凌晨 UTC date clamp**
  - 之前：北京 0-8 点 clamp 到 UTC 前一天，读到昨日数据
  - 现在：始终传北京日期，API 拒绝则返回空，面板显示 0

### 2026-05-31
- ✅ **eLTV 倍数改为仅新用户数据拟合（重大变更）**
  - 根因：老用户（安装时间远早于数据采集期）的高 D 值付费制造虚假的"高长期留存"，系统性拉高 eLTV 倍数
  - 影响：GraceChat 4.74→1.97（-58%）、Jovia And 9.64→3.87（-60%）、Doni 5.42→2.87（-47%）等
  - `/api/eltv-multipliers`：只使用 install_time ≥ 2026-05-10 的新用户 `af_purchase` 数据进行三指数衰减拟合，每日 1% 贴现率惩罚远期外推（`ELTV_DISCOUNT_RATE=0.01`，D_d 收入 ÷ 1.01^(d-1)）
  - 启动预热：同步使用新用户数据重建 HWM
  - campaign-context static fallback：更新为新用户版 D180 值
  - 可信度阈值降低：🟡 D1天数 ≥ 10 且记录 ≥ 3,000（原 >10 / >10,000）；🟢 D1天数 ≥ 30 且记录 ≥ 10,000（原 >30 / >30,000）
  - 清空 eltv-hwm.json 和 eltv-cache.json，在新规则下全部重新计算
  - 涉及文件：`server.js`（eLTV 路由 + 预热 + campaign-context static fallback + 三处可信度阈值）
- ✅ **修复：AI 投放建议 eLTV 可信度与个人面板不一致**
  - 根因：`/api/campaign-context` 中 `eltvCacheForProduct` 按 `Object.keys()` 插入顺序遍历，取到的是最旧缓存条目（数据量不足、confidence=red）；拿到缓存 confidence 后直接使用，跳过了 `applyConfidenceHWM()`
  - 修复：缓存查找改为按日期倒序（优先最新条目）；不管 confidence 来源，最后都过一遍 HWM，确保与个人面板 `/api/eltv-multipliers` 口径一致
  - 影响案例：Jovia And 个人面板显示 🟡供参考，但 AI 输入中显示 🔴不可信
  - 涉及文件：`server.js`（`/api/campaign-context` 路由内 `eltvCacheForProduct` 查找 + confidence 赋值逻辑）

### 2026-05-27
- ✅ **量化因子分析上线**
  - 基于 60 天全量投放数据（SQLite 收入 + XMP API 消耗）完成四大量化因子分析：日历 / 动量 / 波动率 / 消耗响应
  - XMP 历史数据批量拉取脚本 `analysis/fetch-xmp-history.js`（48 天增量）
  - 数据准备 `analysis/prepare_data.py` + 分析 `analysis/factor_analysis_v2.py`
  - 核心发现：日历效应不显著；FB/GG 均值回归；TT 加量最安全，GG 最危险
  - 新建 `dashboard/AI投放决策.md` 供 AI 建议系统参考
  - 飞书同步版：https://presence.feishu.cn/docx/JAWKdWIgso8a98xBdKTcfQbDn5e
  - 新建专家文档 `docs/factor-analysis.md`（方法论 + 数据源 + 重新分析指南）
- ✅ **AI 建议 system prompt 升级**
  - server.js 同时加载 `投放大师.md` + `AI投放决策.md`，当经验与数据结论冲突时以数据结论为准

---


### 2026-05-26
- **eLTV 可信度标签高水位（HWM）机制**：可信度只升不降，一旦产品达到某个等级就不会回降
  - 新增 `eltvConfidenceHWM` 对象 + `applyConfidenceHWM()` 函数（`server.js` 顶部）
  - `/api/eltv-multipliers` 返回值新增 `confidence` 字段（已应用 HWM）
  - 个人面板 eLTV 可信度改为使用后端返回的 `confidence`（之前通过 `eltvCache` 随机取日期或 `eltvStatic` 硬编码 fallback，可能导致可信度波动）
  - 服务启动时自动遍历 DB 预热 HWM（避免重启后丢失）
  - 前端 `getEltvConfidence()` 从独立计算改为直接读取后端 `confidence` 字段
  - 修复：前端原逻辑用 OR 条件（`d1Span <= 10 || records <= 10000` → 🔴）与后端 AND 条件不一致，现已统一
  - 涉及文件：`server.js`（HWM 逻辑 + 启动预热 + eLTV 接口 + 个人面板）、`public/app.js`（前端可信度判断）
- **投手汇总层级新增 eLTV 指标**
  - 个人面板投手汇总行右侧「新ROAS」后新增「eLTV」列
  - 算法：遍历该投手下所有产品×渠道，每个渠道的 eLTV ROAS = (修正新用户收入 / 消耗) × D180倍数，然后按消耗加权平均
  - 无 eLTV 倍数的产品或无消耗的渠道不参与计算
  - 颜色：≥100% 绿色，<100% 红色
  - 涉及文件：`public/app.js`（`renderPbPersonal` 投手头部）
- **eLTV 缓存 + HWM 磁盘持久化**
  - `eltvCache` 落盘到 `data/eltv-cache.json`，启动时自动加载，避免重启后每次重新计算（遍历全部 DB 耗时数秒）
  - `eltvConfidenceHWM` 落盘到 `data/eltv-hwm.json`，启动时自动加载
- **修复：`afNewUserExtraRows` 循环中 `afCamps` 未定义导致历史日期无数据**
  - 根因：AF 跨天新用户补查循环引用了上一个 for 块作用域内的 `const afCamps`，抛出 ReferenceError 被 catch 吐出 `afCamps is not defined`
  - 影响：无快照的历史日期（如5/24、5/25）访问时报错，显示“暂无数据”
  - 修复：在补查循环内重新从 `operatorMap` 获取 `afCamps` 并初始化缺失的 campaign
- **修复：`applyCrossDayPatch` 中 `camp` 未定义导致服务崩溃**
  - 根因：AF 跨天补丁循环定义了 `campKey` 但未用它查找 `camp`，直接引用未定义变量
  - 影响：多日模式（昨天→今天）加载昨天 partial 快照时触发，ReferenceError 未被 try-catch 捕获，直接 crash 进程
  - 修复：添加 `const camp = (ch.campaigns||[]).find(c => c.campaign === campKey)`

### 2026-05-25

- **素材工厂全流程上线（Material Factory）**
  - 项目目标：AI 批量生成情感向广告素材，替代擦边素材提升 LTV
  - 定义 13 个素材系列（12 预定义 + 1 自定义）：singlemom / nightshift / smalltown / startover / neighbor / plussize / latenight / momfriend / profile / waitingforyou / churchgirl / overtime / custom
  - 创建专家文档 `docs/material-factory.md`（受众画像、创意原则、系列定义、测试策略）
  - 前端：Dashboard 新增「🏭 素材工厂」面板，13 个系列卡片 + 详情页 6 个内容区块
  - 后端：新增 multer 依赖，实现内容 CRUD API（list / upload / download / delete）
  - 每个区块支持：⬆上传（标题+文本或文件）、在线预览（图片/视频/音频/文本）、⬇下载（参考图片/素材视频/BGM）、✕删除
  - 文件存储：`data/factory/{seriesId}/{section}/`，元数据 `_meta.json`，不限上传格式，单文件上限 500MB
  - 涉及文件：`server.js`（API 路由 + multer）、`index.html`（面板 HTML）、`style.css`（卡片+详情+预览样式）、`app.js`（FACTORY_SERIES + 上传/下载/预览逻辑）
  - singlemom 系列第一张参考图已用即梦 AI 生成（中文 prompt 效果好）
- **日期范围查询**：所有面板支持选择起始日期和终止日期，查看时间段内的聚合数据
  - 后端：`/api/data`、`/api/af-summary`、`/api/correction-factors`、`/api/postback/personal` 新增 `startDate` + `endDate` 参数，向后兼容单 `date` 参数
  - 汇总面板：遍历每天 `data/YYYY-MM-DD.json` 聚合 athena/xmp 数据，返回 `isRange` + `missingDates`
  - AF summary：SQL `BETWEEN` 查询，自动处理跨月表（`getTablesForRange`）
  - 修正系数：多日模式返回 `dailyFactors`（每天各自系数），eLTV 用 endDate
  - 个人面板：多日遍历快照（历史日期不查 XMP，今天走 `getPersonalDataLive`），聚合到 campaign/adset/ad 全层级
  - 多日模式后端预计算 `correctedRevenue`/`correctedNewUserRevenue`，前端修正开关直接使用
  - 前端：单日期选择器改为双日期（起始 → 终止），多日隐藏趋势图、昨日对比、小时增量，missingDates 显示 ⚠️ 图标
  - 辅助函数：`getDateRange(startDate, endDate)`、`getTablesForRange(startDate, endDate)`

- **Campaign 名称空格不匹配修复**：XMP API 和 AF 回传的 campaign 名末尾可能带空格，导致同一 campaign 拆成两行
  - 影响范围：2 个 XMP campaign（Luma wcx TT）+ 10 个 AF campaign 带尾部空格
  - XMP 入口 trim（`fetchXmpCampaigns` 第 173 行）
  - AF campaign key trim（paidRows、extraNewUserRows、installMap）
  - XMP campaign key trim（合并到 operatorMap 时）
  - 多日聚合 merge 时 trim（兼容历史快照中的旧数据）


### 2026-05-21
- **AI 输入数据文本框列对齐优化**：
  - 前端 textarea 和后端 LLM userText 的 Markdown 表格加入自动列宽对齐（pad 空格）
  - 中文字符按 1.6 等宽宽度计算（`charCode > 0x7F ? 1.6 : 1`），比 2.0 更贴合等宽字体实际渲染
  - 历史表移除「可信度」「回本ROAS」两列（每天相同，仅在实时数据区展示一次）
  - 日期列去掉年份前缀（`05-14` 代替 `2026-05-14`），缩短行宽
  - 所有数值小数点后最多 3 位（`f3()` 截断函数）
  - AI 模态框 max-width 从 780px → 900px（加宽约 15%）
- **AI 投放建议数据对齐个人面板**（修复 3 个 Bug）：
  - **新用户收入口径修正**：`/api/campaign-context` 的 `computeDayMetrics()` 从按 `event_time` 在当天计算改为按 `install_time` 在当天 + 跨天补查（install 当天但 event 在次日且 <24h），与个人面板完全一致
  - **修正系数修复**：新增 `computeCorrectionFactorsSync()` 函数，之前调用的是一个不存在的函数，被 `catch` 静默吞掉导致修正系数永远为 1；同时优化为按单产品查询避免全产品遍历、按日期缓存避免重复计算
  - **XMP 数据缺失修复**：磁盘缓存文件不存在时改用 `fetchXmpCampaigns()` 实时查询 XMP API，而不是返回 $0
  - 性能：从 ~100ms（修正系数错误时）变为 ~2.5s（正确计算后），LLM 本身需 10-30s 所以影响不大
- **AI 建议输入数据格式优化**：
  - 前端 + 后端的输入数据表格从空格对齐改为 Markdown 表格（`|` 分隔列），解决 LLM 混淆 CPI 和新用户收入列的问题
- **雅典娜收入 API 替代 Playwright**（§9 完成）：
  - `fetcher.js` 新增 `fetchAthenaApi()` 函数，直接调用 `admin-api-prod.sitin.ai` 生产环境 API
  - 替代了 `fetch-revenue.sh` Playwright 脚本（保留作手动 fallback）
  - 拓取速度从 30-60s 提升到 <1s，Nalo And 有雅典娜数据了
  - 经 prod 数据对比验证：11 个产品中 6 个完全一致，其余差异 <$70（抓取时间点微小偏差）
  - API Key 和产品名映射硬编码在 `fetcher.js` 中
- **AI 建议补充 AD（Adjust）数据查询**：
  - `computeDayMetrics()` 新增 `ad_purchase` 新用户收入查询（含跨天补查，AD 的 event_time/install_time 是 unix 时间戳）
  - 新增 `ad_complete_registration` 安装数查询
  - AD campaign 名 URL 解码 + 去 `(id)` 后缀 + trim 后与目标 campaign 比较
  - 所有 campaign 匹配统一使用 `trim()`，避免 XMP 尾部空格导致不匹配
  - 影响范围：iOS 产品（Luma / Romi iOS / Dora iOS），Android 产品无 AD 数据不受影响
- **SERVER_OVERVIEW.md 拆分为 MoE 架构**：
  - 主文档从 65KB 缩减为 6.5KB（仅保留索引 + 关键摘要 + 路由关键词表）
  - 拆分为 6 个专家文档：`docs/dashboard.md`、`docs/dataserver.md`、`docs/scheduling.md`、`docs/ad-platform-apis.md`、`docs/scripts-and-tools.md`、`docs/changelog.md`
  - 新体系总计 66.3KB ≈ 旧版 66.6KB，信息零丢失
  - 效果：大多数任务只需读主文档(6.5KB) + 1个专家文档，节省 50-85% 上下文消耗
  - `docs/` 目录从 .gitignore 移除，纳入版本控制

### 2026-05-20 (晚间)
- **`/api/campaign-context` 性能优化 10.5s → ~100ms**：
  - **DB 连接复用**：从每天开/关一次 SQLite 连接改为整个请求生命周期只开 1 次（原来 8 天 = 8 次开关）
  - **XMP 缓存直读磁盘**：从 `fetchXmpCampaigns()` 多层逻辑改为直接 `fs.readFileSync()` 读 `data/xmp-cache/` JSON 文件（原来每次要走缓存检查+过期判断+日志打印，0.5s/次 × 8 天 = 4s）
  - **eLTV 静态 fallback**：从每次请求触发 `computeEltvMultipliersSync()` 全量重算（~4s）改为优先使用内存缓存 → 静态 fallback 表
  - **数据库索引**：`records_202605` 新增 `campaign` 索引和复合索引 `(campaign, event_name, date(event_time, '+8 hours'))`，单次查询从 594ms → <1ms
  - **TDZ Bug 修复**：handler 内部 `const fs = require('fs')` 导致同函数更早的 `fs.readFileSync()` 进入 Temporal Dead Zone 抛出 ReferenceError，被 catch 静默吞掉 → XMP 缓存全部读取失败 → campaign cost 永远 $0。移除 handler 内的重复声明修复
- **浏览器卡顿修复（CSS `backdrop-filter: blur()` 移除）**：
  - 根因：AI 建议弹层使用 `backdrop-filter: blur(4px)`，要求浏览器每帧对整个页面做实时高斯模糊渲染
  - 个人面板 DOM 极复杂（十几个投手 × 多产品 × 多渠道 = 数百表格行），Intel Mac 集成显卡被完全吃满
  - 症状：spinner 约 1 秒刷新一次、点击其他标签页卡顿 5 秒、切到其他标签或最小化后瞬间恢复（浏览器暂停不可见标签渲染）
  - 修复：全站移除 `backdrop-filter: blur()`（AI 弹层、服务概览弹层、loading overlay、面板锁定 overlay 共 4 处），用更深的半透明黑色替代
- **AI 建议改为非流式输出**：
  - 原因：GLM-5.1 推理过程产生数千个极小 SSE chunk（每个 1-3 字符），即使有 16ms 批量刷新也不足以缓解 DOM 操作量
  - 修改：`stream: false`，前端显示转圈等待，LLM 完整返回后一次性显示结果
- **LLM 超时 60s → 180s**：GLM-5.1 思维链过长导致 60s 超时失败

### 2026-05-20 (下午)
- **AI 投放建议功能大幅升级**：
  - `/api/campaign-context` 重写：新增 `getDayMetrics(day)` 函数，查询过去 7 天每日数据 + 今天实时数据
  - 每日数据包含：XMP 消耗/展示/点击 → CPM/CPC，AF 安装数 → CPI，AF 新用户收入，修正系数（自动区分 FB/非FB），eLTV D180 倍数，可信度标签，回本 ROAS
  - 前端弹层新增「📝 输入数据」只读文本框（等宽字体深色背景，表格化展示每日数据，含可信度🟢🟡🔴和回本ROAS）
  - 删除旧的「📊 输入数据摘要」卡片（HTML/JS/CSS 三处清理）
  - 实时数据 snapshotTime 从 UTC 改为北京时间（CST）
- **回本 ROAS 体系建立**：
  - 回本 ROAS 使用投放日报电子表格的实际值（119%~196%），不使用公式推导
  - 🟡 供参考时回本ROAS × 1.05；🔴 不可信时弃用 eLTV，改看新用户 ROAS（安卓 30%/iOS 60%）
  - 后端 `BREAKEVEN_ROAS_MAP` 硬编码 10 个产品的实际回本值
- **投放大师.md 创建并迭代**：
  - 完整的 AI 预算调整决策指南文档（角色定义/回本ROAS/时效性/周期性/渠道特性/生命周期/风险等级/异常处理/输出格式）
  - 已上传飞书云文档同步（https://presence.feishu.cn/docx/ZKLEd4Rnyomo4lxZXcwc4WZZnJe），屹恒在飞书上修改后同步回本地
  - System prompt = 投放大师.md 全文（每次请求实时读取文件，修改立即生效）
  - **透明性原则**：AI 收到的所有输入 = 输入数据文本框内容 + 投放大师.md 全文，无任何隐藏内容

### 2026-05-20 (上午)
- **UG 早报 cron 定时任务上线**：
  - OpenClaw cron 任务 `ug-morning-report`，每天 06:00 CST 精时执行
  - 修复 `send-ug-report.sh` 语法错误（多余 `fi`），改为发飞书群聊（bot 不能私聊未对话用户）
  - 创建飞书「UG早报」群（`oc_07e9c151b9b8bc8c1b4090f6880d7dcd`），成员：屹恒 + Max Zhou
  - Bot 作为群管理员发送早报
- **`gen-ug-report.py` 修复**：
  - eLTV API 登录 bug：从手动拼接 Cookie 改为 `http.cookiejar` 正确管理 session，修复 401 错误
  - 新用户收入从 AF+AD 合并改为**仅 AF**（AF 和 AD 均包含全量应用内事件，仅归因不同，合并会重复计算）
  - 早报标题/备注同步更新
- **雅典娜收入 API 对接测试**（§9）：
  - 读取飞书文档获取 API 信息，测试 dev 环境（`admin-api-dev.sitin.ai`）
  - 产品覆盖验证通过：API 11 个活跃产品完全映射到现有体系
  - 产品名映射规则确立：不带后缀的 Dora/Romi/Kira → iOS；Android → And
  - dev 环境数据几乎全零，无法做数值一致性验证，待生产环境对接
  - 新增 §9「进行中：雅典娜收入 API 对接」记录对接过程和经验
  - §4.7 数据来源凭据新增雅典娜 API 条目
- **文档更新**：
  - 数据库大小 358MB → 407MB，条目 37 万 → 42.7 万
  - Dashboard 内存约 700MB → 306MB（实测 CGroup 内存）
  - scripts/ 脚本清单新增 gen-ug-report.py / send-ug-report.sh / compute-eltv-trend.js
  - fetch-af.sh 标注为旧版（已被 DB 实时查询取代）
  - 章节编号调整（原 §9~§12 → §10~§13，新增 §9 雅典娜 API 对接）

### 2026-05-19
- **Nalo And 加入汇总面板**：
  - `dashboard/public/app.js` PRODUCTS 数组新增 `'Nalo And'`（共 11 个产品）
  - `dashboard/fetcher.js` PRODUCT_NAME_MAP 新增 `'Nalo: Meet, Swipe & Chat': 'Nalo And'`
  - 修复历史 XMP 缓存数据（11 个 JSON 文件，245 处 XMP 原名 → Nalo And）
  - Nalo And 无雅典娜收入数据，汇总面板该列显示 `--`
- **LLM API 集成（SiliconFlow）**：
  - `/etc/environment` 新增 `SILICONFLOW_API_KEY` 和 `SILICONFLOW_BASE_URL`
  - `sitin-dashboard.service` 新增 `EnvironmentFile=/etc/environment`（加载凭据）
  - `server.js` 新增 `/api/llm/chat` 路由（POST），支持 SSE 流式和非流式，转发至 SiliconFlow OpenAI 兼容 API
  - 模型：`zai-org/GLM-5.1`，超时 60s
- **Campaign AI 投放建议功能**：
  - `server.js` 新增 `/api/campaign-context` 路由（GET）：从 SQLite（AF 数据）+ XMP 缓存精确匹配 campaign 数据，组装 system prompt + user message
  - `dashboard/public/app.js` campaign 行新增 ✨AI 按钮 + `openAiAdvice()` / `closeAiAdvice()` / `runAiAdvice()` 函数
  - `dashboard/public/index.html` 新增 `#ai-advice-modal` 毛玻璃 overlay 弹层（同服务概览样式）
  - `dashboard/public/style.css` 新增 `.ai-modal-*` / `.ai-advice-btn` 等样式
  - 弹层功能：数据摘要卡片、推理过程折叠、加载/完成/错误状态指示、ESC 关闭、AbortController 取消
  - 初版曾用 `window.open` 新窗口，因 session cookie 问题导致 400 错误，改为主页面内 overlay 弹层解决
- **UG 早报功能（新增脚本）**：
  - `scripts/gen-ug-report.py` — 生成早报
  - `scripts/send-ug-report.sh` — 飞书发送
  - `scripts/compute-eltv-trend.js` — eLTV 趋势分析
- **文档更新**：
  - SERVER_OVERVIEW.md 新增 AI 建议功能说明、新增 API 路由、新增 LLM 凭据说明
  - 补充 fetcher.js PRODUCT_NAME_MAP 的变更说明
  - 补充 systemd EnvironmentFile 配置变更

### 2026-05-18
- **Git 版本管理上线**：
  - 创建 GitHub 私有仓库 `suyiheng544-lang/Agentic-UG-Demo`（个人账号）
  - workspace 目录初始化 git，配置 remote origin/main
  - 首次推送业务代码（dashboard/ + dataserver/ + scripts/）
  - dataserver 的 app.py、alert_monitor.py、dataserver.service 改为软链接指向 workspace 副本（原始文件备份为 *.local-backup）
  - 完善 .gitignore：排除所有数据文件、个人文件、OpenClaw 配置、调试文件、毕设相关脚本等
  - 清理历史追踪：移除首次提交时误入的 node_modules/、output/、skills/、thesis/、个人 .md 等文件
  - 仓库最终仅含业务代码（~30 个文件），干净可用
- **迁移至公司 org**：
  - 屹恒加入公司 GitHub org `presence-io`
  - 管理员在 org 下创建 `presence-io/Agentic-UG-Demo`
  - remote 从个人账号迁移到 org，代码已推送
  - 个人账号下 `suyiheng544-lang/Agentic-UG-Demo` 不再使用，可删除
- **文档更新**：
  - 新增 §7 Git 版本管理章节
  - 新增 §8 Google Ads API 规划（含申请流程、权限等级、核心阻塞）
  - 新增 §9 TikTok Ads API 规划（含5步申请流程、凭据体系、权限/Scope、Reporting API 能力、核心阻塞）
  - 新增 §10 Facebook/Meta Ads API 规划（含5步申请流程、凭据体系、权限/Scope、Insights API 能力、IP 关联风控、三家对比总结）
  - 数据库大小更新（280MB → 358MB，30万条 → 37万条）
  - 所有文档统一更新仓库地址为 `presence-io/Agentic-UG-Demo`

### 2026-05-15（晚间）
- **汇总面板 AF 数据源切换**：从 Playwright 爬虫（`fetch-af.sh` / `af-dashboard.js`）改为从 SQLite 数据库实时查询
  - 新增 `/api/af-summary?date=` 接口：直接查询 `records_YYYYMM` 表
  - AF Actual = event_time 在当天的全部 `af_purchase` 收入
  - AF LTV = install_time 和 event_time 在**北京时间同一天**的 `af_purchase` 收入（汇总面板专用口径，个人面板仍保留 24h 口径）
  - AF 激活 = `af_complete_registration` 事件数（含自然量/restricted；AD 的 `ad_complete_registration` 不计入，因其与 AF 自然量重复）
  - fetcher.js 不再调度 AF Playwright 抓取，前端改为调用 `/api/af-summary` 获取实时数据
  - 效果：AF 数据从每小时更新变为页面刷新即更新；PF 小时增量图暂时不可用（待后续补做）
- **服务概览按钮**：导航栏右侧新增「服务概览」按钮，点击弹出模态框展示 `SERVER_OVERVIEW.md` 全文
  - 新增 `/api/overview` 接口：返回 SERVER_OVERVIEW.md 原始内容
  - 前端：毛玻璃遮罩模态框 + 等宽字体展示 markdown 内容，ESC/点击遮罩关闭
- **飞书云文档写入能力**：通过飞书开放 API 实现文档读写（读取 wiki node → 获取 obj_token → 创建/更新 block）
  - 已验证：读取老板的 Agentic UG 规划文档、写入 wiki 文档内容
  - 凭据：飞书应用 `<FEISHU_APP_ID>`，tenant_access_token 认证
  - API 限制：创建 block 每次最多 50 个子 block
- **eLTV 查询**：验证了 `/api/eltv-multipliers` 接口的 CLI 查询流程（需先登录获取 session cookie）

### 2026-05-15（白天）
- 文档更新：
  - 修正 alert_monitor 描述（非 crontab 定时，为手动/脚本运行）
  - 补充 openclaw-gateway 端口 8080
  - 补充 dataserver 运行信息（Python 3.6.8、DB ~280MB/~30万条、service 文件完整参数）
  - 补充 sitin-dashboard 运行信息（~700MB 内存、service 文件配置）
  - 新增 4.6 Dashboard API 一览表（完整路由列表 + CLI 登录查询示例）
  - 修正 XMP 数据源描述：汇总面板已从 Playwright 切换到 API（`fetch-xmp-api.sh`），修正凭据表
  - 补充 XMP_PRODUCT_MAP 示例（Kira And/Kira iOS）
  - 完善 scripts/ 目录脚本清单
  - 完善常用查询：加入 Dashboard API 登录+查询命令
  - 关联文档新增 TOOLS.md

### 2026-05-14（晚间）
- **个人面板懒加载/虚拟渲染**：
  - `renderPbPersonal()` 重写：只渲染投手→产品→渠道三层，campaign/adset/ad 行不插入 DOM
  - 展开时通过 `togglePbpChannel()` 动态调用 `_renderCampaignRows()` / `_renderAdsetRows()` / `_renderAdRows()` 生成子表格
  - DOM 元素从 36,433 → ~3,500（减少 90%），HTML 从 2.1MB → ~170KB（减少 92%）
  - 加载时间优化：今天 15.4s→1.6s / 昨天 16.9s→1.1s / 前天 18.4s→0.6s
- **请求取消机制**（AbortController）：
  - 切换日期/面板时自动取消旧的 `postback/personal` / `correction-factors` / `eltv-multipliers` 请求
  - 被 abort 的请求不触发 hideLoading（修复 loading 遮罩竞态 bug）
- **XMP staleOk 模式**：个人面板的 XMP 调用使用 `{ staleOk: true }`，缓存过期时返回旧数据避免阻塞
- **快照保存校验修复**：`responseHasReasonableCost()` 从仅检查总消耗 > $100 改为要求 FB/GG/TT 三渠道都有消耗数据，防止 XMP 限频导致的残缺快照（5/13 的坏快照已删除并重新生成）

### 2026-05-14（白天）
- **素材面板**上线（新增第三个一级 tab）：
  - `fetch-creative-data.js`：XMP 素材报表 API + AF/AD postback 新用户收入，按 4 字段（日期/设计师/系列/序号）解析素材名称
  - 前端：FB / TT 分渠道表格，展示新用户收入/消耗/ROAS/CPM/CPC/CTR，支持排序和翻页
  - 每天首次进入面板自动抓取前一天数据；首次使用已一次性抓取 5/11-5/13 三天历史数据
- **个人面板快照缓存**：
  - 前天及以前 → `complete` 快照，访问 ~20ms
  - 昨天 → `partial` 快照（6 点后 + 有消耗数据），访问 ~400ms
  - `partial` 在变成前天时自动升级为 `complete`
  - 快照目录：`data/personal-snapshots/`
- **XMP campaign 缓存落盘**：`data/xmp-cache/`，重启后直接复用，解决重启后 XMP 限频问题
- **gzip 压缩**：server.js 加入 `compression` 中间件，API 响应体积降至原来 13%（267KB → 37KB）
- **全屏 Loading 遮罩**：数据加载期间显示毛玻璃特效 + LOADING 动画，导航栏保持可操作（z-index 分层）
- **重启不触发初始抓取**：删除 startup 时的 `fetchAll()` / `fetchPersonal()` 调用，避免打满 XMP QPM
- **SQLite 复合索引**：`records_202605` 新增 `idx_records_202605_evt_ms(event_name, media_source)`，SQL 查询提速

### 2026-05-13
- **新产品 Nalo And**（`com.cavalier.nalo`）接入：APP_ID_MAP + XMP_PRODUCT_MAP 均已添加
- **修正收入系数**（`/api/correction-factors`）：
  - 安卓：雅典娜 / AF非自然量 × 0.95
  - iOS：FB 渠道先乘固定系数（GraceChat×2, Dora/Romi×1.4, Luma×1.35），再统一乘基础系数；AF+AD 合并计算；AD 的 `Unattributed` 归入 FB
  - 数据源逻辑：查询 DATE 用 DATE 自身数据；若 DATE 为今天则 fallback 昨天
  - 前端开关：每个产品渠道表格表头右侧，切换原始/修正模式
- **eLTV ROAS 列**（`/api/eltv-multipliers`）：
  - 三指数衰减模型拟合 D180 LTV 倍数，遍历所有历史月份表
  - eLTV ROAS = 新用户ROAS × D180 倍数，每日缓存一次
  - 可信度标签（绿/黄/红）基于 D1 时间跨度和数据量
- **新用户收入定义重构**：
  - 新用户收入 = install_time 在目标日期（北京时间）且 event_time - install_time < 24h
  - 总收入仍按 event_time 在当天统计，两者独立
  - 新增 afNewUserExtraRows / adNewUserExtraRows 查询：捕获 install 在当天但 event 落在次日的付费
  - 支持跨月表查询（month boundary）
  - 修复 nextDateStr 计算的 JS Date UTC 时区 bug（`new Date('+08:00').toISOString()` 会回退一天），改用纯字符串日期加一天
- **修正开关移到导航栏**：从表格第 10 列移到顶部导航栏日期选择器左侧，仅个人面板可见；表格从 10 列减为 9 列，解决 campaign 子表格列对齐问题
- **XMP 缓存策略**：三渠道都有消耗才写 30 分钟缓存，否则 5 分钟短缓存
- **个人面板表格样式**：`col-num` 宽度缩小 15%（150px → 127px）；表头取消 `text-transform: uppercase`；campaign/adset/ad 子表格加 `max-width` 对齐

### 2026-05-12
- Adjust 回传数据去括号：campaign/adgroup/creative 末尾的 `(唯一ID)` 在展示时自动去除
- XMP API 指标改为请求 `impression`/`click`，前端自行计算 CPM/CPC（$保留两位小数）
- 修复 XMP API 字段名 bug（单数 `impression`/`click`，非复数）
- 修复 campaign 对象初始化缺少 `impressions`/`clicks` 字段导致 NaN
- 渠道级 CPM/CPC 改为从所有 campaign 的展示/点击汇总计算
- 统一渠道分类：新增 `mapMediaSource()` 函数，FB/FB W2A/GG/TT + 自然量过滤
- XMP 数据过滤：product_name 为 null 的记录直接丢弃
- 新增 `/admin` 接口：接收雅典娜收入数据推送
- 雅典娜凭据更新（`/etc/environment`）
- 新增 CPI 指标：基于 `complete_registration` 事件计算每次安装成本

### 2026-05-11
- 创建本文档
- 个人面板新增 campaign → 广告组(adset) → 素材(ad) 三层逐级展开
- 个人面板从隐藏入口提升为与汇总面板并列的一级 tab
- 数据发现：非美元订单极少（36/77087），AF 回传已统一转 USD 存入 revenue 字段

### 2026-06-03
- ✅ **修复：XMP API 凌晨 00:00-08:00 数据抓取全部失败**
  - 根因：XMP API 近期更新了日期校验逻辑，用 UTC 判断"当前日期"。北京时间 00:00~08:00 之间，北京已翻日但 UTC 还是前一天，请求被拒绝（"start date cannot be greater than current date"）
  - 修复：在三个入口加 date clamp（`min(北京日期, UTC日期)`）：`fetch-xmp-api.js`、`fetch-personal-xmp-api.js`、`server.js fetchXmpCampaigns()`
  - 00:00-08:00 之间降级查前一天完整消耗，08:00 后正常查当天实时数据
