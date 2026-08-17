# 实时投放数据推送 — 雅典娜数据抓取文档

## 概述

通过 cron 定时任务，自动从公司内部数据平台「雅典娜」（admin.sitin.ai）抓取各产品的投放收入数据，整理后推送至飞书，并同步写入飞书电子表格。

## 雅典娜平台

- **地址**：https://admin.sitin.ai
- **数据页面**：https://admin.sitin.ai/data-analysis
- **认证方式**：账号密码登录（凭证存储在服务器 `/etc/environment` 的 `DASHBOARD_USER` 和 `DASHBOARD_PASS` 中）

### 页面结构

登录后进入 Data Analysis 页面：

- **左侧边栏**：产品列表菜单，点击切换不同产品
- **顶部**：日期范围选择器 + Search 按钮
- **主区域**：用户增长图表 + Paying Users 数据卡片

### Paying Users 数据卡片

每个产品页面底部有 4 个卡片：

| 卡片 | 说明 | 我们关注的字段 |
|------|------|----------------|
| **Overall** | 总体付费数据 | ✅ `Total:` = 当日总收入 |
| Subscriptions | 订阅收入 | - |
| Coins | 金币收入 | - |
| **New Users** | 新用户付费数据 | ✅ `Total:` = 新用户收入 |

### 日期选择器

- 格式：`YYYY-MM-DD → YYYY-MM-DD`
- ⚠️ **日期范围是前后都包含的（inclusive）**
- 查询单天数据时，起止日期必须填**同一天**
  - ✅ 正确：`2026-03-24 → 2026-03-24`（仅 3月24日）
  - ❌ 错误：`2026-03-24 → 2026-03-25`（会查两天累计）

### 产品列表

雅典娜上共 8 个需要抓取的产品，部分产品对外名称不同：

| 雅典娜名称 | 对外名称 | 说明 |
|-----------|---------|------|
| GraceChat | GraceChat | 一致 |
| Dora | **Dora iOS** | 加 iOS 后缀 |
| Dora And | Dora And | 一致 |
| Luma | Luma | 一致 |
| Doni | Doni | 一致 |
| Romi | **Romi iOS** | 加 iOS 后缀 |
| Romi And | Romi And | 一致 |
| Jovia And | Jovia And | 一致 |

## 技术实现

### 数据抓取流程

使用 **Playwright**（无头 Chromium 浏览器）自动化操作雅典娜网页：

```
启动无头浏览器
  → 打开 admin.sitin.ai
  → 账号密码登录
  → 进入 /data-analysis 页面
  → [如有日期参数] 修改日期范围 + 点击 Search
  → 逐个点击左侧 8 个产品
  → 每个产品页面提取 Overall Total 和 New Users Total
  → 输出 JSON 结果
  → 关闭浏览器
```

**不是截图识别（OCR）**，而是直接从网页 DOM 元素中提取文本内容，精度高、速度快。

### 关键脚本

| 文件 | 用途 |
|------|------|
| `scripts/sitin-dashboard.js` | 核心脚本，Playwright 自动化登录+抓取数据 |
| `scripts/fetch-revenue.sh` | Shell 包装器，加载环境变量并调用 JS 脚本 |
| `scripts/write-sheet.js` | 将数据写入飞书电子表格 |
| `scripts/write-sheet.sh` | Shell 包装器，调用写表格 JS 脚本 |

### 调用方式

```bash
# 抓取今天的实时数据（默认）
bash scripts/fetch-revenue.sh

# 抓取指定日期的数据（注意：单天查询起止填同一天）
bash scripts/fetch-revenue.sh 2026-03-24 2026-03-24

# 写入飞书表格
node scripts/write-sheet.js '<json_data>' '3月25日 16:00'
```

### 数据提取逻辑（sitin-dashboard.js）

对每个产品页面，通过 `page.evaluate()` 在浏览器内执行 JS：

1. 遍历页面所有 `div/span/p` 元素
2. 找到以 `Overall` 开头、包含 `Total:` 和 `Payments:` 的元素 → 提取总收入
3. 找到以 `New Users` 开头、包含 `Total:` 的元素 → 提取新用户收入
4. 用正则 `/Total:\s*\$?([\d,]+\.?\d*)/` 匹配金额

### 飞书表格写入逻辑（write-sheet.js）

1. 读取当前第 2 行（上一次的最新数据）
2. 在第 2 行位置插入 2 行空行（已有数据全部下推）
3. 第 2 行写入新数据
4. 第 3 行写入新数据与上一次数据的增量差值（格式：`+$1,234.56`）

表格结构始终保持：
```
Row 1: 表头
Row 2: 最新数据
Row 3: 增量（最新 - 上一次）
Row 4: 上一次数据
Row 5: 增量（上一次 - 上上次）
Row 6: 上上次数据
...
```

## Cron 定时任务

### 时间表

| 时间 | 数据范围 | 时间标签示例 |
|------|---------|-------------|
| 0:05 | 前一天全天 | 3月25日 全天 |
| 4:00 | 当天实时 | 3月26日 4:00 |
| 8:00 | 当天实时 | 3月26日 8:00 |
| 10:00 | 当天实时 | 3月26日 10:00 |
| 12:00 | 当天实时 | 3月26日 12:00 |
| 14:00 | 当天实时 | 3月26日 14:00 |
| 16:00 | 当天实时 | 3月26日 16:00 |
| 19:00 | 当天实时 | 3月26日 19:00 |
| 22:00 | 当天实时 | 3月26日 22:00 |

Cron 表达式：`5 0,4,8,10,12,14,16,19,22 * * *`（Asia/Shanghai）

### 每次执行的完整流程

```
Cron 触发
  → 启动独立 agent session
  → 判断当前时间是否为 0:05
    → 是：运行 fetch-revenue.sh YYYY-MM-DD YYYY-MM-DD（前一天日期）
    → 否：运行 fetch-revenue.sh（无参数，默认今天）
  → 获取 JSON 数据
  → 运行 write-sheet.js 写入飞书表格
  → 整理数据表格，推送飞书消息给屹恒
```

### 超时与容错

- 执行超时：**600 秒**（10 分钟），应对凌晨网络慢的情况
- 推送模式：`best-effort-deliver`，推送失败不会把整个任务标为 error

## 飞书表格

- **表格名称**：🍍🦞专用 实时投放数据推送表格
- **Wiki 链接**：https://presence.feishu.cn/wiki/BR9xwwwmCi2bWekTpZOcGFDOn6e
- **Sheet Token**：`TVBxsh8kGhHqEBtgeI5c4x5On3V`
- **Sheet ID**：`7a7858`

### 列结构（A-S，共 19 列）

| 列 | 内容 |
|----|------|
| A | 时间 |
| B-C | GraceChat 总收入 / 新用户 |
| D-E | Dora And 总收入 / 新用户 |
| F-G | Dora iOS 总收入 / 新用户 |
| H-I | Doni 总收入 / 新用户 |
| J-K | Romi iOS 总收入 / 新用户 |
| L-M | Luma 总收入 / 新用户 |
| N-O | Jovia And 总收入 / 新用户 |
| P-Q | Romi And 总收入 / 新用户 |
| R-S | 总收入汇总 / 新用户汇总 |

## 潜在风险

1. **雅典娜前端改版**：如果页面结构变动（CSS 类名、元素层级），DOM 选择器可能失效，需要更新 `sitin-dashboard.js`
2. **凭证过期**：如果 Dashboard 密码修改，需更新 `/etc/environment` 中的 `DASHBOARD_PASS`
3. **网络超时**：凌晨 4:00 曾出现过超时，已将超时设为 10 分钟缓解
