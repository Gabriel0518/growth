# 广告平台 API 对接

> 专家文档：雅典娜 API（已完成）+ Google / TikTok / Meta API（规划中）。从 SERVER_OVERVIEW.md 拆分。

---

## 雅典娜收入 API 对接（已完成 2026-05-21）

已用雅典娜开放 API 替代 Playwright 网页抓取。无头浏览器依赖已移除，抓取速度从 30-60s 提升到 <1s。

### 9.1 API 信息

| 项目 | 值 |
|------|----|
| 生产环境地址 | `https://admin-api-prod.sitin.ai` |
| 接口路径 | `GET /api/open/admin/revenue` |
| API Key | `<ATHENA_API_KEY>` |
| 认证方式 | `Authorization: Bearer <key>` |
| 限流 | 60 QPM |
| 数据时区默认 | Asia/Shanghai（可选 UTC / PST / PDT） |

### 9.2 请求参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `date` | 否 | YYYY-MM-DD，不传默认今天实时数据 |
| `timezone` | 否 | 默认 Asia/Shanghai |

### 9.3 返回结构

```json
{
  "success": true,
  "data": {
    "date": "2026-05-20",
    "snapshotType": "realtime",    // realtime=今日实时 daily=历史完整天
    "snapshotTime": "...",        // 查询时间 UTC
    "products": [
      {
        "appId": 9,
        "appName": "Dora Android",
        "totalRevenue": "190.92",    // 总收入（含订阅+金币）
        "totalPayments": 5,          // 总付款笔数
        "totalPayingUsers": 3,       // 总付费用户数（去重）
        "newUserRevenue": "120.93",  // 新用户收入（注册当天付款）
        "newUserPayments": 5,        // 新用户付款笔数
        "newUserPayingUsers": 3      // 新用户付费人数（去重）
      }
    ]
  }
}
```

### 9.4 产品名映射（API → 现有体系）

API 返回 `appName`，需映射为现有系统产品名：

| API appName | 映射后 | 规则 |
|------------|--------|------|
| Dora | Dora iOS | 不带后缀 = iOS 产品 |
| Romi | Romi iOS | 同上 |
| Luma | Luma | iOS 产品，名称不变 |
| GraceChat | GraceChat | iOS 产品，名称不变 |
| Kira | Kira iOS | 不带后缀 = iOS 产品 |
| Doni | Doni | 安卓产品但名称不变 |
| Dora Android | Dora And | Android 后缀 → And |
| Romi Android | Romi And | 同上 |
| Jovia Android | Jovia And | 同上 |
| Kira Android | Kira And | 同上 |
| Nalo Android | Nalo And | 同上 |
| Haven / Aura / AI Fantasy / Lovia / Elara | — | 已下架，忽略 |

**映射规则总结**：不带后缀的 Dora/Romi/Kira → 加 iOS 后缀；带 Android 后缀的 → 改为 And 后缀；其余名称不变。

### 9.5 与 Playwright 抓取的对比

| 维度 | Playwright 抓取 | API |
|------|----------------|-----|
| 依赖 | Chrome + Playwright + 登录态 | 纯 HTTP 请求 |
| 稳定性 | 低（DOM 变动、登录过期、选日期卡顿） | 高（结构化 JSON，无状态） |
| 资源占用 | ~300MB Chrome 进程 | 几乎为零 |
| 速度 | ~30-60 秒（逐产品点击） | <1 秒（一次请求全部产品） |
| 数据字段 | totalRevenue only | totalRevenue + newUserRevenue + totalPayments + totalPayingUsers + newUserPayments + newUserPayingUsers |
| 限流风险 | 无（模拟真人操作） | 60 QPM（每小时 1 次绰绰有余） |
| 登录凭据 | DASHBOARD_USER / DASHBOARD_PASS | API Key（Bearer Token） |

### 9.6 对接记录

- 2026-05-20：首次对接测试，dev 环境数据全零，仅验证结构
- 2026-05-21：接入 prod 环境，数值验证通过（与 Playwright 6/11 产品完全一致，其余差异 <$70，为抓取时间点微小偏差）
- **已合并到 dashboard**：`fetcher.js` 中 `fetchAthenaApi()` 直接调用 prod API，替代了 Playwright 脚本 `fetch-revenue.sh`
- **Nalo And**：Playwright 不抓的产品，API 已补上，汇总面板现在有数据
- **性能提升**：雅典娜抓取从 30-60s 提升到 <1s
- **Playwright 脚本保留**：`scripts/fetch-revenue.sh` 和 `scripts/sitin-dashboard.js` 仍在磁盘，可作为手动 fallback

### 9.8 飞书文档

对接教程文档：https://presence.feishu.cn/docx/CfPFdhC3NofpfsxNrjLclopTnQg

---

## 规划中：Google Ads API 直连

目标：绕过 XMP Open API，直接从 Google Ads API 获取更完整、更精准的投放数据（消耗、转化、素材等）。

### 申请流程

1. **确认公司是否已有 Developer Token** — Google 通常每公司只给一个 token，需问技术负责人
2. **如需新申请：**
   - 需要一个 Google Ads Manager 账号（MCC）
   - 登录 `ads.google.com` → 工具与设置 → API Center → 填表申请
   - **申请时需要：公司名称、公司 URL、API 联系邮箱、用途说明**
   - 可能先拿到 Explorer 级别（生产账号 2,880 操作/天），需再申请 Basic Access
3. **创建 Google Cloud 项目 + OAuth 2.0 凭据**：Client ID / Client Secret / Refresh Token
4. **用 GAQL 查询数据**（类似 SQL，支持 campaign/ad_group/ad 级别的消耗/转化/素材数据）

### 权限等级

| 等级 | 每日操作 | 审批时间 |
|------|---------|---------|
| Explorer | 生产 2,880 / 测试 15,000 | 自动 |
| Basic | 15,000 | ~2 工作日 |
| Standard | 无限 | ~10 工作日 |

Basic Access + Reporting 用途即可满足看板需求。

### ⚠️ 核心阻塞

**申请 Developer Token 需要填写公司商业信息（公司名称、公司 URL 等），屹恒无法自行决定，需要公司层面处理。**

- 建议：由技术负责人或管理层操作申请，或确认公司是否已有 Developer Token
- 屹恒角色：拿到 token 后负责技术对接

### 相比 XMP 的优势

- 素材级数据更完整（文案、图片 URL、素材类型）
- 转化数据直接来自 Google，不经过 XMP 中转
- 无缓存延迟（XMP 缓存 30 分钟）
- 支持 GAQL 灵活查询（按日期/设备/地域等拆分）

## 规划中：TikTok Ads API 直连

目标：与 Google Ads API 同理，绕过 XMP，直接从 TikTok Marketing API 获取更完整的投放数据。

官方文档：https://business-api.tiktok.com/portal/docs?id=1735714088656897

### 申请流程（5 步）

#### Step 1：创建 TikTok For Business 账号
- 注册地址：https://ads.tiktok.com
- 即公司现有的 TikTok 广告主账号（投放 TT 渠道的账号）
- 如果公司已有 → 跳过

#### Step 2：注册成为开发者
- 登录 https://business-api.tiktok.com/portal → 注册开发者账号
- **需要填写：** 姓名、邮箱、公司名称、公司网站 URL
- ⚠️ 与 Google 同理：需要公司商业信息，屹恒无法自行决定

#### Step 3：创建开发者应用（Developer App）
- 在开发者账号下创建 App
- 一个开发者账号最多创建 **5 个 App**
- 创建时需选择 App 的权限范围（Scope of permission）
- App 创建后状态为 **Pending Review**，需 TikTok 审批
- **审批时间：约 2-3 个工作日**（权限变更也需重新审批）
- ⚠️ 核心卡点：需填写申请理由，说明用途（如"拉取广告投放报表数据用于内部看板"）

#### Step 4：获取广告主授权（Authorization）
- App 审批通过后，需获取广告主（advertiser）的授权
- 流程：在 My Apps 页面获取授权 URL → 发给广告主 → 广告主点击同意
- 授权码（auth_code）**1 小时有效**，只能用一次
- 可同时授权多个广告主账号（Multi-advertiser 支持）

#### Step 5：获取 Access Token（Authentication）
- 用 auth_code + app_id + secret 调用 `/oauth2/access_token/` 接口
- **Marketing API 的 access token 不过期**（长期有效，无需刷新）
- 如需撤销，调用 `/oauth2/revoke_token/`

### 凭据体系

| 凭据 | 说明 | 是否长期有效 |
|------|------|------------|
| App ID + App Secret | 创建 App 时获得 | ✅ 永久 |
| auth_code | 广告主授权后获得 | ❌ 1 小时，一次性 |
| Access Token | 用 auth_code 换取 | ✅ 不过期（Marketing API） |

### 权限/Scope 体系

创建 App 和申请权限时需选择 scope，核心 scope：

| Scope | 说明 | 我们是否需要 |
|-------|------|-------------|
| `report` | 读取报表数据（消耗、转化、安装等） | ✅ **必须** |
| `campaign` | 管理 campaign（创建/修改/暂停） | 可选（当前只需读） |
| `ad` | 管理 ad group 和 ad | 可选 |
| `creative` | 管理创意素材 | 可选 |
| `audience` | 管理受众 | 可选 |
| `account` | 管理广告账户信息 | 可选 |

**起步只需申请 `report` 权限**，审批更容易通过。后续需要操作广告时再追加 scope（需重新提交审批，2-3 天）。

### Reporting API 能力

TikTok Reporting API 支持同步和异步两种模式：
- **同步**：请求后直接返回数据，适合小范围查询
- **异步**：提交任务后轮询结果，适合大批量历史数据

**6 种报表类型：**

| 报表类型 | 描述 | 我们是否需要 |
|---------|------|-------------|
| **Basic Report** | 消耗和效果数据（4 个维度：campaign / ad group / ad / ad account） | ✅ **核心** |
| Audience Report | 按受众属性分组（年龄/性别/地区/兴趣） | 可选 |
| Playable Ad Report | 可玩广告数据 | ❌ |
| DSA Report | 动态展示广告（DPA）数据 | ❌ |
| Business Center Report | BC 下所有广告账户汇总 | 可选 |
| GMV Max Ads Report | TikTok Shop GMV 广告消耗 | ❌ |

**Basic Report 支持的核心指标（与业务相关）：**
- 消耗（spend）、展示（impressions）、点击（clicks）、CTR
- 转化（conversions）、安装（installs）、注册、付费
- 支持按日期范围查询

### Rate Limit

- 全局限制：每 App 每秒请求数上限
- Reporting 端点有单独限额
- 具体数值需按端点查看
- 我们业务量小，Rate Limit 基本不会成为瓶颈

### 账号结构

```
开发者账号 (Developer Account)
  └── 最多 5 个开发者应用 (Developer App)
       └── 每个可授权多个广告主 (Advertiser Account)
            └── 下辖 campaign → ad group → ad
```

广告主与 App 是**多对多**关系：一个 App 可被多个广告主授权，一个广告主也可授权给多个 App。

### 相比 XMP 的优势

- **消耗数据直接来自 TikTok**，不经过 XMP 中转，更精准
- **素材级别数据**：可获取创意详情（文案、视频信息、素材 ID）
- **无缓存延迟**（XMP 缓存 30 分钟）
- **安装/转化数据更准确**：直接来自 TikTok 的归因，非 MMP 中转
- **同步+异步双模式**：大数据量可异步拉取，不怕超时
- **Access Token 不过期**：不需要像 XMP 那样每次计算 sign

### ⚠️ 核心阻塞

**与 Google Ads API 同理：注册开发者账号和创建 App 时需要公司商业信息（公司名称、公司网站 URL），屹恒无法自行决定。**

- 建议：由技术负责人或管理层操作开发者注册和 App 创建
- 屹恒角色：拿到 App ID / Secret / Access Token 后负责技术对接
- 可与 Google Ads API 申请同步推进，一次性向管理层获取所需信息

### 需要向公司确认的问题

1. **公司是否已有 TikTok 开发者账号？** — 如果之前有人用过 TikTok Marketing API，可能已有
2. **谁有 TikTok For Business 广告主管理员权限？** — 需要该用户完成授权流程
3. **是否只需 Reporting 权限？** — 如果确认只读，只申请 `report` scope，审批更快
4. **公司商业信息**：公司注册名称、公司网站 URL

## 规划中：Facebook/Meta Ads API 直连

目标：与 Google、TikTok 同理，绕过 XMP，直接从 Meta Marketing API 获取更完整的投放数据。

官方文档：https://developers.facebook.com/docs/marketing-api

### 申请流程（5 步）

#### Step 1：拥有 Meta Business Manager 账号 + 活跃广告账户
- 注册地址：https://business.facebook.com
- 需要一个 **Business Manager（BM）账号**，带管理员权限
- BM 下需有 **活跃的广告账户（Ad Account）**，记下 `act_<AD_ACCOUNT_ID>`
- 如果公司已有 → 跳过

#### Step 2：注册 Meta 开发者账号
- 登录 https://developers.facebook.com → 用个人 Facebook 账号注册
- ⚠️ **核心卡点（IP 关联风险，见下文）**
- 注册需要验证手机号、邮箱

#### Step 3：创建开发者应用（App）
- 在 App Dashboard → Create App
- 选择 **Business** 类型的 App
- 填写 App 名称、联系邮箱、关联 BM
- 获得 **App ID + App Secret**
- 在 App 中添加 **Marketing API** 产品
- 选择 Use Case: 一般选择无特定用例（No Use Case）或其他，手动添加 Marketing API

#### Step 4：App Review（应用审核）—— ⚠️ 最大门槛

**如果 App 只给公司内部使用**（只有 BM 下有角色的用户才能用），**不需要 App Review**，可以直接用。

**如果要给外部用户使用**，必须提交 App Review：
- 需要提供截图、录屏、详细说明每个权限的用途
- 审核时间：通常 3-10 个工作日
- 被拒概率不低，需要反复修改重提

**我们的场景：公司内部拉取报表 → 不需要 App Review**，只要 App 关联到公司 BM 即可。

#### Step 5：获取 Access Token

Meta 有三种 Access Token：

| Token 类型 | 有效期 | 适用场景 |
|-----------|--------|---------|
| Short-Lived User Token | 1-2 小时 | 测试 |
| Long-Lived User Token | ~60 天 | 临时使用，需定期刷新 |
| **System User Token** | **不过期** | ✅ **生产环境首选** |

**推荐路线：System User Token**
- 在 BM → Business Settings → Users → System Users → 创建 System User
- 为 System User 生成 Token → 选择 App + 权限 → 生成
- **Token 只显示一次，必须立即保存**
- System User Token 不过期，适合服务器无人值守运行

### 凭据体系

| 凭据 | 说明 | 是否长期有效 |
|------|------|------------|
| App ID + App Secret | 创建 App 时获得 | ✅ 永久 |
| System User Token | BM 内创建 System User 后生成 | ✅ 不过期 |
| Long-Lived User Token | 手动延长短期 Token | ❌ ~60 天 |

### 权限/Scope 体系

| 权限 | 说明 | 是否需要 App Review | 我们是否需要 |
|------|------|-------------------|-------------|
| `ads_read` | 读取广告数据（报表、campaign 数据） | 不需要（内部使用） | ✅ **必须** |
| `ads_management` | 创建/修改广告 | 不需要（内部使用） | 可选 |
| `business_management` | 管理 BM 资产 | 不需要（内部使用） | 可选 |
| `pages_read_engagement` | 读取主页数据 | 不需要（内部使用） | 可选 |

**内部使用场景下，只需 `ads_read` + 关联 BM 即可，无需审核。**

### Marketing API Reporting 能力

Meta Marketing API 的报表通过 **Insights API** 获取（`GET /v24.0/{object-id}/insights`）：

| 维度/对象 | 说明 | 我们是否需要 |
|---------|------|-------------|
| **Campaign** | 按广告系列级别查消耗/转化 | ✅ **核心** |
| **Ad Set** | 按广告组级别查 | ✅ |
| **Ad** | 按单条广告级别查 | ✅ |
| **Ad Account** | 按账户汇总 | ✅ |

**Insights API 支持的核心指标：**
- spend（消耗）、impressions（展示）、clicks（点击）、ctr
- conversions（转化）、install（安装）、purchase（购买）
- cost_per_action_type（单次行动成本）
- 支持按日期范围、时间粒度（day/week/month）查询
- 支持按 age/gender/country/Placement 等维度拆分
- 支持异步查询（大数据量）

### Rate Limit

- 按广告账户维度限流：滚动 1 小时窗口
- Insights API 分配额度与账户花费相关
- 我们业务量小，基本不会触发
- 遇到限流用 exponential backoff 重试

### 相比 XMP 的优势

- **消耗数据直接来自 Meta**，不经过 XMP 中转
- **Insights API 支持多维度拆分**（年龄/性别/地区/版位等），XMP 只能按粗粒度
- **素材级别数据完整**：可获取广告创意详情（图片/视频/文案）
- **无缓存延迟**（XMP 缓存 30 分钟）
- **System User Token 不过期**，不需要频繁刷新
- 支持**同步+异步**查询模式

### ⚠️ 核心阻塞 1：公司商业信息

**与 Google、TikTok 同理：创建 App 和关联 BM 需要公司商业信息。**

- 需要 BM 管理员权限
- 屹恒角色：拿到 App ID / Secret / System User Token 后负责技术对接

### ⚠️🔴 核心阻塞 2：Facebook IP 关联与账号风控（比 Google/TikTok 更严重）

**Facebook/Meta 是三大平台中账号风控最严格的，没有之一。** 这是 FB 对接的最大特色和最大风险点：

**1. IP 关联检测（IP Fingerprinting）**
- Facebook 会追踪登录 IP 地址，如果同一 IP 登录过多个账号，会将这些账号**关联**起来
- 一旦其中一个账号被封/违规，**同 IP 下的其他账号也可能被连带封禁**
- 这意味着：**在服务器上登录 FB 开发者账号，理论上会让服务器 IP 与该账号绑定**
- 如果未来服务器需要登录其他 FB 账号（或其他人的账号），会产生 IP 关联风险

**2. 账号纯净度要求**
- FB 对开发者账号的"信任度"非常敏感
- 使用 VPN/代理/数据中心 IP 登录开发者账号，更容易触发风控
- 新注册的 FB 账号直接申请开发者权限，被限制概率很高
- 建议使用**有历史、有真实社交活动**的老号

**3. 开发者账号与广告账号的关联**
- 开发者账号 = 个人 FB 账号
- 广告账号 = BM 下的企业广告账号
- 两者绑定后，个人号出问题 = 整个 API 访问中断

**4. 实际影响评估**
- 我们的场景是**服务器端调用 API**（仅用 Token 发 HTTP 请求，不登录 FB）
- Token 获取后的日常 API 调用**不需要登录 FB**，不涉及 IP 问题
- **风险集中在 Token 获取那一刻**：需要在浏览器中登录 FB → 创建 App → 生成 Token
- 建议：**Token 获取操作在本地电脑完成**，不要在服务器上登录 FB

**5. 服务器端调用的安全性**
- 日常 API 调用仅发 HTTPS 请求到 `graph.facebook.com`
- 不携带 Cookie/Session，不需要 FB 登录态
- 出口 IP 是阿里云服务器 IP，FB 只能看到 API 请求来源
- **API 调用本身不会被 FB 关联到个人账号**

### 三家 API 接入对比总结

| 维度 | Google Ads API | TikTok Marketing API | Meta Marketing API |
|------|---------------|---------------------|-------------------|
| **核心凭据** | Developer Token + OAuth2 Refresh Token | App ID + Secret + Access Token | App ID + Secret + System User Token |
| **Token 有效期** | Refresh Token 长期，Access Token ~1h | **不过期** | **不过期**（System User） |
| **权限审批** | 有等级（Test/Explorer/Basic/Standard） | App 审批 2-3 天 | 内部使用**无需审核** |
| **报表能力** | GAQL 灵活查询 | Basic Report + 5 种报表 | Insights API（同步+异步） |
| **公司信息要求** | ✅ 需要 | ✅ 需要 | ✅ 需要（BM 关联） |
| **IP 风控** | 一般 | 一般 | **🔴 极严格** |
| **接入难度** | 中（审批时间长） | 中（审批 2-3 天） | 低（内部用免审核）/ 高（需审核时） |

### 需要向公司确认的问题

1. **公司 BM 账号的管理员是谁？** — 需要管理员操作：创建 App、关联 BM、创建 System User、生成 Token
2. **是否只需读取报表（ads_read）？** — 内部使用无需 App Review
3. **谁来提供个人 FB 账号注册开发者？** — 建议用公司老板/管理员的个人号，不要用新号
4. **公司商业信息**：公司注册名称、BM ID
5. **Token 生成操作要在本地完成**，不要在服务器上登录 FB

