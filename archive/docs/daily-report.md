# 日报数据自动填写

> 专家文档：飞书日报数据自动采集与填写。从 SERVER_OVERVIEW.md 拆分。
>
> 创建日期：2026-06-04

---

## 概述

自动采集多个数据源，写入飞书电子表格，供屹恒检验后复制到正式日报。

- **飞书表格**：[日报数据](https://presence.feishu.cn/sheets/KlXHsPavJhpcbOtiZYecbOYun3b)
- **spreadsheet_token**：`KlXHsPavJhpcbOtiZYecbOYun3b`
- **sheet_id**：`2c762a`
- **创建方式**：bot 身份创建，已授予屹恒 `full_access`
- **计划调度**：每天 08:30 CST 执行（cron，已设置）

## 表格布局

每个产品占 4 行：第 1 行产品名，第 2-4 行为昨天/前天/大前天的数据。产品之间空 1 行。

### 产品顺序（11+1 个）

1. GraceChat
2. Dora iOS
3. Dora And
4. Doni
5. Romi iOS
6. Luma
7. Jovia And
8. Romi And
9. Kira And
10. Kira iOS
11. Nalo And
12. **PWA**（特殊产品，数据来源不同）

### 列定义（普通产品）

| 列 | 内容 | 数据来源 |
|----|------|---------|
| A | 产品名 / 日期（格式 `2026/6/3`） | — |
| B | （空，公式列） | — |
| C | XMP 总消耗 | XMP Open API（summary 模式） |
| D | AF 注册数 | SQLite `af_complete_registration` |
| E | （空，公式列） | — |
| F | 雅典娜总收入 | 雅典娜 API |
| G | （空，公式列） | — |
| H | TT 渠道返点（TT 消耗 × 0.025） | XMP Open API（tiktok 渠道） |
| I-M | （空，公式列） | — |
| N | 总付费人数 | 雅典娜 API `totalPayingUsers` |
| O | 总付费订单数 | 雅典娜 API `totalPayments` |
| P-R | （空，公式列） | — |
| S | 新用户付费总金额 | 雅典娜 API `newUserRevenue` |
| T | （空，公式列） | — |
| U | 新用户付费人数 | 雅典娜 API `newUserPayingUsers` |

### 列定义（PWA 产品）

| 列 | 内容 | 数据来源 |
|----|------|---------|
| A | PWA / 日期 | — |
| B | XMP 消耗（product=null 的汇总） | XMP Open API，`product_name` 为空的行 |
| C | 女生注册人数 | **BytePlus DataFinder**（app `653834`，事件 `pwa_conv_cash_ready_pop_show` 的 `event_users`，昨天/北京/全体用户） |
| F | （空，雅典娜无 PWA 数据） | — |
| R-AB | 各产品日活数据 | Multi-App Data Center |

> **C 列历史**：2026-07-03 之前固定填 5；之后改为 BytePlus 实时取数（见下「BytePlus PWA 女生注册人数」小节）。

### 日活列（R-AB，在 PWA 行中）

| 列 | 产品 | 数据来源平台 |
|----|------|-------------|
| R | GraceChat | iOS |
| S | Dora And | Android |
| T | Dora iOS | iOS |
| U | Doni | Android |
| V | Romi iOS | iOS |
| W | Luma | iOS |
| X | Jovia And | Android |
| Y | Romi And | Android |
| Z | Kira iOS | iOS |
| AA | Kira And | Android |
| AB | Nalo And | 不在网站上，填 0 |

## 数据来源

### 1. 雅典娜 API（收入数据）

- 接口：`GET https://admin-api-prod.sitin.ai/api/open/admin/revenue?date=YYYY-MM-DD`
- 认证：`Authorization: Bearer <ATHENA_API_KEY>`
- 限频：60 QPM（查 3 天 = 3 次请求，无压力）
- 产品名映射：见 `docs/ad-platform-apis.md`
- 返回字段：`totalRevenue`, `totalPayingUsers`, `totalPayments`, `newUserRevenue`, `newUserPayingUsers`

### 2. XMP Open API（消耗数据）

- 接口：`POST https://xmp-open.mobvista.com/v2/media/account/report`
- 限频：**10 QPM**（最关键瓶颈）
- 查询方式：
  - 总消耗（summary）：3 渠道 × 1 天 = 3 次请求
  - TT 渠道单独查（H 列返点）：1 次请求 / 天
  - 3 天合计：(3+1) × 3 = 12 次请求
- **QPM 策略**：每天的请求间隔 ≥ 65 秒，避免撞 QPM
- **与 dashboard 的时间错开**：
  - Dashboard 在整点（xx:00）和整点+5 分钟各占 3 QPM
  - 日报在 08:30 执行，与 08:00/08:05 的 dashboard 请求不冲突
  - 但如果有人同时打开 dashboard 个人面板会触发额外 XMP 请求
- PWA 消耗 = XMP 返回中 `product_name` 为 `null` / 空值的行汇总（TT PWA campaigns）
- 产品名映射：见 `TOOLS.md` 和 `scripts/fetch-xmp-api.js`

### 3. AF SQLite 数据库（注册数）

- 数据库：`/home/admin/dataserver/data.db`
- 表：`records_YYYYMM`（按月分表）
- 查询：`event_name = 'af_complete_registration'`，按 `DATE(datetime(event_time, '+8 hours'))` 和 `app_id` 分组
- 无限频问题（本地查询）
- 跨月需查两张表（如 5/31 在 `records_202605`，6/1 在 `records_202606`）
- **未接入 af_complete_registration 的产品**：Jovia And（com.qiga.vio）基本无数据；Romi And 和 Kira iOS 可能因无广告投入而无注册

### 4b. BytePlus DataFinder（PWA 女生注册人数，C 列）

- **接口**：`POST https://analytics.byteplusapi.com/datafinder/openapi/v1/analysis`
- **app_id**：`653834`（PWA 产品，独立于 Doni 的 `812405`）
- **事件**：`pwa_conv_cash_ready_pop_show`
- **指标**：`event_users`（触发人数/去重），全体用户（无 `profile_filters`）
- **取数逻辑**：`period` 用 `type:'last'` 取近 N 天（N=今天回退到最早目标日期的天数），返回后按 `date_index_list`（YYYYMMDD）映射回每天，取对应日期值
- **凭据**：`/etc/environment` 的 `BYTEPLUS_DATAFINDER_AK/SK`（与 Doni 同一套 AK/SK）
- **失败降级**：缺密钥/查询失败/无数据时该日 C 列**留空**（不阻断日报其余部分），控制台打 warning
- **踩坑**：指标是 `event_users`（人数）不是 `pv`（次数）；签名细节见 `docs/byteplus-datafinder.md` 第12节
- 参考实现：`scripts/byteplus-df-query.js`（探索/验证用）；生产写入在 `scripts/daily-report-sheet.js` 的 `fetchPwaRegistrations()`

### 4. Multi-App Data Center（日活数据）

- 地址：`http://62.234.39.191:8765/`
- API：`POST /api/cached-data`，body `{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}`
- **认证（2026-06-15 新增）**：先 `POST /api/login`（body `{"username":"admin","password":"0123210"}`），获取 `auth` cookie（有效期 2 个月），后续请求带 Cookie header
- 无限频
- **⚠️ 时区转换**：网站日期是美西时间（PST/PDT），查北京时间某天的日活需要将日期 **-1 天**
  - 例：表格中 6/3 的日活 → 网站查 6/2
- 返回结构：`data.ios.overview.{AppName}.dau.all.value` 和 `data.android.overview.{AppName}.dau.all.value`
- iOS 产品：Dora, Romi, Luma, Kira, Vika, Gracechat
- Android 产品：Dora, Romi, Doni, Jovia, Kira
- **Nalo And 不在网站上**，日活填 0
- **Vika** 目前日活为 0（已下架或未上线）

### 5. 飞书 Open API（写入表格）

- 认证：`tenant_access_token`（bot 身份，通过 `app_id` + `app_secret` 获取）
- 写入方式：`PUT /sheets/v2/spreadsheets/{token}/values`，body 含 `valueRange.range` 和 `valueRange.values`
- **注意**：必须用 PUT 方法，POST 会 404
- **注意**：request body 必须带 `Content-Length` header

## 脚本

| 脚本 | 用途 |
|------|------|
| `scripts/daily-report-sheet.js` | 每日执行脚本（cron 08:30 自动执行，含 PWA + 日活） |
| `scripts/sync-daily-report-to-wiki.js` | 源表「日报数据」→「日报数据汇总」(wiki) 同步（cron 08:40，插行补昨天 + 跨表公式 + 全产品汇总插行 + 产品分表空白填0） |

## 日报数据汇总(wiki) 同步

源表（`KlXHsPavJhpcbOtiZYecbOYun3b`，单 sheet 全产品纵向堆叠）每天 08:30 写入后，08:40 自动同步到「日报数据汇总」 wiki 表（`LPn7shI4Kh0jeOtvyP0cd6ffnmf`，一产品一 sheet，含 PWA）。

- **逻辑**：逐 sheet 读第2行日期——==昨天跳过 / ==前天插行补昨天 / 其它报警告不自动处理。**PWA 必须先 insert**（产品表有跨表引用 `'PWA'!`）。
- **PWA 配置必须带 `product: 'PWA'`**（否则 `findSrcRow` 拿不到源数据，值列全空）。

### ⚠️ 三个必须记住的飞书表坑
1. **写公式要用单元格对象 `{type:'formula', text:'=...'}`**。直接写 `"=..."` 字符串会被 `/values` PUT API 当**纯文本**存（页面上显示为公式文本，需点编辑回车才生效）；`values_batch_update` 同样无效。
2. **插行 `inheritStyle` 用 `'AFTER'`**（继承插入点之后的数据行格式），不要用 `'BEFORE'`（那会继承第1行表头格式）。
3. **`insert_dimension_range` 只插空行，不复制相邻行公式**，公式必须显式写；本表相对引用会随 insert 自动平移，PWA insert 时飞书会自动把所有产品表对 PWA 的跨表引用行号 +1（无须手动修复）。

### 🚫 绝不做的事
- **绝不用 delete+insert 改单行数据**。删行+重插在真实多公式表上会吃掉表头、打乱行序（已出过事故）。修单行只用 `writeRange` 覆盖该行值。
- 飞书**自动编辑历史 API 取不到**（只有手动命名版本），出事只能让用户在网页版「查看历史版本」回退。

### 关于 `#VALUE!`（正常现象）
汇总表出现的 `#VALUE!` 几乎都是**源数据为空**导致，与手填结果一致，不是同步 bug：
- **PWA `E2/F2`（主播成本/PWA提现成本）源表没有**（这两列是人工/外部填，非日报源表）→ 影响所有产品表引用它们的 `I2/K2`。
- **已停投产品的花费(C)/注册(D) 源表为空**（Dora iOS 的 C、Romi And/Kira iOS 的 C+D，见下「数据缺失说明」）→ `E2=C2/D2` 等 `#VALUE!`，源表补数后自动消失。

## 数据缺失说明

以下产品在某些数据源中无数据，属于正常情况：

| 产品 | XMP 消耗 | AF 注册 | 说明 |
|------|---------|---------|------|
| Dora iOS | ❌ | ✅ | 已停投广告 |
| Dora And | ❌ | ✅ | 已停投广告 |
| Romi And | ❌ | ⚠️ 极少 | 已停投广告 |
| Kira iOS | ❌ | ⚠️ 极少 | 已停投广告，有埋点但无下载量 |
| Jovia And | ✅ | ⚠️ 极少 | 未接入 af_complete_registration 埋点 |
