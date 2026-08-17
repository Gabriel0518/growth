# BytePlus / 火山引擎 DataFinder 数据源接入

> 状态：🟢 **端到端已跑通（2026-07-03）**——签名/id口径/事件名/指标/人群过滤全部验通，已产出真实人均指标。可复用脚本已落地（见第 12 节）。
> 状态（旧）：🟢 AK/SK 已到手（2026-07-01），可开始开发（此前长期卡在拿不到密钥）
> 环境：**SaaS-非云原生 · 海外环境（BytePlus 环境）**
> 服务地址：**`https://analytics.byteplusapi.com`**
> 用途：把 DataFinder 的产品内用户行为数据接入投放看板，与投放侧数据（AF/Adjust/雅典娜/XMP）互补
>
> 最近更新：2026-07-01

---

## 0. 一句话总览

DataFinder（字节的用户行为分析平台，类似 GA4 / 神策 / 火山引擎增长分析）有一套官方 **OpenAPI**，
用 **AK/SK + HMAC-SHA256 签名**鉴权，核心是一个**同步 POST 查询接口**（传 DSL、返回聚合结果）。
我们要接的是 **Doni_Android（app_id `812405`）** 的留存/付费/漏斗等产品行为数据，
用于补齐现有投放看板完全没有的"产品内行为侧"视角。**只读查询即可满足需求，写操作用不上、也别碰。**

---

## 1. 环境判定（关键，别搞混）

DataFinder 分多种部署环境，**服务地址隔离不互通**，用错地址密钥直接无效：

| 环境类型 | 服务地址 | 是否我们的 |
|---|---|---|
| SaaS-云原生（国内+海外柔佛）/ SaaS-非云原生**国内** | `https://analytics.volcengineapi.com` | ❌ |
| **SaaS-非云原生海外环境（BytePlus 环境）** | **`https://analytics.byteplusapi.com`** | ✅ **就是这个** |
| 私有化部署 | 产品自己的域名 | ❌ |

- **为什么是海外**：Doni 是出海产品，走 BytePlus 侧。屹恒 2026-07-01 明确确认走 `analytics.byteplusapi.com`。
- 不确定环境时，官方判定文档：https://www.volcengine.com/docs/84129/1261497?lang=zh

---

## 2. 密钥（AK/SK）

- **存储位置**：`/etc/environment`
  - `BYTEPLUS_DATAFINDER_AK`（Access Key ID）
  - `BYTEPLUS_DATAFINDER_SK`（Secret Access Key）
- **获取方式（SaaS 环境）**：**必须提工单联系火山引擎技术申请**，批准后 AK/SK 发到火山账号绑定的**安全邮箱**。
  - ⚠️ 控制台 IAM 自助生成的通用云 AK/SK **对 DataFinder 分析 OpenAPI 无效**——这就是屹恒当初在控制台怎么找都找不到入口的原因。
  - 2026-07-01 密钥已由屹恒提供（说明工单已批），已入库，可直接用。
- **登录账号**：suyiheng@heyhru.com（屹恒个人账号）
- 私有化环境才能在"集团项目概览"自助创建/重置 AK/SK（与我们无关，记录备忘）。

---

## 3. 应用 & 看板信息

- **应用**：`Doni_Android`，**app_id = `812405`**
- **看板 URL**：https://console.byteplus.com/datafinder/app/812405/dashboard/7572522992001876509
- **「Doni主业务」看板实际包含**（都是现有投放看板没有的产品运营/留存深度指标）：
  - **留存/活跃**：DAU/DNU、WAU、新/老用户留存
  - **付费**：ARPU、LTV分析、付费人数/金额/付费率（新老 × 金币/订阅）、三方支付占比与来源
  - **核心漏斗**：登录漏斗、注册成功率、支付链路、右滑率/match成功率、人均划卡数、匹配成功弹窗渗透
  - **社交行为**：人均收发消息数、消息回复率、发/收消息渗透、追发消息、亲密值事件
  - **特色功能**：视频拨打时长、恋爱铃渗透/点击、未传头像率
  - 还有「当天数据异常排查（小时级对比）」「报警」看板

---

## 4. 鉴权与签名机制（HMAC-SHA256）

> OpenAPI 使用 AK/SK 认证。所有接口走 HTTPS + 统一签名。

**认证字符串格式**：`ak-v1/access_key/timestamp/expiretime/signature`
放在 HTTP header：`Authorization: ak-v1/access_key/timestamp/expiretime/signature`

- `ak-v1`：版本号
- `access_key`：AK
- `timestamp`：签名生效 UTC 时间
- `expiretime`：签名有效期限

**签名步骤**：
1. 认证字符串前缀 = `"ak-v1/access_key/timestamp/expiretime"`
2. `sign_key = HmacSHA256(message=认证字符串前缀, key=secret_key)`
3. 拼 CanonicalRequest：
   ```
   CanonicalRequest = HTTPMethod:${method} + '\n'
                    + CanonicalURI:${uri} + '\n'
                    + CanonicalQueryString:${queryString} + '\n'
                    + CanonicalBody:${body}
   ```
4. `signature = HmacSHA256(message=CanonicalRequest, key=sign_key)`
5. 最终认证串 = `ak-v1/access_key/timestamp/expiretime/signature`，放 `Authorization` header

**官方 SDK**（GitHub 开源，Python/Java 等，封装了签名和复杂查询参数）：
```python
ak = '{AK}'; sk = '{SK}'
# 海外环境必须显式传 url
bc = RangersClient(ak, sk, url='https://analytics.byteplusapi.com')
bc.data_finder("/openapi/v1/analysis", body=dsl)   # = request("/datafinder/openapi/v1/analysis", ...)
```
- `bc.data_finder(path)` = `bc.request("/datafinder/" + path)`（自动加 `/datafinder` context-path）
- `bc.data_rangers(path)` = `bc.request("/datarangers/" + path)`（另一 context-path，用于数据导出类接口）

> 我们接入方式：**照 dashboard 的 Node 风格自己实现签名**（不依赖 Python SDK），与 server.js 一致。签名逻辑已完全摸清。

---

## 5. 核心接口：查询分析（SaaS）

- **Path**：`POST /openapi/v1/analysis`（context-path `/datafinder`）
- **Content-Type**：`application/json`
- **模式**：**同步**，请求传 DSL，直接返回聚合数据（非异步任务）
- **请求体**：查询 DSL（JSON），不能为空

**DSL 示例（查"活跃用户数"近 5 天）**：
```json
{
  "version": 3,
  "app_ids": [812405],
  "use_app_cloud_id": true,
  "periods": [
    {
      "granularity": "day",
      "type": "last",
      "last": { "amount": 5, "unit": "day" },
      "timezone": "Asia/Shanghai"
    }
  ],
  "content": {
    "query_type": "event",
    "profile_groups_v2": [],
    "profile_filters": [],
    "queries": [
      [
        {
          "event_type": "origin",
          "show_name": "活跃用户数",
          "event_name": "app_launch",
          "groups_v2": [],
          "filters": [],
          "show_label": "active_user",
          "event_indicator": "event_users"
        }
      ]
    ],
    "option": { "skip_cache": false }
  }
}
```

**返回结构（关键字段）**：
```jsonc
{
  "code": 200,                       // 200=成功，非200看 message
  "data": [
    {
      "result_status": "SUCCESS",
      "execute_time": 0,             // 子查询执行耗时（可观测性能）
      "data_item_list": [
        {
          "group_by_key": "__all",
          "data": [142099, 145940, 139035, 148457, 154313],  // 按日期数组排列的指标值
          "sum": 729844,             // 求和
          "avg": 145968.8,           // 平均
          "show_name": "活跃用户数",
          "event_name": "app_launch"
        }
      ],
      "date_index_list": ["20200606","20200607","20200608","20200609","20200610"]  // 与 data 一一对应
    }
  ],
  "message": "success"
}
```
- `data_item_list[].data` 与 `date_index_list` 按下标一一对应。
- 自带 `sum` / `avg` / 平方和，省去二次计算。

---

## 6. 完整 API 列表（能拿哪些数据）

| 分类 | 主要接口 | 说明 |
|---|---|---|
| **看板查询** | 查询用户看板列表 / 查询看板信息 / 查询看板中的报表信息 / 查询报表信息与数据 | 把控制台已配好的看板直接搬出来（预计算，快） |
| **事件分析** | 查询分析（SaaS）/ 查询分析（私有化）/ 批量查询分析 | 自定义 DSL 查询，聚合自由度最高（我们主用这个） |
| **用户分析** | 获取用户信息/设备/标签/属性 · 用户行为流 · 创建用户列表查询id · 按id取结果/流式导出 | 单用户画像 & 用户列表 |
| **分群** | 分群列表/信息/用户列表 · 流式下载 · 创建/刷新/删除/修改分群 · 上传文件建群 | 含写操作（建群） |
| **标签** | 上传文件建标签 · 查最新/历史结果 · 导出 · 查基本信息 · 触发计算 | 含写操作 |
| **原始数据导出** | 获取数据文件清单 · 提交自定义数据导出 · 获取导出文件清单 | 异步（提交任务→轮询→下载） |
| **用户属性导出** | 获取用户属性下载地址 | |
| **用量统计** | 月粒度/天粒度用量统计 | |
| **元数据管理** | 应用配置 · 查/改/增/删 事件·虚拟事件·事件属性·虚拟属性·用户属性·项目标签 | 含写操作（改埋点元数据配置，⚠️慎碰） |
| **集团/入库** | 获取集团信息 · 入库校验明细 | |

**对投放看板最有用**：**看板查询 + 事件分析** 两块 → 新用户 D1/D7 留存、付费率、注册/支付漏斗转化，可与投放量做交叉分析。

---

## 7. 只读 vs 可写

- **绝大部分是只读**（查询/导出）。
- **有部分写能力**，但都是"资产/配置管理"性质，**不改埋点上报的原始行为数据**：
  - 可写：创建/刷新/删除**分群**、创建/计算**标签**、增删改**虚拟事件/虚拟属性/项目标签**、上传文件
  - **不能改**：埋点上报的原始事件数据
- **我们的用途只用只读查询**，写操作用不上，且**建议绝对不碰元数据写接口**（误改虚拟事件/属性会影响生产埋点配置）。

---

## 8. 聚合自由度 & 响应时间

**聚合自由度：很高。** DSL 支持任意时间粒度（day/week/month）、多指标、多维度分组（`groups_v2`）、多重筛选（`filters`）、虚拟事件/虚拟属性、多子查询并行——基本等价于控制台「事件分析」页面能拖出的所有组合。

**响应时间：**
- **看板查询/事件分析是同步接口，常规查询秒级返回。** 看板数据是**预计算好的**（文档明确："获取的是已经计算好的看板数据，不支持刷新缓存"），事件分析虽实时算但常规范围也快，返回带 `execute_time` 可观测。
- **只有两类是慢/异步**（跟我们用途基本无关）：
  - **大批量原始数据导出**：提交任务→轮询文件清单→下载
  - **百万级分群用户列表**：需走流式接口，否则会 504

---

## 9. 踩坑 & 注意事项（来自官方 FAQ）

- **多维表格看板不能用 report 接口查**（DSL 太复杂、返回格式不同），只能用事件分析接口。
- **过滤粒度要和查询粒度一致**：如时间过滤 `granularity:"month"` 但查询用天粒度，会自动补齐当月导致数据偏多 → 统一用 `day`。
- **看板查询不支持刷新缓存**：没有参数能触发重算，拿的是已算好的数据。
- **分群 OpenAPI 无分页功能**；获取分群用户列表建议 ≤100 万条，超过用流式接口（否则 504）。
- **限频**：有 QPS/quota 限制（类似 XMP），需注意并发。分群导出接口建议串行调用勿并发。
- **报错 "用户不在此集团下"**：检查 AK/SK 是否正确、账号是否在集团下且有项目权限。
- **报错 "Expecting value..."**：body JSON 格式问题，key 记得加双引号。

---

## 10. 下一步开发计划

1. **最小验证脚本**：只查一个指标（app_id `812405`「活跃用户数近5天」），跑通 HMAC-SHA256 签名 + 海外地址鉴权。（用 CC 写，Node 实现签名）
2. 通了之后**圈定 3-5 个核心指标**：建议新用户 D1/D7 留存、新用户付费率、登录/注册漏斗转化率（可与投放量交叉）。
3. **接入 dashboard**：个人面板新增 tab 或单独「产品行为」区，天级或小时级。

---

## 12. ✅ 已验证实战成果 + 可复用脚本（2026-07-03）

> 首个端到端场景：**本地 AF 归因圈某 campaign 人群 → user_id → DataFinder 查该人群行为指标**。
> 用它算出了 `Doni And_syh_260701_AEO` 人群的「人均收发消息数」。**全程只读。**

### 12.1 完整链路（两端都有可复用脚本）

```
[本地 dataserver/data.db]                          [BytePlus DataFinder]
某 campaign 的 af_complete_registration            签名鉴权 → 事件分析 /openapi/v1/analysis
  └ 提取 event_value.user_id（去重）    ──喂──▶      └ profile_filters 按 user_id 圈人群
     scripts/extract-campaign-uids.js                  └ 聚合 pv(次数)/event_users(人数)
                                                    scripts/byteplus-df-query.js
```

- **前半段**：`scripts/extract-campaign-uids.js <app_id> <campaign> [outFile]`
  - 从 `data.db` 各 `records_*` 表提取某 campaign 注册用户的 user_id（`json_extract(json_extract(payload,'$.event_value'),'$.user_id')`）
  - ⚠️ 跑它需 `NODE_PATH=/home/admin/.openclaw/workspace/dashboard/node_modules`（better-sqlite3 在 dashboard 下）
  - ⚠️ 仅对有 user_id 的产品有效；**Romi iOS 用 Adjust 无 user_id，不适用**
- **后半段**：`scripts/byteplus-df-query.js`（纯 Node，零外部依赖，凭据从 /etc/environment）
  - `active [appId] [days]`：验签名连通性
  - `flow <appId> <userId>`：验 id 口径（单用户行为流）
  - `events <appId> [keyword]`：列事件元数据找真实事件名
  - `cohort-metric <appId> <uidsFile> <eventName> <indicator> [days]`：按人群查单指标
  - `msg-avg <appId> <uidsFile> <sendEvent> <recvEvent> [days]`：一站式算人均收发消息数

### 12.2 一次真实结果（Doni And_syh_260701_AEO，近14天）

| 指标 | 值 |
|---|---|
| 人群规模（归因圈选去重 user_id） | 173（后续新回传增至 177） |
| 发消息 | 总次数 4131 / 触发 71 人 |
| 收消息 | 总次数 4552 / 触发 76 人 |
| **人均发消息（÷全人群173）** | **23.88** |
| **人均收消息（÷全人群173）** | **26.31** |
| **人均收发合计（÷全人群173）** | **50.19** |
| 人均发消息（÷发过消息的71活跃者） | 58.18 |

### 12.3 🔑 破局关键（血泪坑，都已固化进脚本）

1. **签名**：`sign_key = HmacSHA256(sk, signKeyInfo)` 返回的是 **hexdigest 字符串**，再当**下一次 hmac 的 key**（不是 raw bytes！用 raw bytes 报 `authorization is invalid`）。参考官方 `rangersdk/dslclient/dsl_sign.py`。
2. **period 必须用 `type:'last'`**（近N天）。`type:'range'` 固定区间缺必填字段直接 400。
3. **次数指标叫 `pv`**（不是 `event_count`！event_count 报「操作失败」）；人数=`event_users`。
4. **人群过滤 profile_filters 的 condition 字段名**（照官方 `rangersdk/dslcontent/condition.py`，之前全猜错才一直返回空集）：
   - `property_value_type` / `property_name` / `property_operation` / `property_values` / `property_type`
   - `property_type` 用 **`'profile'`**（不是 'user'），过滤维度字段名用 **`user_id`**（不是 user_unique_id！user_unique_id 作为 profile 属性不存在，返回 null）
   - filter 外层结构：`{show_name, show_label, expression:{logic:'and', conditions:[...]}}`
5. **id 口径（关键结论）**：本地业务 user_id **== DataFinder user_unique_id == profile 属性 user_id**（实测 uid=5030411 行为流命中，三者一致）→ **不需要任何 id 映射**。
6. **事件名**（Doni 服务端埋点，比客户端 g_* 准）：发=`doni_android_server_send_message_to_user`，收=`doni_android_server_receive_message_from_user`。

### 12.4 推广到其他产品

本方法适用于**所有有 user_id、走 AF 归因的产品**。换产品只需：①对应 app_id ②对应 bundle/app_id 值 ③该产品的收发消息（或目标）事件名（用 `events` 命令查）。待收集各产品 app_id 清单（确认是否同一集团/同一 AK/SK 权限）。

---

## 12.5 生产接入：日报 PWA「女生注册人数」（2026-07-03）

> 第二个端到端生产场景：把 PWA 产品的「女生注册人数」从固定值 5 换成 BytePlus 实时取数。

- **产品/应用**：PWA，**app_id = `653834`**（独立应用，≠ Doni 的 812405；同一集团、同一 AK/SK 可查）。
- **指标**：事件 `pwa_conv_cash_ready_pop_show` 的 **`event_users`**（触发人数/去重），**全体用户**（不加 `profile_filters`）。
- **取数窗口**：日报每天写「昨天/前天/大前天」三天。用 `period.type:'last', amount=今天回退到最早目标日期的天数`，返回后按 `date_index_list`（YYYYMMDD）逐日映射，取每个目标日期对应值。BytePlus 单次固定日期不好查，靠 last+下标匹配最稳。
- **实测（2026-07-02 昨天）**：event_users=581（对比 pv=1189，人数<次数，符合去重）。三天 6/30=592, 7/1=632, 7/2=581。
- **生产代码**：`scripts/daily-report-sheet.js` 的 `fetchPwaRegistrations(dates)` → 写入源表 PWA 块 C 列（第57行=昨天），再由 `sync-daily-report-to-wiki.js`（08:40）同步到「日报数据汇总」wiki 的 PWA sheet（sheetId `gFdKrM`）C 列。
- **失败降级**：缺 AK/SK 或查询失败/无数据时该日 C 列**留空**（不阻断日报其余部分），控制台打 warning。
- **踩坑复用**：签名/period/指标名/id 口径全部沿用第 12.3 节的结论，未新增坑。

---

## 11. 参考文档链接

- 技术文档主入口（调用方式/签名）：https://www.volcengine.com/docs/84129/1261794?lang=zh
- API 列表总览：https://www.volcengine.com/docs/84129/1261793?lang=zh
- OpenAPI FAQ（踩坑）：https://www.volcengine.com/docs/84129/1563654?lang=zh
- 查询分析（SaaS）：https://www.volcengine.com/docs/84129/1285239?lang=zh
- API 说明与公共参数：https://www.volcengine.com/docs/84129/1285213?lang=zh
- 查询看板信息：https://www.volcengine.com/docs/84129/1285222?lang=zh
- 环境判定（云原生/非云原生/私有化）：https://www.volcengine.com/docs/84129/1261497?lang=zh
- 事件分析（产品功能说明）：https://www.volcengine.com/docs/84129/1261539?lang=zh
- 国际版（BytePlus）OpenAPI 概览：https://docs.byteplus.com/en/docs/data-intelligence/reference-byteplus-data-intelligence-openapi-overview
