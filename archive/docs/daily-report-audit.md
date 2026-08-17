# 日报核查（Daily Report Audit）

> 自动对比飞书投放日报表格与 Dashboard 个人面板数据，输出绝对差异柱状图、折线图和热力图。

## 用途

当用户提供飞书日报链接和投手姓名时，按照本文档流程执行数据对比核查，输出可视化图表和关键发现。

## 触发条件

用户说类似「查一下XXX的日报数据」「对比一下这个表格和Dashboard」「核查日报」时，且给出了飞书表格链接和投手名字。

## 输入要求

| 参数 | 说明 | 示例 |
|------|------|------|
| 飞书表格链接 | wiki URL 或 spreadsheet URL | `https://presence.feishu.cn/wiki/IERKwXqK0i7hY7kE1i0c12fKnwe` |
| 投手姓名 | Dashboard 中的 operator code | `syh`（苏屹恒） |
| 日期范围 | 可选，默认本月1号至昨天 | `6/1~6/14` |

## 完整流程

### Step 1: 解析飞书表格

1. 从 wiki URL 提取 token，用 `lark-cli wiki spaces get_node` 获取 `obj_token`（spreadsheet token）
2. 用 `lark-cli sheets +workbook-info` 获取所有 sheet 列表
3. 排除汇总 sheet（名称含「汇总」），其余 sheet 按命名规则解析为 `产品×渠道`
4. **Sheet 命名 → 产品映射规则：**
   - 最后一个空格后的部分 = 渠道（TT / FB / GG）
   - 前面部分 = 产品名，需映射到 Dashboard 标准名
   - 常见映射：`GC iOS` / `GC` → `GraceChat`，`Luma iOS` → `Luma`，`Doni And` → `Doni`
   - 跳过含 `W2A` 的 sheet（Dashboard 独立统计）
5. 每个有效 sheet 用 `lark-cli sheets +csv-get --range A:G` 读取数据
6. 提取列：**A列日期、C列消耗、F列原始收入、G列修正收入**
7. 日期格式解析：支持 `2026/6/14` 和 `2026-06-14`
8. 金额解析：`$1,234.56` → `1234.56`，`#DIV/0!` / `#REF!` → `0`
9. 调用间隔 ≥ 300ms，避免飞书 API 限频

### Step 2: 获取 Dashboard 数据

1. **登录**：`POST /login`（form: username + password），保存 session cookie
   - 用户名：`admin`，密码：`<DASHBOARD_ADMIN_PASS>`
2. **逐日获取个人面板数据**：`GET /api/postback/personal?date={date}&operator={code}`
   - 从 `operators` 数组中找到 `operator === {code}` 的投手
   - 遍历 `products → channels`，提取 `cost`（消耗）、`revenue`（原始收入）
   - 跳过 `channel === "FB W2A"`
3. **逐日获取修正系数**：`GET /api/correction-factors?date={date}`
   - 安卓产品：单一系数 `factor` → `correctedRevenue = revenue * factor`
   - iOS 产品：`{fb, other}` → FB 渠道乘 `fb`，其他渠道乘 `other`
4. **关键：检查快照时效性**
   - 个人面板历史数据走快照缓存（`data/personal-snapshots/personal-{date}.json`）
   - 如果某天消耗差异 >5% 且该天在 XMP 补拉修复（6/9）之前，快照可能过期
   - **修复方法**：删除过期快照文件 → 重新请求 API 自动重建
5. 调用间隔 ≥ 200ms

### Step 3: 对比计算

1. 以 `产品|渠道` 为 key，逐日对比三项指标：
   - **消耗绝对差** = 表格消耗 - Dashboard 消耗
   - **原始收入绝对差** = 表格原始收入 - Dashboard 原始收入
   - **修正收入绝对差** = 表格修正收入 - Dashboard 修正收入
2. 相对差 = 绝对差 / |Dashboard值| × 100%
3. 汇总：全产品渠道逐日合计
4. 识别「仅表格有」的产品×渠道（Dashboard 中该投手无在投 campaign）

### Step 4: 生成图表

用 Python + matplotlib 生成三张图：

#### 图1：绝对差异总览柱状图
- 每日三组柱（消耗 / 原始收入 / 修正收入绝对差）
- 标注关键数值（>$10 的柱标注金额）
- 文件：`compare-chart-v2-abs.png`

#### 图2：三指标拆解折线图
- 3 个子图（消耗 / 原始收入 / 修正收入）
- 每个子图：柱=绝对差（左轴 $），红线=相对差（右轴 %）
- 标注数值
- 文件：`compare-chart-v2-detail.png`

#### 图3：逐产品×渠道热力图
- 行=产品×渠道，列=日期
- 颜色=原始收入绝对差（红=表格多，蓝=Dashboard多）
- 仅展示有显著差异（>$1）的组合
- 标注金额数值
- 文件：`compare-chart-v2-heatmap.png`

### Step 5: 输出结果

1. 通过飞书发送三张图片
2. 文字总结：
   - 每日汇总差异表（绝对差 + 相对差）
   - 月均基准：各产品×渠道的平均差异
   - 异常日期定位：与月均基准的偏差
   - 「仅表格有」的产品×渠道列表
   - 消耗 vs 收入差异的根因分析

## 常见根因

| 现象 | 根因 | 修复 |
|------|------|------|
| 消耗系统性偏低5~8%（仅修复前日期） | XMP 缓存只截取到 23:05，最后~55分钟丢失 | 删除过期快照 + 用 `/api/xmp-backfill` 补拉 XMP |
| FB 渠道消耗偏高 | 表格合并了 FB W2A 消耗，Dashboard 分开统计 | 对比时合并 W2A 到 FB，或排除 W2A sheet |
| 收入偏高 3~8% | 表格包含全产品收入，Dashboard 只算投手归因收入 | 识别「仅表格有」的产品×渠道 |
| 修正收入差异大于原始收入 | iOS FB 修正系数大（×1.4~2.0）放大差异 | 正常，关注原始收入差异即可 |
| 某天某产品剧烈反向波动 | AF 回传延迟或跨天归因 | 查 AF 回传明细确认 |

## 脚本位置

| 文件 | 用途 |
|------|------|
| `scripts/compare-sheet-dashboard.js` | 数据采集+对比（飞书表格 + Dashboard API） |
| `scripts/compare-chart-v2.py` | 三张图表生成 |
| `scripts/compare-result.json` | 中间结果 JSON |

## 快速调用

```
查一下 [飞书表格链接] [投手名字] 的日报数据
```

示例：
```
查一下 https://presence.feishu.cn/wiki/IERKwXqK0i7hY7kE1i0c12fKnwe 苏屹恒的日报数据
```

龙虾会自动：解析表格 → 获取 Dashboard 数据 → 对比计算 → 生成图表 → 发送结果 + 文字分析。
