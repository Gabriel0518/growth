# 任务：个人面板「收入来源图」功能（按 install_time 维度看老用户依赖度）

## 背景与目标
在 dashboard（端口 8081，代码目录 `/home/admin/.openclaw/workspace/dashboard/`）的**个人面板**中，
新增一个「收入来源图」功能：在每个 campaign 行现有的「✨AI」按钮旁边，再加一个「📈 收入来源」按钮。
点击后弹出一个折线图：
- **横坐标**：日期，从「当前查询日期」开始**向左/向右递减到过去**（即 X 轴从右到左是越来越早的 install 日期；最右是查询当天，向左日期递减）。
  - 用户原话："横坐标是日期，从当天开始，向右递减" → 即最右端=查询日期，越往右日期越小（越早）。请按"最右=查询日，往右方向日期递减"理解，实际实现为 X 轴从左到右日期递增、最右为查询日即可（与用户直觉一致：右端是今天，左端是更早）。**实现时 X 轴左→右 = 日期由早到晚，最右端为查询当天。**
- **纵坐标**：**install_time 落在该横坐标日期**的用户，其**全部付费金额总和**（不限 event_time，累加这些用户在整个观测期的付费）。
  - 即：按 install_time 分组，每个 install 日期一根纵向值 = 该 install 日期进来的用户贡献的总付费。
- **意义**：折线越往左（install 日期越早）还很高 → 该 campaign 越依赖老用户付费；越集中在右端（近期 install）→ 越依赖新用户。

## 四个层级都要支持
同样的「收入来源图」按钮/能力，要在四个聚合层级提供：
1. **campaign 层级**（每个 campaign 行，按钮加在 ✨AI 旁）—— 核心
2. **渠道层级**（channel 行）—— 累加该渠道下所有 campaign
3. **产品层级**（product 行）—— 累加该产品下所有渠道
4. **投手层级**（operator 行）—— 累加该投手下所有产品
   - 渠道/产品/投手层级只是在对应横坐标日期上把下层数据累加即可（install_time 维度求和）。

## 数据来源与口径（务必严格遵守）
- 数据库：`/home/admin/dataserver/data.db`，表 `records_YYYYMM`（月分表，需跨表 UNION）。
- 事件：`event_name IN ('af_purchase','ad_purchase')`。
- **时间字段格式**：
  - AF（`af_purchase`）：`event_time`/`install_time` 是 **ISO 文本（UTC）**，如 `2026-05-11 16:17:24.493`。
  - AD（`ad_purchase`）：`event_time`/`install_time` 是 **Unix 时间戳（秒，文本）**。
  - 统一转**北京时间（UTC+8）**判断"install 落在哪一天"。
- **install 日期分组**：按 `install_time` 的北京日期分组（`date(install_time, '+8 hours')` 概念，但**禁止用 date() 函数做大表过滤**，见性能注意）。
- 金额：原始 `revenue` 累加，**不套修正系数**（与用户需求一致，纯看 install 维度付费分布）。
- **维度过滤**：
  - campaign 层级：`app_id IN (该产品的app_ids) AND media_source 属于该渠道 AND campaign = 指定campaign`
  - 渠道层级：去掉 campaign 过滤
  - 产品层级：去掉渠道过滤
  - 投手层级：用 `matchOperator(campaign)` 匹配（见下），聚合该投手所有 campaign

## 现有代码关键位置（已为你定位）
- `server.js`：
  - `APP_ID_MAP`（产品↔app_id，含 AF/AD 两种形态）约第 209 行
  - `IOS_AD_APP_IDS`、`ANDROID_APP_IDS`、`IOS_AF_APP_IDS` 约第 393-411 行
  - `mapMediaSource()` 渠道分类函数（FB/GG/TT，organic/restricted/Unattributed 归类）
  - `matchOperator(campaign)` 投手匹配，约第 1144 行；`OPERATOR_CODES`（12投手）第 1131 行
  - `/api/campaign-context` 现有 AI 数据接口，可参考其参数风格（campaign/product/channel/operator/date）
  - 现有 ELTV_PRODUCTS（产品→af/ad app_ids + Romi iOS/Luma 特殊渠道规则）约第 672 行——**install 维度查询时产品→app_id 映射可复用此规则**
- `public/app.js`：
  - `_renderCampaignRows(op, prodName, chName)` 第 1655 行，AI 按钮在第 1682 行（`<button class="ai-advice-btn" ...onclick="...openAiAdvice(this)">✨AI</button>`）
  - `aiBtnData` 的 data 属性结构（data-camp/data-prod/data-ch/data-op）第 1680 行
  - `openAiAdvice(btn)` 第 1772 行，可参考其弹层 overlay 实现模式
  - 渠道行/产品行/投手行的渲染函数（找 `_renderChannelRows`/产品/operator 对应渲染处，给这些行也加按钮）

## 需要新增
### 后端
- 新 API：`GET /api/revenue-by-install?level=campaign|channel|product|operator&campaign=&product=&channel=&operator=&date=&days=`
  - 返回该维度下，按 install 北京日期分组的付费总和数组：`[{date:'2026-05-10', revenue: 1234.5}, ...]`
  - `date` = 查询当天（X 轴最右端）；`days` = 回看天数（默认比如 60 天，X 轴左端到 date-days）。
  - **性能铁律**（务必遵守，否则会卡死 Node 事件循环）：
    - 禁止用 `date(event_time,'+8 hours')=?` 做大表过滤。
    - 用北京日期→UTC 范围条件 `install_time >= ? AND install_time < ?`，配合现有索引 `(event_name, install_time)` / `(event_name, app_id, install_time)`。
    - AD 数据用 `CAST(install_time AS INTEGER)` 范围条件。
    - 一条 SQL 查整个 install 日期范围，按 `date(install_time,'+8 hours')` 只在 **GROUP BY 的 SELECT 投影里**用（不在 WHERE 过滤），或在 JS 里分桶。
    - 跨月表用 UNION ALL。
  - 复用 `authCheck` 中间件。
### 前端
- 在 campaign/channel/product/operator 四类行的名称处，各加一个「📈」按钮（campaign 行加在 ✨AI 旁）。
- 点击 → 调用新 API → 用图表库画折线图，弹层 overlay（**复用现有 AI 弹层的样式模式**，深色半透明背景，ESC/点遮罩关闭）。
- 图表库：看 `public/` 现有是否已引入 chart 库（如 Chart.js）。若没有，优先用轻量内联 SVG 折线绘制或已有依赖，**不要随意引入大体积 CDN 依赖**（dashboard 有 GPU/性能敏感历史，见下）。先 grep 现有有没有图表库。

## 重要约束与坑（dashboard 历史教训，必须遵守）
- ⚠️ **禁止 `backdrop-filter: blur()`**（复杂 DOM 下 GPU 卡死，已全移除）。弹层用深色半透明背景。
- ⚠️ **server.js 顶层已有 `const fs = require('fs')`**，handler 内不要重复声明 `const fs`（TDZ 陷阱）。
- ⚠️ **campaign 名称尾部空格**：所有 campaign key 用前必须 `.trim()`。
- ⚠️ **日期+1 天禁止用 `new Date().toISOString()`**（UTC 偏移翻倍 bug），用纯字符串/数字算。
- ⚠️ **SQLite 大表查询必须范围条件 + 索引**，禁 `date()` 过滤（见上）。
- ⚠️ 改完**不要自动重启生产服务**，先本地 node 语法检查 + 小范围验证，最后告诉龙虾，由龙虾确认后再决定重启 `sitin-dashboard.service`。
- ⚠️ **不要碰配置文件**，不要动 systemd/caddy 配置。

## 验证
- 后端：用 curl 登录拿 cookie（`admin` / `<DASHBOARD_ADMIN_PASS>`），调 `/api/revenue-by-install` 各 level 验证返回结构和数值合理。
- 前端：检查按钮渲染、点击弹层、折线图 X/Y 轴正确（最右=查询日，Y=该install日付费总和）。
- 用一个已知 campaign（如 Doni 的某 FB campaign）人工核对几个 install 日期的金额是否与直接 SQL 一致。

## 交付
- 改动文件清单 + 关键实现说明。
- 验证结果（curl 输出样例 + 截图或 DOM 验证说明）。
- **不要自行 git commit/push，不要重启生产服务**，完成后报告给龙虾，由龙虾通知屹恒确认。
- 遇到任何拿不准的口径/设计问题，停下来在报告里列出问题，不要擅自臆断。

## 图表库已确认（重要）
- 前端已引入 **Chart.js 4.4.1**（`index.html` 有 CDN script）。
- 个人面板已有用法可参考：`app.js` 里的 `personalTrendChart = new Chart(ctx, {...})` 和 `trendChart`。
- **直接复用 Chart.js 画折线图，不要引入新图表库。** 弹层里放一个 `<canvas>`，用 Chart.js line 类型。
