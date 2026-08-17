# 调度与定时任务

> 专家文档：UG 早报、定时抓取、cron 任务。从 SERVER_OVERVIEW.md 拆分。
>
> 最近更新：2026-06-05

---

## 每日调度时间线

| 时间 | 任务 | 脚本 | 调度方式 |
|------|------|------|----------|
| 00:05 | fetcher 抓前一天完整数据 | `dashboard/fetcher.js` (hour=0) | dashboard 内置 scheduler |
| **05:30** | **数据补全检查** | `dashboard/backfill-check.js` | cron |
| 06:00 | UG 早报生成并推送 | `scripts/send-ug-report.sh` | cron + OpenClaw cron |
| 08:10 | AF/AD 付费金额写入「投放日报模板」（新版手动输入数据sheet） | `scripts/daily-af-ad-input.js` | cron |
| 08:30 | 飞书日报表格写入 | `scripts/daily-report-sheet.js` | cron |
| 08:40 | 日报数据 → 日报数据汇总(wiki) 同步（含全产品汇总插行 + 产品分表空白填0） | `scripts/sync-daily-report-to-wiki.js` | cron |
| **08:50** | **苏屹恒个人日报全链路**（填模板 → 补20分表 → 同步汇总） | `scripts/personal-daily.sh` | cron |
| **14:30** | **投手日报（文字+图表+@未填投手）** | `scripts/send-operator-report-v2.sh` | cron |
| **17:00** | **投手日报二次检查（@仍未填 / 全部完成撒花）** | `scripts/send-operator-report-check.sh` | cron |
| xx:00 | 每小时实时数据快照 | `dashboard/fetcher.js` | dashboard 内置 scheduler |
| xx:05 | XMP campaign 缓存预热 | `dashboard/server.js` | dashboard 内置 scheduler |

---

## 数据补全检查（Backfill Check）

每天 05:30 执行，在 UG 早报前 30 分钟检查前 3 天数据完整性。

### 检查逻辑

- 检查前 3 天的 **midnight snapshot**（00:05 抓取的前一天全天数据）
- 若雅典娜总收入 = 0 或 XMP 总消耗 = 0，则重新拓取
- 不检查小时级快照数据（小时数据缺失不影响全天总量）
- 失败后 5 分钟 fallback 重试一次，再失败放弃

### 脚本

- `dashboard/backfill-check.js`（自包含，不依赖 dashboard 服务运行）
- 日志：`output/backfill-check.log`

### 手动触发

```bash
node dashboard/backfill-check.js
```

---

## 投手日报

每天 **14:30** 自动生成并推送到飞书「投放UG」群（`oc_6518b783dd17e543f84d1636ee380598`）。

### 主报告（14:30）

- 脚本：`scripts/send-operator-report-v2.sh` → `scripts/operator-report-v2.js`
- 内容：昨日各投手文字汇总 + 收入折线图 + 利润率折线图
- 数据源：飞书表格「投手排行榜」Data 表（`QF2UsntX6hCRwwtqTXlc4GQsnFd` / `YiWQtE`）
- **@未填数据投手**：判定规则 `消耗=0 && 收入=0 && 利润=0`
- 发送失败重试：间隔 1 分钟，最多重试 2 次（`SEND_MAX_RETRIES=2`）
- 仅工作日运行（含 2026 节假日 + 调休日历）
- 日志：`output/operator-report-v2-cron.log`

### 二次检查（17:00）

下午 5 点对未填投手做一次 double check：

- 脚本：`scripts/send-operator-report-check.sh` → `scripts/operator-report-check.js`
- 复用主报告的数据源与「无数据」判定逻辑，但**不重新生成文字/图表**
- **仍有投手未填** → 在群里再次 @ 提醒（消息头 `⏰ 投手日报二次检查`）
- **全部填完** → 发送 `🎉 投手日报全部完成 [撒花][撒花]`
- 同样仅工作日运行、同样的发送重试逻辑
- 日志：`output/operator-report-check-cron.log`
- 手动触发：`bash scripts/send-operator-report-check.sh`

---

## UG 早报

每天早上 06:00 自动生成并推送到飞书「UG早报」群（`oc_07e9c151b9b8bc8c1b4090f6880d7dcd`）。

### 脚本

| 脚本 | 作用 |
|------|------|
| `scripts/gen-ug-report.py` | 生成早报文本（查询雅典娜缓存 + XMP 缓存 + SQLite AF 数据 + eLTV API） |
| `scripts/send-ug-report.sh` | 调用 gen-ug-report.py 生成报告，通过 lark-cli bot 身份发送到飞书群 |
| `scripts/compute-eltv-trend.js` | eLTV D180 趋势分析辅助脚本（独立运行，非早报流程必需） |

### 早报内容

1. **营收**（雅典娜口径）：各产品昨日收入 / 7 日均值
2. **消耗**（XMP 口径）：各产品昨日消耗 / 7 日均值
3. **CPI**：XMP 消耗 ÷ af_complete_registration，昨日 / 7 日均值
4. **eLTV 收入**：AF 新用户收入 × D180 倍数，昨日 / 7 日均值

### 数据口径要点

- **新用户收入仅使用 AF 回传数据**（event_name=`af_purchase`），不合并 AD。原因：AF 和 AD 均包含全量应用内事件，只是归因不同，合并会重复计算
- eLTV D180 倍数从 `/api/eltv-multipliers` 接口获取（需先登录 dashboard），不可靠的产品自动排除（D1 跨度 ≤ 10 天或数据量 ≤ 1000 条）
- CPI 分母 `af_complete_registration` 含全渠道注册（含自然量），部分安卓产品未接入该埋点

### 调度

- **OpenClaw cron 任务**：`ug-morning-report`
- 调度：`0 6 * * *`（Asia/Shanghai），每天 06:00 精时执行
- 运行方式：隔离 session，使用 exec 工具执行 send-ug-report.sh
- 超时：120 秒
- 日志：`output/ug-report-YYYY-MM-DD.log`

### 手动触发

```bash
# 仅生成（不发送）
python3 scripts/gen-ug-report.py --date 2026-05-20

# 生成并发送
bash scripts/send-ug-report.sh

# 指定日期生成
python3 scripts/gen-ug-report.py --date 2026-05-19
```

### 飞书群信息

- 群名：UG早报
- chat_id：`oc_07e9c151b9b8bc8c1b4090f6880d7dcd`
- 成员：屹恒（`ou_b2467dac5ff1d686fb48ccf1fbaa0c0d`）、Max Zhou（`ou_8088cd31cd5ac1f882da6da0f48f5754`）
- 发送身份：bot（`lark-cli --as bot`）
- Bot 是群管理员（创建时设置 `--set-bot-manager`）

---

## 苏屹恒个人日报全链路（08:50）

每天 **08:50** 自动把苏屹恒个人投放数据从模板填好并联动到分表+汇总，幂等可重跑。

### 包装脚本

- `scripts/personal-daily.sh`：顺序跑 3 步，任一步失败立即停止后续 + 飞书私信通知屹恒（`scripts/feishu-notify.js`，bot 身份发给 `ou_b2467dac5ff1d686fb48ccf1fbaa0c0d`）。
- 日志：`output/personal-daily.log`
- crontab：`50 8 * * * cd /home/admin/.openclaw/workspace && bash scripts/personal-daily.sh >> output/personal-daily.log 2>&1`

### 三步链路（后步依赖前步产物）

1. **填模板** `scripts/fill-personal-daily-report.js`
   - 数据源：dashboard 个人面板 `/api/postback/personal`（按投手 syh 过滤）
   - 目标：「投放日报模板」(`N1FcsGvXThXu97t7ZYyccCHDnIg` / sheet `TAVpj9` 苏屹恒模版)
   - 只写 C(消耗)/D(男生人数=`af_complete_registration` campaign installs 求和)/F(原始收入=未修正 revenue)，刷新最近 3 天；绝不动 A(日期公式)/B(渠道)/E(CPI公式)/G+
2. **补分表** `scripts/backfill-personal-report-subtabs.js`
   - 模板 → 「苏屹恒投放日报」(`V7nysbQd3huZvStpd6Tcv7HUnJc`) 的 20 个产品×渠道分表
   - 每个分表读 row2 日期，与今天差 ≤4 天才补（>4 跳过），补到昨天，新日期在顶部
   - **插行用 `--inherit-style before`**（在 row2 前插空行，老行下移保留），数据写到新空行，**不覆盖老行**
   - 写**数字+货币/百分比格式**（不写纯文本，否则汇总 SUM 报 #VALUE!）
3. **同步汇总** `scripts/sync-personal-summary.js`
   - 「苏屹恒汇总」(sheet `jv5kT4`) 顶部 insert(before) 补到昨天，重写新行公式（汇总 row R ↔ 分表 row R，复用 row2 模板公式 retarget 行号）
   - 幂等：row2 已是昨天则跳过；row2 含 #REF 则中止报警；gap>4 中止
   - retarget 行号正则需先 mask 分表名 `'Romi iOS FB（W2A）'` 里的 `W2A`（含数字 2，否则被改成 W3A/W4A → #REF）

### 关键历史 bug（已修）

- backfill 原用 `--inherit-style after`（row2 后插行）+ 写数据到 row2 → **覆盖老行**，每天丢一行历史数据。改 `before` 后已端到端回归验证（删行模拟「昨天缺失」→ 补回当天且历史行零丢失）。
- backfill「粘贴为文本」会让汇总 SUM 报 #VALUE!（汇总引用分表 C/G/H/I/J/K）→ 改为写数字+格式。
- 两个子汇总表（苏屹恒汇总FB+TT / 苏屹恒汇总Google）已弃用，不维护。

### 手动触发

```bash
bash scripts/personal-daily.sh
# 或单步 dry-run：
node scripts/backfill-personal-report-subtabs.js --dry-run
node scripts/sync-personal-summary.js --dry-run
```
