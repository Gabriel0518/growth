# FB / GG 广告 API 自主对接清单（从 0 注册账号）

> 整理时间：2026-07-08（龙虾整理，联网核对过官方最新要求）
> 背景：FB 之前用 **admesh 提供的现成 App** 走 OAuth 对接，卡在「跨 BM 拿不到不过期 token + 要过 App Review 才能上线读公司数据」（详见 `docs/meta-api-integration.md`）。
> 屹恒决定：**改为从 0 自己注册开发者账号 + 建 App/MCC 来对接**，脱离 admesh 依赖。
> 本文只列「从 0 走自己路线」需要准备的**新材料 / 新信息**，以及最新官方要求核对结果 + 官方文档链接。

---

## 0. 一句话总览

| 平台 | 自主路线核心动作 | 最大卡点（2025 现状） |
|------|-----------------|---------------------|
| **Meta / FB** | 自己的 FB 号建 Business 类 App + 关联**公司自己的 BM** → System User Token（不过期） | 🔴 **Business Verification（企业验证）** + IP 风控。多数广告权限的 Advanced Access 现在都要求企业验证 |
| **Google / GG** | 建 **Manager 账号(MCC)** → API Center 申请 Developer Token → OAuth2 建 Refresh Token | Developer Token 要填**公司商业信息**过审；默认给 Explorer/Test，要申 Basic |

**共同前提**：两条路线都绕不开「公司层面的商业信息 / 企业验证」，屹恒一个人无法独立完成，必须公司/管理层配合（见 §3 需向公司要的东西）。

---

## 1. Meta / FB —— 自主注册路线需要的新材料

自己建 App 相比 admesh 那套，最大区别是：**App 关联公司自己的 BM**，就能在 BM 内建 System User → 拿**不过期 token**，不再受 60 天长期 token 限制。代价是要过 Business Verification。

### 1.1 需要准备/新建的东西

| 项 | 说明 | 谁来提供 |
|----|------|---------|
| **FB 个人号（开发者身份）** | 建 App 的登录身份。**用有历史、有真实社交活动的老号**，别用新号（新号申开发者极易被限） | 建议用公司老板/管理员本人的 FB 号 |
| **公司 Business Manager (BM)** | App 要关联到公司自己的 BM，广告账户 `act_xxx` 挂在其下 | 公司 BM 管理员 |
| **BM 管理员权限** | 建 App、关联 BM、建 System User、发 token 都需要 | 公司 BM 管理员 |
| **🔴 Business Verification 材料** | 企业验证：营业执照 / 公司法定名称 / 公司地址 / 公司官网 / 验证邮箱或电话。**2025 年多数广告类 Advanced Access 权限都要求先完成企业验证** | 公司/法务/管理层 |
| **App 基本信息** | App 名称、联系邮箱、隐私政策 URL（App Review 需要）、用途说明 | 屹恒可拟，隐私政策 URL 需公司站点 |

### 1.2 最新官方要求核对（2025，与老文档的差异）

- ✅ **开发模式(Development)下，App 管理员/开发者对自己有权限的资产可直接调 API，免 App Review** —— 这条仍成立，是「测 API」阶段能跑通的原因。
- 🔴 **但要「上线(Live) + 读公司真实广告账户 + 拿到像样的调用配额」，现在普遍要求 Business Verification（企业验证）**。官方把控制高配额/System User 配额的审核功能改名为 **Ads Management Standard Access (AMSA)**，明确要走 App Review + 企业验证。（来源：Meta for Developers 官方博客 "Update to Ads Management Standard Access"）
- 🔴 **多数广告相关 Advanced Access 权限需要 Business Verification 才能批**（社区/官方口径一致）。
- ⚠️ **IP 风控仍是 FB 特色最大风险**：Token 获取那一刻要在浏览器登录 FB，**务必在本地电脑操作，不要在服务器上登录 FB**（服务器 IP 会与账号绑定，连带封禁风险）。日常 API 调用只发 HTTPS 到 graph.facebook.com、不带登录态，不涉及此风险。

### 1.3 自主路线步骤（相对 admesh 版的关键差异）

1. 用公司老板/管理员老号登录 developers.facebook.com → Create App → 选 **Business** 类型
2. **关联公司自己的 BM**（这一步是自主路线的核心，admesh 版做不到）
3. 添加 **Marketing API** 产品，拿 App ID + App Secret
4. **完成 Business Verification（企业验证）** ← 新增关键前置，材料见 §1.1
5. BM → Business Settings → Users → **System Users** → 建 System User → 分配 App + 广告账户 + `ads_read` 权限 → **生成 System User Token（不过期，只显示一次，立即保存）**
6. App Review：申请 `ads_read` 等权限（内部只读场景，关联 BM 后 `ads_read` 门槛低；要更高配额走 AMSA）
7. 服务器端拿 Token 写抓取脚本（参考 TT 直连 `scripts/fetch-tiktok.js`），替代看板 XMP 的 FB 部分

### 1.4 官方文档链接（已核对可用）

- Marketing API 总览：https://developers.facebook.com/docs/marketing-api
- Marketing API 快速上手：https://developers.facebook.com/docs/marketing-api/get-started
- Insights API（报表核心）：https://developers.facebook.com/docs/marketing-api/insights
- System User（不过期 token）：https://developers.facebook.com/docs/marketing-api/system-users
- Business Verification（企业验证）：https://www.facebook.com/business/help/2058515294227817
- App Review 说明：https://developers.facebook.com/docs/app-review
- Access Levels（Standard/Advanced Access）：https://developers.facebook.com/docs/graph-api/overview/access-levels
- AMSA 政策更新博客：https://developers.facebook.com/blog/post/2024/（"Ads Management Standard Access" 更新，标题：Update to Ads Management Standard Access）
- Graph API Explorer（测 API 主力）：https://developers.facebook.com/tools/explorer

---

## 2. Google / GG —— 自主注册路线需要的新材料

GG 没有 admesh 那种「借别人 App」的历史包袱，本来就是自己申请。核心是拿 **Developer Token** + 建 **OAuth2 凭据**。

### 2.1 需要准备/新建的东西

| 项 | 说明 | 谁来提供 |
|----|------|---------|
| **Google Ads Manager 账号 (MCC)** | Developer Token 挂在 MCC 上。没有就先建一个 | 公司 Google Ads 管理员 |
| **公司商业信息** | 申请 Developer Token 的 API Access 表要填：公司名称、公司官网 URL、API 联系邮箱、**用途说明** | 公司/管理层 |
| **Google Cloud 项目** | 建 OAuth 2.0 凭据（Client ID / Client Secret）用 | 屹恒可自建 |
| **OAuth 授权 → Refresh Token** | 用公司 Google 账号授权一次，换长期 Refresh Token | 需公司 Google Ads 账号持有人配合授权一次 |

### 2.2 最新官方要求核对（2025，与老文档的差异）

- ⚠️ **默认给的是 Explorer Access**（不是老文档写的「Explorer=生产 2,880 操作/天」那套旧描述）。Explorer 可打生产账户但**有限制**；若无法自动过审，会降级成 **Test Account Access（只能打测试账户）**。
- ✅ 要去掉限制、跑生产 reporting，需申请 **Basic Access**（15,000 操作/天，约 2 工作日）；量大再申 **Standard Access（无限，约 10 工作日）**。**看板 reporting 用途 Basic 足够**。
- ✅ **一家公司通常只发一个 Developer Token** → **先确认公司是否已有**（问技术负责人 / 到已有 MCC 的 API Center 查），有就直接复用，别重复申请。
- ⚠️ 新增 **Brand Verification（品牌验证）** 环节存在（部分场景要求），链接见下。

### 2.3 官方文档链接（已核对可用）

- Developer Token（申请入口 + 说明）：https://developers.google.com/google-ads/api/docs/api-policy/developer-token
- Access Levels（Test/Basic/Standard 区别）：https://developers.google.com/google-ads/api/docs/api-policy/access-levels
- Brand Verification：https://developers.google.com/google-ads/api/docs/api-policy/brand-verification
- OAuth2 配置（建 Refresh Token）：https://developers.google.com/google-ads/api/docs/oauth/overview
- 快速上手：https://developers.google.com/google-ads/api/docs/get-started/introduction
- GAQL 查询（reporting）：https://developers.google.com/google-ads/api/docs/query/overview
- Rate sheet（配额）：https://developers.google.com/google-ads/api/docs/api-policy/rate-sheet

---

## 3. 需要向公司/管理层要的东西（合并清单，一次性问齐）

把 FB + GG 要的公司层信息合并，一次性向管理层申请，别来回催：

**通用商业信息：**
1. 公司法定注册名称
2. 公司官网 URL
3. 公司地址
4. API 联系邮箱

**Meta / FB 专属：**
5. 公司 BM 的管理员是谁？（要他操作建 App / 关联 BM / 建 System User / 发 token）
6. 用哪个 FB 个人号注册开发者？（建议老板/管理员的老号，别用新号）
7. 能否配合完成 **Business Verification（企业验证）**？需要营业执照等材料
8. 公司投 FB 的真实广告账户 `act_xxx` 归属哪个 BM

**Google / GG 专属：**
9. 公司**是否已有 Google Ads Developer Token**？（有就复用，别重申）
10. 公司 Google Ads Manager 账号(MCC)是谁管理？谁能完成 OAuth 授权？

**分工不变**：公司/管理层出商业信息 + 完成企业验证/授权；**屹恒拿到 token/凭据后负责技术对接**（写抓取脚本接入看板，参考 TT 直连模式）。

---

## 4. 相关内部文件

- `docs/meta-api-integration.md` —— admesh 版 FB 对接全过程（已跑通测 API + 刷够 620 次调用，卡在过审/跨 BM token）
- `docs/ad-platform-apis.md` —— 三大平台 API 对接总览（Google/TikTok/Meta 规划段 + 已完成的雅典娜/TikTok）
- `scripts/fetch-tiktok.js` —— TikTok 直连参考实现（FB/GG 接入时照此模式写抓取脚本）
- `scripts/fb-warmup-calls.js` —— FB 刷调用量脚本（自主路线若也要刷配额可复用）
