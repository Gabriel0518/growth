# 量化因子分析（广告投放数据驱动优化）

> 专家文档：基于全量投放数据的量化因子分析，包括方法论、数据来源、分析过程和结论。
> 从 SERVER_OVERVIEW.md 拆分。首次分析：2026-05-27。

---

## 1. 背景与目标

### 1.1 动机

AI 投放建议（dashboard 的 ✨AI 按钮）原先依赖 `投放大师.md` 作为 system prompt，该文档基于投手个人经验和行业通识编写。存在两个问题：
1. 经验可能过时或带有偏见
2. 缺乏本公司实际数据的量化验证

因此屹恒提出：用类似量化投资的方法，从历史投放数据中挖掘量化因子，建立数据驱动的决策规则。

### 1.2 核心目标

> **在长期平均 eLTV ROAS ≥ 回本 ROAS 的约束下，尽可能提高收入规模。**

唯一确定的可调控变量：**预算**（通过消耗数据代理）。

### 1.3 分析维度优先级

按屹恒要求：**平台（FB/GG/TT）→ 系统（iOS/Android）→ 具体产品**

### 1.4 四大量化因子

| 因子 | 类比量化投资 | 广告投放含义 |
|------|-----------|-------------|
| 日历因子 | 日历效应（January Effect） | 周末 vs 工作日的 ROAS/CPI 差异 |
| 动量因子 | 动量/反转策略 | 连续好表现的 campaign 是否会延续 |
| 波动率因子 | 低波动异象 | 高波动 campaign 是否风险更大 |
| 消耗响应因子 | 流动性冲击 | 加预算后 ROAS 如何变化 |

---

## 2. 数据来源与采集

### 2.1 数据架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    数据来源                                   │
├─────────────┬───────────────────┬───────────────────────────┤
│  SQLite DB  │  每日 JSON 文件     │  XMP Open API            │
│ (收入/安装)  │ (产品级雅典娜+XMP) │ (campaign 级消耗)         │
├─────────────┼───────────────────┼───────────────────────────┤
│ 路径:        │ 路径:              │ API:                     │
│ ~/dataserver │ dashboard/data/   │ xmp-open.mobvista.com    │
│ /data.db    │ YYYY-MM-DD.json   │ /v2/media/account/report │
└─────────────┴───────────────────┴───────────────────────────┘
```

### 2.2 数据源 1：SQLite 回传数据库（收入侧）

- **路径**：`/home/admin/dataserver/data.db`（662MB）
- **表结构**：`records_YYYYMM`（按月分表），2026 年 5 月表 `records_202605` 含 642K 条记录
- **关键字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| source | TEXT | 媒体渠道（`Facebook Ads` / `googleadwords_int` / `tiktokglobal_int` / `Facebook+Installs` 等） |
| app_id | TEXT | 应用 ID（需映射到产品名） |
| event_name | TEXT | 事件类型（`af_purchase` / `ad_purchase` / `af_complete_registration` 等） |
| event_time | TEXT | 事件发生时间（AF 为 ISO 格式，AD 为 Unix 时间戳） |
| install_time | TEXT | 用户安装时间（同上格式差异） |
| revenue | REAL | 单次付费金额（USD） |
| campaign | TEXT | campaign 名称 |

- **数据范围**：表名是 `records_202605`（5 月的事件），但 `install_time` 回溯到 2025 年 8 月（因为用户可能 8 月安装，5 月仍在付费）
- **关键限制**：DB 中只有 event_time 在 5 月的记录。对于 3-4 月安装的用户，我们只能看到他们在 5 月产生的购买事件，无法看到他们安装当天的购买（D1 revenue = 0）

#### AF vs AD 数据格式差异

| 维度 | AF (AppsFlyer) | AD (Adjust) |
|------|---------------|-------------|
| source 字段值 | `Facebook Ads` / `googleadwords_int` / `tiktokglobal_int` | `Facebook+Installs` / `Instagram+Installs` / `TikTok+SAN` |
| install_time 格式 | ISO: `2026-05-04 13:25:29.310` | Unix 时间戳: `1770204395` |
| 适用产品 | 所有产品 | 仅 iOS 产品（Dora iOS / Romi iOS / Luma） |
| campaign 名称 | 原始名称 | URL 编码 + `(campaign_id)` 后缀，需清洗 |

#### app_id → 产品名映射

```python
APP_ID_MAP = {
    'com.doramatch.app': 'Dora And',
    'id6746109957': 'Dora iOS',      # AF 用这个
    'com.doni.appa': 'Doni',          # 注意不是 com.doni.matchmingle
    'com.meraki.kira': 'Kira And',
    'id6746782904': 'Romi iOS',
    '6746782904': 'Romi iOS',         # AD 去掉了 id 前缀
    'id1658972379': 'GraceChat',
    'com.qiga.vio': 'Jovia And',      # 注意旧包名
    'com.cavalier.nalo': 'Nalo And',
    'com.romiandroid.appmatch': 'Romi And',
    'id6746466099': 'Luma',
    '6746466099': 'Luma',             # AD 格式
}
```

⚠️ **这些映射在首次分析时踩了坑**：dashboard 代码里用的 app_id 和 DB 中实际的 app_id 不完全一致（比如 Doni 在 DB 中是 `com.doni.appa` 而非 `com.doni.matchmingle`）。调试时需要先 `SELECT DISTINCT app_id` 确认。

#### 平台归一化映射

```python
PLATFORM_MAP = {
    'Facebook Ads': 'FB',
    'Facebook+Installs': 'FB',     # AD 的 FB 渠道
    'Instagram+Installs': 'FB',     # AD 的 IG 归入 FB
    'Off-Facebook+Installs': 'FB',
    'Luma+ios+FB+W2A': 'FB',
    'Dora+ios+FB+W2A': 'FB',
    'googleadwords_int': 'GG',
    'tiktokglobal_int': 'TT',
    'TikTok+SAN': 'TT',            # AD 的 TT 渠道
}
```

### 2.3 数据源 2：每日 JSON 文件（产品级汇总）

- **路径**：`dashboard/data/YYYY-MM-DD.json`
- **数量**：59 个文件（2026-03-30 ~ 2026-05-27），部分日期数据不完整（4 月初约 12 天缺失 athena/xmp）
- **结构**：每个文件包含多个时间快照 `snapshots[]`，每个快照有 `athena[]`（雅典娜收入）和 `xmp[]`（XMP 消耗）
- **选取策略**：取每天最后一个快照（最完整）
- **字段**：

```json
// athena 节点
{"product": "GraceChat", "totalRevenue": 3520.72, "newUserRevenue": 549.44}

// xmp 节点
{"product": "Romi iOS", "cost": 11359.96}
```

- **用途**：提供 44 天的产品级日度数据，用于日历因子等宏观分析（粒度比 campaign 级粗，但时间跨度长得多）

### 2.4 数据源 3：XMP Open API（campaign 级消耗）

- **API**：`POST https://xmp-open.mobvista.com/v2/media/account/report`
- **认证**：`client_id` + `sign = md5(client_secret + unix_timestamp)`，timestamp 30 秒有效
- **限频**：10 QPM（实测 12 秒间隔较安全，偶尔需退避 90 秒）
- **请求参数**：

```json
{
    "start_date": "2026-05-20",
    "end_date": "2026-05-20",
    "dimension": ["campaign_name", "product_name"],
    "module": "facebook",       // facebook | google | tiktok
    "metrics": ["cost", "impression", "click"],
    "currency": "USD",
    "page": 1,
    "page_size": 1000
}
```

- **返回示例**：

```json
{
    "campaign_name": "dora_ios_AEO_MCY_1106_",
    "product_name": "Dora: Create and connect",
    "cost": 2235.56,
    "impression": 77623,
    "click": 860,
    "module": "facebook"
}
```

- **XMP 产品名 → 我们的产品名映射**：在 `scripts/fetch-xmp-api.js` 中的 `PRODUCT_MAP`

#### 批量拉取历史数据

- **脚本**：`analysis/fetch-xmp-history.js`
- **策略**：每天 3 个请求（FB/GG/TT 各一个），12 秒间隔（~5 QPM），遇 400001 错误码退避 90 秒重试
- **缓存**：
  - 已拉取数据存入 `analysis/xmp-history/YYYY-MM-DD.json`
  - 同时检查 `dashboard/data/xmp-cache/xmp-campaigns-YYYY-MM-DD.json`（dashboard 运行时的缓存），避免重复拉取
- **耗时**：45 天 ×3 请求 = 135 个 API 调用，约 25 分钟，中间有 2-3 次限频退避共约 5 分钟
- **最终覆盖**：2026-03-29 ~ 2026-05-27，共 60 天

### 2.5 数据源对齐与可用范围

| 数据层级 | 数据源 | 日期范围 | 有效天数 | 说明 |
|---------|--------|---------|---------|------|
| 产品级（收入+消耗） | 每日 JSON | 3.30 ~ 5.27 | 44 天 | 部分 4 月初缺失 |
| Campaign 级（仅消耗） | XMP API | 3.29 ~ 5.27 | 60 天 | 全量 |
| Campaign 级（仅收入） | SQLite DB | install_time 全范围 | ~23 天有 D1 数据 | 仅 5.5~5.27 的 install 有 D1 revenue |
| **Campaign 级（匹配）** | **合并** | **5.10 ~ 5.27** | **18 天** | **1,622 条有效匹配** |

⚠️ **关键限制**：SQLite 中 `records_202605` 表只存 5 月接收到的事件。3-4 月安装的用户在该表中只有延迟付费数据（event_time 在 5 月），其 D1 revenue（install_time 当天 24h 内的购买）为 0。因此 campaign 级 ROAS 分析仅限 5 月 10-27 日。

---

## 3. 数据准备过程

### 3.1 收入提取（SQLite → CSV）

**脚本**：`analysis/prepare_data.py` 中的 `load_revenue_data()`

**SQL 逻辑**（AF 数据）：
```sql
SELECT 
  date(install_time, '+8 hours') as install_date,  -- 北京时间
  source as platform,
  app_id,
  campaign,
  COUNT(CASE WHEN event_name IN ('af_complete_registration','ad_complete_registration') THEN 1 END) as installs,
  SUM(CASE WHEN event_name IN ('af_purchase','ad_purchase') THEN revenue ELSE 0 END) as revenue,
  SUM(CASE WHEN event_name IN ('af_purchase','ad_purchase') 
       AND (julianday(event_time) - julianday(install_time)) < 1.0  -- 24小时内
       THEN revenue ELSE 0 END) as new_user_revenue,
  COUNT(CASE WHEN event_name IN ('af_purchase','ad_purchase') AND revenue > 0 THEN 1 END) as purchase_events
FROM records_202605
WHERE source IN ('Facebook Ads','googleadwords_int','tiktokglobal_int')
GROUP BY install_date, platform, app_id, campaign
HAVING (installs > 0 OR revenue > 0)
```

**AD 数据差异**：`install_time` 是 Unix 时间戳，需要 `CAST(install_time AS INTEGER)` 并用 `unixepoch` 转换；24h 窗口用秒判断（`< 86400`）。

**new_user_revenue 定义**：install_time 在目标日期（北京时间）且 event_time - install_time < 24 小时的付费总和。这是 D1 revenue 的近似。

**输出**：`analysis/revenue_by_campaign_day.csv`（6,161 行）+ `analysis/revenue_ad_by_campaign_day.csv`（2,438 行）

### 3.2 消耗合并（XMP 多源 → 统一格式）

**脚本**：`analysis/prepare_data.py` 中的 `load_xmp_data()`

合并两个来源：
1. `analysis/xmp-history/*.json`（批量拉取的 48 个文件）
2. `dashboard/data/xmp-cache/xmp-campaigns-*.json`（dashboard 缓存的 12 个文件）

去重策略：按日期去重（同一天只取一个来源），优先取 history 目录。

**输出**：14,472 条 date×campaign 消耗记录，覆盖 60 天。

### 3.3 合并宽表

**脚本**：`analysis/prepare_data.py` 中的 `merge_data()`

将收入和消耗按 `(date, platform, product, campaign)` 四元组进行 join：
- **匹配**：两侧都有数据 → 4,418 行
- **仅收入**：有收入无消耗（install_time 在 3-4 月） → 2,447 行
- **仅消耗**：有消耗无收入（campaign 在 DB 中无对应 install 事件，或 campaign 名不匹配） → 10,054 行

**Campaign 名匹配注意事项**：
- 所有 campaign 名在 join 前做 `.trim()`（XMP 和 AF 末尾可能有空格）
- AD 的 campaign 名需要 URL 解码 + 去掉 `(campaign_id)` 后缀
- 不做模糊匹配（避免引入错误）

**最终宽表**：`analysis/campaign_wide_table.csv`，16,919 行，字段：
```
date, platform, product, system, campaign, cost, impressions, clicks, 
revenue, new_user_revenue, installs, purchase_events
```

### 3.4 产品级汇总

**脚本**：`analysis/prepare_data.py` 中的 `load_product_daily()`

从每日 JSON 提取最后快照的 athena + xmp 数据，输出 `analysis/product_daily_summary.csv`（480 行）。

---

## 4. 因子分析方法与结果

### 4.1 分析脚本

- **初版**：`analysis/factor_analysis.py`（首次跑的版本，XMP 数据不全时的结果）
- **正式版**：`analysis/factor_analysis_v2.py`（全量数据，过滤到 5.10-5.27 可靠区间）
- **因果链验证**：直接在 Python inline 脚本中完成（验证「动量→加量→恶化」假设）

**分析报告输出**：`analysis/factor_analysis_report.txt`

### 4.2 因子 1：日历因子

#### 方法

1. **产品级**（44 天）：按 `is_weekend(date)` 分组，比较 `athena_revenue / xmp_cost`（总 ROAS）和 `athena_new_user_revenue / xmp_cost`（新用户 ROAS）。使用 Welch t-test。
2. **Campaign 级**（18 天）：按 `platform × system` 分组，汇总每天的 `new_user_revenue / cost`，按周末/工作日比较。
3. **按星期几**：7 组比较，看中位数和均值差异。

#### 结果

- 产品级新用户 ROAS：周末 +21%，但 **p=0.28 不显著**
- Campaign 级各平台：+3% ~ +20%，全部不显著
- 按星期几的中位数几乎完全平坦
- 周六均值 7.67 但中位数 2.18 → 被 1-2 个异常天拉高

#### 结论

**日历效应在我们的业务中不显著**。数据量小（11 个周末）是原因之一，但更关键的是效应本身不一致——中位数 vs 均值差距大、各层级方向不统一、无连贯的周内模式。

#### 答辩讨论

屹恒问：「是否主要因为数据量太小？」
回答：数据量小确实降低了统计功效（需 30+ 个周末样本才能检测 20% 的效应），但更关键的是效应的不一致性——如果周末效应真实存在，应该在中位数和所有平台上都看到一致信号。

### 4.3 因子 2：动量因子

#### 方法

1. **ROAS 自相关**：对每个 campaign 构建逐日 ROAS 时序，计算 lag-1 / lag-2 / lag-3 的 Pearson 相关系数（只计算相邻天，跳过非连续日期）。
2. **动量信号测试**：定义「动量信号」= 连续 3 天 ROAS > 该 campaign 的中位数。统计信号触发后第 4 天仍 > 中位数的概率 vs 无信号时的基线概率。差值为 lift。
3. **均值回归速度**：统计 Q4（高 ROAS）日和 Q1（低 ROAS）日的次日 ROAS 相对中位数的倍数。

#### 筛选条件

- campaign 需有 ≥5 天数据
- 每天 cost > $10 且 new_user_revenue > 0
- 只计算相邻连续天的 lag pairs

#### 结果

| 平台 | lag-1 r | 信号后延续率 | 基线 | lift |
|------|---------|-----------|------|------|
| FB | 0.048 | 33% | 52% | **-19%** |
| GG | 0.037 | 14% | 47% | **-32%** |
| TT | 0.199 | 55% | 50% | +4% |

#### 结论

FB/GG 的 ROAS 接近随机游走，连续好表现后反而更可能回落（均值回归）。TT 有弱动量。

#### 答辩讨论：因果链验证

屹恒提出假设：「动量 → 投手加预算 → ROAS 下降 → 表现为均值回归」。

验证方法：将动量信号后的样本按「消耗是否增加 >20%」分为 A 组（动量+加量）和 B 组（动量+未加量），与 C 组（无动量基线）对比。

结果：
- **前提不成立**：动量信号后消耗平均变化 +3.3%，无信号时 +3.4%——几乎无差异。投手并没有系统性地在好表现后加量。
- B 组（纯动量，未加量）延续率 35%，仍低于基线 51% → 均值回归是统计本质，不是操作导致
- A 组样本太少（全局仅 9 个），无法得出可靠结论

### 4.4 因子 3：波动率因子

#### 方法

1. 对每个 campaign（≥7 天数据）计算 ROAS 的变异系数 CV = std(ROAS) / mean(ROAS)
2. 按 CV 四分位分组，比较各组的平均 ROAS
3. 交叉分析：按「消耗中位数」和「CV 中位数」分为 4 象限

#### 结果

- **FB**：高波动组 ROAS(0.53) > 低波动组(0.42)，**p=0.022**（反直觉！）
- 但高波动组日均消耗 $158 vs 低波动组 $489 → 波动率是消耗规模的影子
- **TT**：高消耗+高波动 ROAS(0.44) < 高消耗+低波动(0.48)，唯一有实际风险含义的组合

#### 结论

波动率不是独立风险因子。小预算 campaign 天然波动大，但 ROAS 反而可能更高（因为小预算 campaign 活下来的都是精品）。

### 4.5 因子 4：消耗响应因子

#### 方法

1. **消耗激增分析**：定义「加量」= 日环比消耗增加 >30%（也测了 >50%、>100% 两个阈值），基线消耗 > $20。统计加量前 ROAS、当天 ROAS、3 天后 ROAS 均值。
2. **弹性分析**：按平台汇总每天总消耗和总 new_user_revenue，计算日环比变化率，然后算 Pearson 相关性和中位弹性系数。
3. **消耗水平与效率**：按日均消耗分三等份，比较各组平均 ROAS。

#### 结果

消耗增加 >30% 后：
- **FB**：当天 -14%，3 天后 **-31%**
- **GG**：当天 -23%，3 天后 **-26%**
- **TT**：当天 -8%，3 天后 **-6%**

翻倍后 3 天：FB -45%，GG -72%，TT +0%（完全恢复）

弹性：FB 1.72, TT 1.40, GG 0.23

#### 结论

三个平台对加量的容忍度完全不同。TT 最友好（翻倍可恢复），GG 最危险（翻倍后 ROAS 腰斩再腰斩），FB 有 3 天蜜月期。

---

## 5. 产出文件清单

| 文件 | 路径 | 说明 |
|------|------|------|
| 收入数据 (AF) | `analysis/revenue_by_campaign_day.csv` | 6,161 行，SQLite 提取 |
| 收入数据 (AD) | `analysis/revenue_ad_by_campaign_day.csv` | 2,438 行，SQLite 提取 |
| 产品级汇总 | `analysis/product_daily_summary.csv` | 480 行，每日 JSON 提取 |
| XMP 历史消耗 | `analysis/xmp-history/*.json` | 48 个 JSON 文件 |
| 合并宽表 | `analysis/campaign_wide_table.csv` | 16,919 行 |
| 数据准备脚本 | `analysis/prepare_data.py` | 数据加载、映射、合并 |
| XMP 批量拉取 | `analysis/fetch-xmp-history.js` | Node.js，含限频逻辑 |
| 因子分析脚本 | `analysis/factor_analysis_v2.py` | 四大因子分析 |
| 分析报告 | `analysis/factor_analysis_report.txt` | 完整输出 |
| 决策文档 | `dashboard/AI投放决策.md` | 供 AI 建议系统参考 |
| 飞书版 | [链接](https://presence.feishu.cn/docx/JAWKdWIgso8a98xBdKTcfQbDn5e) | AI投放决策文档 |

---

## 6. 重新分析指南

当数据积累更多后（建议每 2-3 个月一次），按以下步骤重跑：

### 6.1 更新数据

```bash
# 1. 拉取新的 XMP 历史数据（只拉增量）
cd /home/admin/.openclaw/workspace
node analysis/fetch-xmp-history.js 2026-05-28 2026-08-31  # 填实际日期范围

# 2. 重新提取 SQLite 收入数据
# ⚠️ 需要确认新月份的表名（records_202606 等）并更新 SQL
# 如果 DB 有多个月份表，SQL 需要 UNION ALL 或修改 prepare_data.py

# 3. 重新合并
python3 analysis/prepare_data.py

# 4. 重跑分析
python3 analysis/factor_analysis_v2.py
```

### 6.2 需要修改的参数

| 参数 | 位置 | 当前值 | 说明 |
|------|------|--------|------|
| `CAMP_START` / `CAMP_END` | `factor_analysis_v2.py` 第 14-15 行 | `2026-05-10` / `2026-05-27` | Campaign 级数据的可靠范围，根据新 DB 表覆盖范围更新 |
| `APP_ID_MAP` | `prepare_data.py` | 见上文 | 如果新产品上线，需要添加映射 |
| `PRODUCT_MAP` | `fetch-xmp-history.js` | 同 `scripts/fetch-xmp-api.js` | 同上 |
| SQLite 表名 | `revenue_by_campaign_day.csv` 生成 SQL | `records_202605` | 新月份需要扩展到多表查询 |

### 6.3 分析质量检查清单

- [ ] `prepare_data.py` 输出的匹配率（matched / total）应 > 20%
- [ ] Campaign 级有效日期范围应覆盖 ≥ 30 天（更好的统计功效）
- [ ] 检查是否有新的 app_id 或 media_source 未在映射表中
- [ ] 日历因子如果有 ≥ 30 个周末样本，p 值应更可靠
- [ ] 消耗响应因子的 surge 样本数应 > 50 per platform

### 6.4 可扩展方向

- **D7 / D30 LTV**：如果后续 DB 按月表积累了更长时间跨度的数据，可以计算更长窗口的 cohort LTV，替代 D1 revenue
- **素材因子**：结合素材面板数据（`creative-YYYY-MM-DD.json`），分析素材更换对 ROAS 的影响
- **季节性因子**：积累 6 个月以上后可以分析月度趋势
- **竞争因子**：如果能获取竞品 CPM 数据（通过 Meta/Google/TT 的 Auction Insights），可以加入竞争维度
- **ML 模型**：数据量达到 100+ 天后，可以尝试随机森林 / XGBoost 对 ROAS 做特征重要性分析

---

## 7. 与投放大师.md 的关系

- `投放大师.md`：经验驱动的决策框架，定义输出格式和角色
- `AI投放决策.md`：数据驱动的补充，提供量化验证后的规则
- 当前 AI 建议的 system prompt 仍然读取 `投放大师.md`。后续可以考虑将两份文档合并，或在 system prompt 中同时引用
- **差异对照**见 `AI投放决策.md` 第六章，7 处冲突已标注
