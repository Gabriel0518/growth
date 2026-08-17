# dashboard（投放看板，端口 8081）

> 专家文档：投放数据看板的完整技术细节。从 SERVER_OVERVIEW.md 拆分。

---

## 基本信息

- 代码目录：`~/workspace/dashboard/`（`/home/admin/.openclaw/workspace/dashboard/`）
  - `server.js`（~150KB）—— Express + better-sqlite3，登录态 + 后端聚合 + XMP API 实时调用
  - `fetcher.js` —— 定时拉取雅典娜 / XMP 数据并落盘（汇总面板用）
  - `投放大师.md` — AI 投放建议决策指南（system prompt 来源，每次 LLM 请求实时读取，修改立即生效）
    - 飞书同步版：https://presence.feishu.cn/docx/ZKLEd4Rnyomo4lxZXcwc4WZZnJe
  - `fetch-creative-data.js` —— 素材数据抓取脚本（XMP 素材报表 API + AF/AD 新用户收入）
  - `public/` —— 前端 (`index.html` / `app.js` / `style.css`)
  - `data/` —— 每日 JSON 缓存：`YYYY-MM-DD.json` + `personal-YYYY-MM-DD.json`
  - `data/personal-snapshots/` —— 个人面板快照缓存
  - `data/xmp-cache/` —— XMP campaign 数据磁盘缓存（重启后复用，3 天前自动清理）
  - `data/creative-YYYY-MM-DD.json` —— 素材面板每日数据
- 服务文件：`/etc/systemd/system/sitin-dashboard.service`
  - `ExecStart=/usr/bin/node server.js`，`Environment=NODE_ENV=production`
  - `EnvironmentFile=/etc/environment`（加载 LLM API 等凭据）
- **登录认证**：所有 `/api/*` 接口需要 session 认证（`authCheck` 中间件）
  - 用户名：`admin`，密码：`<DASHBOARD_ADMIN_PASS>`

---

## 面板结构

### 汇总面板

全公司产品汇总（雅典娜收入 + XMP 消耗 + AF 收入/激活）。

- 产品：GraceChat、Dora iOS、Dora And、Doni、Romi iOS、Romi And、Luma、Jovia And、Kira iOS、Kira And、Nalo And（共11个）
- 数据来源：fetcher.js 每小时调用 API 落盘到 `data/YYYY-MM-DD.json`（雅典娜 + XMP）
- 雅典娜：HTTP API（`admin-api-prod.sitin.ai`，已替代 Playwright，<1s 完成）
- XMP：shell 脚本调用 API（`fetch-xmp-api.sh` → `fetch-xmp-api.js`）
- AF：**从 SQLite 数据库实时查询**（`/api/af-summary`）
  - AF Actual = event_time 在当天的全部 `af_purchase` 收入
  - AF LTV = install_time 和 event_time 在**北京时间同一天**的 `af_purchase` 收入（汇总面板专用口径，与个人面板的 24h 口径不同）
  - AF 激活 = `af_complete_registration` 事件数（含自然量/restricted；AD 的 `ad_complete_registration` 不计入，因其与 AF 自然量重复）

### 渠道明细（Channel Summary）

汇总面板产品表格下方的独立表格，按 FB / GG / TT 三渠道展示汇总数据（2026-06-10 上线）。

- 数据来源：
  - **消耗**：XMP 磁盘缓存（只读缓存，不触发实时拉取）
  - **收入**：AF `af_purchase` + AD `ad_purchase` 实时聚合
  - **注册数**：AF `af_complete_registration` + AD `ad_complete_registration` 实时聚合
  - **新用户收入**：install_time 在目标日期 + event_time - install_time < 24h
  - **D7 收入**：install_time 在目标日期 + event_time - install_time < 168h
- 渠道映射：`restricted` 和 `Unattributed` 归入 FB（仅此 API），`organic` 排除
- 指标列：消耗 / 收入 / CPI / 新用户 ROAS / D7 ROAS
- **产品明细展开**：每个渠道行可点击展开，显示该渠道下各产品的独立指标（消耗/收入/CPI/新用户ROAS/D7 ROAS），按消耗降序排列
  - 后端 SQL `GROUP BY media_source, app_id`，通过 `APP_ID_MAP` 映射到产品名
  - XMP 缓存每行已有 `product` 字段，直接按渠道×产品聚合
  - 前端：渠道行左侧 ▶ 箭头，点击展开/折叠产品明细子行
- D7 ROAS 不满 7 天的日期标记 `*`（`d7Incomplete` 列表）
- XMP 缓存缺失的日期在前端显示 ⚠️（`xmpMissingDates` 列表）
- **性能优化**：SQL 全部用 UTC 范围查询（不用 `date()` 函数），多天查询一条 SQL 完成（不逐天循环）
  - 依赖索引：`(event_name, event_time)` 和 `(event_name, install_time)` 复合索引
  - 5 月单日 <1s，14 天范围 ~23s

### 素材面板

按 FB / TT 分渠道展示近 3 个完整天的素材排名（第三个一级 tab）。

- 数据来源：`fetch-creative-data.js` 每天首次访问时抓取前一天数据
- 素材名称由 4 字段唯一确定：日期（MMDD）、设计师、系列、序号，格式如 `0317_ZHT_多女左滑口播_6`
- 展示指标：新用户收入 / 消耗 / ROAS / CPM / CPC / CTR
- XMP 素材报表 API 端点：`POST /v2/media/material_report/list`

### AIGC 素材面板（第四个一级 tab，产品感知）

按 FB / TT 分渠道展示 AIGC 素材排名，每条带真实产品。标题右侧有 **3/7/14 天** 时间窗口切换。

- 数据来源：`fetch-creative-data.js --aigc [date]`，每天首次访问拉前一天。输出 `data/aigc-YYYY-MM-DD.json`。
- **时间窗口**：`/api/aigc/data?days=3|7|14`（默认 3），后端取 `[today-N, …, today-1]` N 个完整天聚合；返回 `missingDates`（窗口内缺数据文件的日期）供前端提示。历史天数据用 `node fetch-creative-data.js --aigc YYYY-MM-DD` 逐天补。
- **消耗端走「广告报表」而非「素材报表」**：`POST /v2/media/account/report`，`report_type:'ad'` + `dimension:['ad_name','product_name']`。每条广告天然只属一个产品，避开了素材报表按 md5 跨产品合并成 bundle 丢失产品的问题。`ad_name` 是投手命名的完整素材名，与 AF/AD postback 的 `af_ad`/`creative` 同源同格式。
- **收入端**：AF/AD postback 新用户收入，用 `bundle_id`/`app_id` → `APP_ID_MAP` 解析产品。
- **匹配键**：「规范化素材名（去变体后缀 _1/_copy/8位哈希）+ 基础产品（去 iOS/And 后缀，与素材名一致）」，让消耗与收入按产品精确对齐。
- **表格「产品」列**：后端权威 `product` 字段直接渲染（不再从名称猜）；CSV 导出也含产品列。
- **只看 FB/TT**：GG（Google）渠道不计入（AF organic/Google 跳过）。
- **数值筛选（2026-06-30）**：筛选栏加一组「指标 + 比较方式 + 数值」筛选——指标（新用户收入/消耗/ROAS/CPM/CPC/CTR）、比较（> ≥ = ≤ <）、输入数字，按条件过滤素材。值取自 `computeAigcMetrics`，所以**修正开关开启时数值筛选自动用修正后的收入/ROAS**。状态 `aigcNumFilter={metric,op,value}`，value 为空不生效；重置按钮一并清空。
- **修正开关（2026-06-30）**：标题行加修正收入开关（挨着时间窗口），开启后新用户收入按「产品+渠道」乘**最新一份修正系数**（昨天那份，`/api/correction-factors?date=昨天`），ROAS 据修正收入重算。
  - 系数按**完整产品名**存（区分 iOS/安卓），AIGC 用**基础产品名**，靠 `AIGC_FACTOR_PRODUCT` 映射：Doni→Doni、GraceChat→GraceChat、Jovia→Jovia And、Kira→Kira And、Luma→Luma、Nalo→Nalo And、**Romi→Romi iOS**（屹恒定，一律按 iOS）、Dora→Dora iOS。
  - 渠道：安卓产品单系数忽略渠道；iOS 风格 `{fb,other}` 的 FB 渠道用 fb、TT 用 other。
  - 前端独立 `computeAigcMetrics()`（不动共享的 `computeCreativeMetrics`），render/sort/CSV 都走它。
- ⚠️ account/report 端点用 `currency:'USD'`（不是素材报表的 `cost_currency:'usd'`）；sign 30 秒过期，每页重新签名。旧方案 `stripProductKey()` 已删除。详见 SERVER_OVERVIEW.md 2026-06-30 变更。

### 个人面板

按投手分组，逐层展开：投手 → 产品 → 渠道 → campaign → 广告组(adset) → 素材(ad)。

- **测素材分类规则**：campaign 名含「测」或「test」（不区分大小写）的归入「🧪 测素材」类目，与投手和「未匹配」同级，不计入任何投手数据。分类优先级：否定关键词 → operator code → 未匹配。
- 数据来源：**实时查询**（每次打开从 SQLite + XMP API 聚合），快照缓存加速历史日期
- **懒加载渲染**：初始只渲染投手→产品→渠道三层（~3,500 DOM 元素，原始 36,433），campaign/adset/ad 展开时动态生成（`_renderCampaignRows()` / `_renderAdsetRows()` / `_renderAdRows()`）
- 展示指标（9 列）：消耗 / CPM / CPC / CPI / 总收入 / 新用户收入 / 新用户ROAS / eLTV ROAS
- 数据层级：operator（投手/测素材/未匹配） → product → channel → campaigns[] → adsets[] → ads[]
- **测素材分类**：campaign 含「测」或「test」（case-insensitive）→ `test_creative`，优先级高于 operator code 匹配
- **投手汇总层级**：消耗 / 总收入 / 新用户 / 新ROAS / eLTV（按消耗加权平均各产品×渠道的 eLTV ROAS，不含测素材）
- **修正收入**：导航栏日期选择器左侧的全局开关，切换原始/修正模式（仅个人面板可见）
- 多日模式下，后端预计算每天各自修正值（`correctedRevenue`/`correctedNewUserRevenue`），前端切换开关直接使用
- **eLTV ROAS**：新用户ROAS × D30 LTV 倍数
- **请求取消**：切换日期/面板时 AbortController 自动取消旧请求（`postback/personal` / `correction-factors` / `eltv-multipliers`）
- **XMP staleOk 模式**：个人面板的 XMP 调用使用 `{ staleOk: true }`，缓存过期时返回旧数据避免阻塞
- **测素材分类**（2026-06-18）：campaign 名含"测"或"test"（不分大小写）的单独归为 `test_creative` 类目（前端显示"🧪 测素材"，淡黄色背景），不计入任何投手数据

### 🔍 查用户面板

输入用户 ID 查询广告归因信息（第五个面板，2026-06-08 上线）。

- 数据源：SQLite `user_lookup` 辅助表（13.8 万条，用户 ID 索引）
  - 从 `af_complete_registration` 事件的 `event_value.user_id` 提取建表
  - dataserver 收到新事件时自动同步写入
- 后端 API：`GET /api/user-lookup?userId=<5-10位数字>`
- 返回字段：产品、广告平台（FB/GG/TT）、媒体渠道、广告系列、广告组、素材、首次注册时间、安装时间、触发次数
- 广告平台归类：同时检查 `af_channel`（Instagram→FB、ACI_Display→GG、TikTok→TT）和 `media_source`（`mapMediaSource()` fallback）
- 前端折叠：同产品重复注册事件合并为一行，显示触发次数 N×
- 查询性能：<0.25s（索引查询，替代 LIKE 全表扫描 16s）
- 目前仅支持 AF 数据，AD（Adjust）待 event_value 跟通后扩展

### 独立用户归因查询 API（端口 9090）

与 Dashboard 查用户面板功能相同，但作为独立 HTTP 服务运行，支持批量查询。

- 代码：`dashboard/user-lookup-api.js`
- 端口：9090，systemd 服务 `user-lookup-api.service`
- 认证：Bearer Token（存于飞书文档）
- 支持 POST 批量查询（最多 200 个 ID）和 GET 快捷查询
- API 使用文档：https://presence.feishu.cn/docx/LkcCdvcQ9oOU6LxT06jcOsf9n5c

### 📈 收入来源图（按 install 时段看老用户依赖度，2026-06-26 上线）

个人面板的 campaign/渠道/产品/投手 四个层级行，名称旁各有一个「📈」按钮（campaign 行在 ✨AI 旁）。点击弹出折线图。

- **轴定义**：X 轴 = 安装时段桶（11 个，从左到右 = 老用户→新用户）：更早 · 85-98天 · 71-84 · 57-70 · 43-56 · 29-42 · 15-28 · 8-14 · 4-7 · 过去3天 · 当天；Y 轴 = 该安装时段用户在**查询日当天(event_time=查询日)**的修正付费金额总和。
- **意义**：折线左端（早 install）还高 = 查询日当天的收入中老用户贡献越多；集中在右端 = 当天收入主要来自新用户。直观看出每个 campaign/渠道/产品/投手多大程度依赖老用户付费。
- **后端 API**：`GET /api/revenue-by-install?level=campaign|channel|product|operator&campaign=&product=&channel=&operator=&date=&days=`（默认 days=99），返回 `{level,date,days,startDate,earlierRevenue,...,series:[{date,revenue}]}`。server.js 约第 3854 行。
- **口径**：主筛选 = event_time 在查询日当天（北京时间 0-24 点），吃 `(event_name,event_time)` 索引；按 install_time 北京日期分组到轴桶内；`earlierRevenue` = install 早于窗口起始日的修正收入。修正系数复用 `computeCorrectionFactorsSync`（今天→昨天回退，与面板一致），原始 revenue × 修正系数；安卓单一系数，iOS 有 fb/other 两档（FB W2A 用 fb 档）。Romi iOS 走全量口径（AF+AD 都计入，不去重，与面板对齐）。仅统计付费流量（排除自然量/restricted）。
- **性能**：event_time=单天过滤后数据量极小，campaign/渠道/产品 <0.2s，投手约 10s；days 只影响 JS 轴宽度，不影响 SQL 扫描量。跨月表用 `getTablesForRange`。
- **前端**：复用 Chart.js 4.4.1 line，逐日数据 + earlierRevenue 在 JS 侧聚合成 11 个时段桶，深色弹层（无 backdrop-filter，ESC/点遮罩关闭），`openRevenueByInstall()` / `rbiChart`。弹层副标题显示「当日修正付费 × 按安装时段」。

### AI 投放建议

campaign 行名称旁有 ✨AI 按钮，点击弹出 overlay 弹层（深色半透明背景，ESC/点击遮罩关闭）。

- 流程：前端点击按钮（`openAiAdvice()`）→ `/api/campaign-context` 拉取数据并构建结构化输入文本 → `/api/llm/chat` 调用 LLM（`runAiAdvice()`）→ 弹层显示
- 弹层内含：只读「📝 输入数据」Markdown 表格（过去7天+实时数据，含可信度标签🟢🟡🔴和回本ROAS）+ AI 建议输出 + 可折叠推理过程 + AbortController 取消
- **透明性原则**：AI 收到的所有输入 = 输入数据文本框内容 + 投放大师.md 全文，无任何隐藏内容
- LLM 供应商：SiliconFlow，模型 `zai-org/GLM-5.1`，**非流式**（`stream: false`），超时 180s
- **数据对齐个人面板**（2026-05-21 修复）：新用户收入按 install_time + 跨天补查；修正系数使用 `computeCorrectionFactorsSync()`；AF + AD 数据均查询；XMP 缺失时实时调 API

---

## 新用户收入定义

**新用户收入** = install_time 在目标日期（北京时间）且 event_time - install_time < 24 小时的付费总和

- 总收入按 event_time 在当天统计，新用户收入按 install_time 在当天统计（两者独立）
- 新用户收入可能 > 总收入（部分新用户的付费 event 落在次日，不计入当天总收入）
- 实现：paidRows 的 isNewUser 检查 installBeijingDay === date + diff<24h，加上 afNewUserExtraRows / adNewUserExtraRows（install 在当天但 event 在次日且 diff<24h），支持跨月表查询
- ⚠️ 计算 nextDateStr 时**不能用 JS Date + toISOString()**，必须用纯字符串/数字计算日期加一天，否则 UTC 时区偏移导致翻倍（`new Date('+08:00').toISOString()` 会回退一天）

---

## 渠道分类（`mapMediaSource()` 函数）

| 渠道 | media_source 值 |
|------|----------------|
| **FB** | `Facebook Ads`, `Facebook+Installs`, `Instagram+Installs`, `Off-Facebook+Installs`, `Social_facebook`, `facebook` |
| **FB W2A** | `Facebook+web`, 以及名字含 `W2A` 或 `web/Web` 的（如 `Dora+ios+FB+W2A`） |
| **GG** | `googleadwords_int`, `Google Ads ACI`, `Google+Ads+ACI` |
| **TT** | `tiktokglobal_int`, `TikTok+SAN` |
| **自然量（不计入）** | `organic`, `Organic`, `restricted`, `Unattributed`, `Untrusted Devices` |

---

## 修正收入系数（`/api/correction-factors`）

修正系数 = 雅典娜收入 / AF+AD 非自然量收入 × 0.95

**数据源规则**：查询 DATE 用 DATE 自身数据；若 DATE 为今天（数据不完整），fallback 昨天。

**安卓产品**（Dora And / Jovia And / Doni / Romi And / Kira And / Nalo And）：
- 单一系数 = 雅典娜收入 / AF `af_purchase` 非自然量收入 × 0.95

**iOS 产品**（Dora iOS / Romi iOS / Luma / GraceChat）：
- FB 渠道先乘固定系数（`fixed_fb_multiplier`）：GraceChat×2.0, Dora iOS×1.4, Romi iOS×1.4, Luma×1.35
- 基础系数 = 雅典娜收入 / (FB原始×固定系数 + 非FB收入) × 0.95
- AF + AD 合并计算；AD 的 `Unattributed` 归入 FB
- Kira iOS 系数固定为 1（产品已放弃）

---

## eLTV ROAS 与回本 ROAS

### eLTV D30 倍数（`/api/eltv-multipliers`）
- 双指数衰减模型拟合 D30 LTV 倍数：f(t) = a1·e^{-l1(t-1)} + (1-a1)·e^{-l2(t-1)}，3 个参数
- **按产品×渠道独立拟合**（FB / GG / TT 各自独立的 D30 倍数）
- **数据源规则**：Romi iOS FB 用 AD，Luma 全渠道用 AD，其他产品用 AF；restricted/Unattributed 归 FB，organic 排除
- 仅使用最近 30 天安装的新用户数据（滚动窗口，install_time >= today-30）
- eLTV ROAS = 新用户ROAS × D30 倍数（同产品×同渠道）
- 可信度标签仅看 d1Span（时间覆盖）：
  - 🟢 可信：d1Span ≥ 30
  - 🟡 供参考：d1Span ≥ 10
  - 🔴 不可信：d1Span < 10
- **高水位（HWM）机制**：可信度只升不降，按 `product_channel` 粒度持久化
  - 后端 `eltvConfidenceHWM` 对象持久化每个产品×渠道的历史最高可信度
  - `/api/eltv-multipliers` 返回值：`multipliers[product][channel] = { d180, confidence, records, d1Span }`
  - 前端 `getEltvMultiplier(product, channel)` / `getEltvConfidence(product, channel)` 直接使用后端返回值
- 每日缓存一次

### 回本 ROAS（`BREAKEVEN_ROAS_MAP`，基于投放日报电子表格实际值）

| 产品 | 回本ROAS |
|------|----------|
| Dora And | 152% |
| Jovia And | 172% |
| GraceChat | 196% |
| Doni | 156% |
| Kira And | 140% |
| Romi iOS | 168% |
| Dora iOS | 175% |
| Luma | 133% |
| Romi And | 190% |
| Nalo And | 119% |

- 🟡 供参考时回本ROAS × 1.05；🔴 不可信时弃用 eLTV，改看新用户 ROAS（安卓 30%/iOS 60%）

---

## 产品 app_id 映射（`APP_ID_MAP`）

| app_id | 产品名 |
|--------|--------|
| `id6746109957` / `com.circleconnect.dora` | Dora iOS |
| `id6746782904` / `com.chatsbridgeconnect.romi` | Romi iOS |
| `id6746466099` / `com.odyssey.luma` | Luma |
| `id1658972379` | GraceChat |
| `id6759697686` | Kira iOS |
| `com.doramatch.app` | Dora And |
| `com.qiga.vio` | Jovia And |
| `com.doni.appa` | Doni |
| `com.romiandroid.appmatch` | Romi And |
| `com.meraki.kira` | Kira And |
| `com.cavalier.nalo` | Nalo And |

**iOS AD app_ids**（`IOS_AD_APP_IDS`，Adjust 用数字 ID 无 `id` 前缀）：
- `6746109957`（Dora iOS）
- `6746782904`（Romi iOS）
- `6746466099`（Luma）

XMP 产品名映射（`XMP_PRODUCT_MAP` in server.js + `PRODUCT_NAME_MAP` in fetcher.js）：`'Nalo: Meet, Swipe & Chat'` → `Nalo And`、`'Kira: Find Your Romance'` → `Kira And`、`'Kira: Creative Community'` → `Kira iOS` 等。

---

## Dashboard API 一览

所有 API 需要 session 认证。CLI 查询需先登录获取 cookie：
```bash
curl -s -c /tmp/dash_cookie -L 'http://localhost:8081/login' \
  -d 'username=admin&password=<DASHBOARD_ADMIN_PASS>' -o /dev/null

# 然后用 -b /tmp/dash_cookie 查询
curl -s -b /tmp/dash_cookie 'http://localhost:8081/api/data/latest' | python3 -m json.tool
```

| 接口 | 方法 | 说明 |
|------|------|------|
| `/login` | POST | 登录 |
| `/api/correction-factors?startDate=&endDate=` | GET | 修正收入系数（多日返回 dailyFactors） |
| `/api/eltv-multipliers?date=` | GET | eLTV D30 倍数 |
| `/api/data?startDate=&endDate=` | GET | 汇总面板数据（多日聚合 + missingDates） |
| `/api/data/latest` | GET | 最新汇总数据 |
| `/api/personal/data?date=` | GET | 个人面板数据 |
| `/api/postback/personal?startDate=&endDate=` | GET | 个人面板回传聚合（多日聚合 + 修正值） |
| `/api/af-summary?startDate=&endDate=` | GET | 汇总面板 AF 数据（多日聚合） |
| `/api/channel-summary?startDate=&endDate=` | GET | 渠道明细（FB/GG/TT 消耗+收入+CPI+ROAS+D7） |
| `/api/xmp-backfill` | POST | XMP 缓存一键补全，NDJSON 流式返回进度，三渠道完整性验证+自动重试 |
| `/api/creative/data?date=` | GET | 素材面板数据 |
| `/api/campaign-context` | GET | AI 建议数据上下文 |
| `/api/revenue-by-install?level=&campaign=&product=&channel=&operator=&date=&days=` | GET | 收入来源图（查询日当天付费，按 install 日期分组，看老用户依赖度） |
| `/api/llm/chat` | POST | LLM 代理接口（SiliconFlow） |
| `/api/refresh` | POST | 手动刷新汇总数据 |
| `/api/overview` | GET | SERVER_OVERVIEW.md 内容 |

### 对外取数接口（外部 agent 用，2026-07-02）

鉴权改造：`authCheck` 支持 session **或** 密码（`?key=<登录密码>` / `Authorization: Bearer`），现有全部 `/api/*` 对外 agent 可直接取数。另加原始数据 + XMP 全能力透传接口：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/ext/meta` | GET | 数据地图：表/新鲜度/枚举/全接口清单/XMP文档链接 |
| `/api/ext/records` | GET | AF/AD SQLite 原始库直查（任意过滤+groupBy聚合+includePayload） |
| `/api/ext/xmp` | GET | XMP 消耗（缓存优先，`refresh=1` 实时） |
| `/api/ext/xmp-report` | GET/POST | XMP 广告报表透传 `/v2/media/account/report`（全维度全指标，10 QPM） |
| `/api/ext/xmp-material` | GET/POST | XMP 素材报表透传 `/v2/media/material_report/list`（20 QPM） |
| `/api/ext/xmp-fields` | GET/POST | XMP 可用指标自描述透传 `/v1/media/report/fields`（120 QPM） |

- XMP 透传：鉴权服务端注入（`buildXmpBody` 覆盖 client_id/timestamp/sign），本地限速护栏 `xmpExtRateOk`（滑动60s，按QPM上限，超返回429，防打爆共享配额）。通用 helper `xmpApiRequestPath(apiPath,body,headers)`。
- XMP 官方文档：https://help-xmp.mobvista.com/docs/open_api_desc
- 配套 skill：`skills/richang-daily-data`（打包为 `dashboard/public/downloads/richang-daily-data.skill`，个人面板有下载按钮）。明文写死 base url + 登录密码（拿到 skill 本就得知道密码）。
- 已下线旧 skill `personal-daily-report`（lark-cli 写飞书表那套）及其下载按钮。

#### XMP 消耗细化到 adset 广告组级（2026-07-03）

之前 XMP 消耗只到 campaign 级，个人面板的 adset（广告组）节点无消耗。现已细化到 adset 级：
- **抓取**：`fetchXmpCampaigns` 的 XMP dimension 加 `adset_name`，每行带 `adset` 字段（`backfill-xmp-cache.js` 同步）。个人面板调用带 `needAdset:true`；旧缓存缺 `adset` 字段时自动识别为 miss 并重新抓取（schema guard，避免旧缓存把匹配率钉死在 0%）。
- **归一化 join**：`normAdset()` 统一归一化 adset 名（去特殊符号/`+`→空格等），XMP 消耗按 operator→product→channel→campaign→adset 五级 key 注入到 AF/AD 已建的对应 adset 节点，对不上的落到该 campaign 的 `(unknown)` adset（不丢消耗）。
- **守恒 + 匹配率**：Σadset.cost == campaign.cost（一分不丢）；实测昨日匹配率 **95.9%**（具名 adset 消耗占比），unknown 主要是当天新开/零付费/PWA campaign。日志 `[XMP adset] <date>: rows matched=.. cost matched=$.. (..% matched)`。
- **单日 live + 快照生成两条路径都注入**（早期版本快照路径漏注入导致守恒崩，已修）。channel-summary 等只需 cost 的调用方 `needAdset:false`，继续用无 adset 的缓存不变。
- 前端 `_renderAdsetRows()` 展示 adset 消耗 + CPM/CPC/ROAS。

#### API 接口保护中间件 `api-guard.js`（2026-07-03）

防止外部 agent（或失控循环）用重接口/大范围查询打爆单线程 Node 事件循环。独立模块 `dashboard/api-guard.js`，`app.use(apiGuard)` 挂在静态资源与鉴权之后。三层护栏（仅对 HEAVY 重接口生效）：

| 护栏 | 默认阈值 | 触发 | env 覆盖 |
|------|---------|------|---------|
| 单请求日期跨度 | ≤ 14 天 | 429 拒绝 | `GUARD_MAX_RANGE_DAYS` |
| 每 IP 频率 | ≤ 30 / 60s | 429 + `Retry-After` | `GUARD_IP_RATE_PER_MIN` |
| 全局重接口并发 | ≤ 4 在飞 | 429（快速失败不排队） | `GUARD_MAX_CONCURRENT` |

- **HEAVY 接口**：`/api/postback/personal`、`/api/ext/records`、`/api/data`、`/api/af-summary`、`/api/channel-summary`、`/api/correction-factors`、`/api/revenue-by-install`、`/api/campaign-context`。轻接口（meta/xmp-fields 等）不受范围/并发闸限制。
- **真人浏览器豁免**：session 登录用户（`req.session.authenticated` 且非 `?key=`/Bearer）不受限流——只拦 M2M 机器取数，不影响人工看板浏览。
- **与 `xmpExtRateOk` 区别**：后者防的是 XMP 上游 QPM 配额；api-guard 防的是本机单线程被打爆。两者叠加。
- 实测：32 天跨度→429；35 连发→29×200+6×429 且服务全程健康不卡。
- 背景事故：2026-07-03 一个外部 agent（IP 203.118.53.30）持续发大范围 `postback/personal`（逐天遍历历史快照），单请求即占满事件循环把服务拖死。当时先用 iptables 临时拦该 IP 止血，上线 api-guard 后解封，实测其请求被 429 正常挡下、服务不再卡死。

---

## 数据来源凭据

| 来源 | 方式 | 凭据位置 |
|------|------|---------|
| 雅典娜 API（prod） | HTTP API（`admin-api-prod.sitin.ai`） | `fetcher.js` 硬编码 API Key |
| XMP (Dashboard) | HTTP API (`client_id` + `client_secret` + `md5(secret+timestamp)` 签名) | `server.js` 硬编码 `XMP_CLIENT_ID` / `XMP_CLIENT_SECRET` |
| AF/AD 回传 | 直接读 SQLite | 无需凭据 |
| LLM (SiliconFlow) | HTTPS API | `/etc/environment`: `SILICONFLOW_API_KEY` / `SILICONFLOW_BASE_URL` |

---

## XMP API 注意事项

**campaign 报表**（`POST /v2/media/account/report`）：dimension `campaign_name`, `product_name`；`product_name` 为 null 的记录直接丢弃。

**素材报表**（`POST /v2/media/material_report/list`）：metrics 用 `currency_cost`（不是 `cost`），需 `cost_currency: 'usd'`。

**通用**：
- 签名 = `md5(SECRET + timestamp)`，timestamp 30 秒有效
- metrics 字段名**单数**（`cost`/`impression`/`click`，不是复数）
- 限频 10 QPM（personal 和 summary 共享配额）
- campaign 缓存：三渠道都有消耗 → 30 分钟完整缓存；否则 5 分钟短缓存
- XMP 缓存**落盘**到 `data/xmp-cache/`，重启后直接复用
- `product_name` 为 `None` 是 TT PWA campaigns，无视即可

---

## 关键性能注意事项

⚠️ **CSS `backdrop-filter: blur()` 已全部移除**：在复杂 DOM（数百表格行）+ 集显场景下导致浏览器 GPU 过载卡死。用深色半透明背景替代。

⚠️ **JavaScript TDZ 陷阱**：`server.js` 顶层已有 `const fs = require('fs')`，handler 内部**不要**重新声明 `const fs`，否则顶层的 `fs.readFileSync()` 进入 Temporal Dead Zone 抛出 ReferenceError，被 catch 静默吞掉。

⚠️ **gzip 压缩**：`compression` 中间件已启用，API 响应体积降至原来 13%（267KB → 37KB）。

⚠️ **campaign 名称 trim**：XMP API 和 AF 回传的 `campaign_name` / `campaign` 可能带尾部空格。所有 campaign key 在使用前必须 `.trim()`，否则同一 campaign 会在面板中分成两行（XMP 一行 + AF/AD 一行）。已在 XMP 入口、AF key 构建、多日聚合 merge 三处统一处理。

⚠️ **重启不触发初始抓取**：启动时不调用 `fetchAll()` / `fetchPersonal()`，避免打满 XMP QPM。

⚠️ **SQLite 查询必须用范围条件，禁用 `date()` 函数做过滤**：大表（>50 万行）上 `date(event_time, '+8 hours') = ?` 单条查询 25+ 秒，多天循环会卡死 Node 事件循环。正确做法：北京时间日期转 UTC 范围 `[D-1 16:00, D 16:00)` 后用 `event_time >= ? AND event_time < ?`，配合 `(event_name, event_time)` 复合索引。AD 数据用 `CAST(event_time AS INTEGER)` 范围条件。多天查询用整个范围一条 SQL，不要逐天循环。（2026-06-10 教训：channel-summary API 因此崩溃，性能从崩溃优化到 <1s）

---

## 调度与手动操作

- 汇总面板：每小时整点自动 fetch（xx:00 汇总，xx:05 XMP 缓存预热）
- 手动操作：
  - 雅典娜：点击看板刷新按钮即可
  - XMP：`bash scripts/fetch-xmp-api.sh YYYY-MM-DD YYYY-MM-DD`
  - 素材：`node dashboard/fetch-creative-data.js YYYY-MM-DD`
  - AF：无需手动（DB 实时查询）

---

## 个人面板快照缓存策略

| 日期 | 快照类型 | 条件 | 响应时间 |
|------|---------|------|--------|
| ≥ 前天 | `complete` | 自动 | ~20ms |
| 昨天 | `partial` | 6点后 + 三渠道消耗各 > $100 | ~400ms |
| 今天 | 无快照 | — | ~1.5-2s |

- `partial` 不含跨天新用户收入，每次实时补查
- 昨天变前天时自动升级为 `complete`
- 快照目录：`data/personal-snapshots/`
- 快照保存校验：`responseHasReasonableCost()` 要求 FB/GG/TT 三渠道都有消耗数据
