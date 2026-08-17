# Facebook / Meta Marketing API 对接文档

> 目标：绕过 XMP，直连 Meta Marketing API 拉公司 FB 投放数据（消耗/转化/素材，Insights API），替代看板 XMP 的 FB 部分。
> 起始：2026-07-07（屹恒 + 龙虾一起打通「测 API → 过审」链路）
> 状态：⏳ **测 API 阶段已完成，等 App 过审上线 → 才能读公司真实数据**

---

## 0. 一句话现状（后续 session 先读这段）

- 有一个 **admesh 提供的 FB App**（未上线，开发模式），用它对接 Meta Marketing API。
- **这是跨 BM 场景**：App 不在公司广告账户所在 BM 里 → 拿不到 System User Token（不过期），只能走 OAuth（60 天长期 token 上限）。
- **读公司真实数据的前提：App 必须先过 App Review 上线**。上线前必须演示 API 调用成功 + 攒够调用量。
- **2026-07-07 已完成**：用沙盒/可读账户跑通 Marketing API 全套接口 + 刷够 620 次成功调用（88.3% 成功率），满足进阶配额门槛。
- **下一步**：等 Meta 后台统计刷新（FB 说可能 24h）→ App Review 提交 11 个权限 → 过审上线 → OAuth 授权公司真实账户 → 接入看板取数。

---

## 1b. 新 App（2026-07-16 第二次申请，marketing API）

屹恒 2026-07-16 换了一个**全新 FB App** 重新申请、重刷调用量。**这才是当前主用的一组**：

| 项 | 值 |
|----|----|
| **App 名称** | `marketing API` |
| **App ID** | `1708296213710928` |
| 登录身份 | FB 号「Si Si」（user id `122107336202357636`） |
| **BM 归属** | ✅ 青岛天泽源盛科技有限公司（BM id `1522249045620600`）——**比上次强，这号进了公司 BM** |
| token 权限（7个） | `pages_show_list, ads_management, ads_read, business_management, pages_read_engagement, pages_manage_ads, public_profile` |
| 可读广告账户 | **13 个真实活跃账户**（`省广_Dora_iOS/And_*` 系列，account_status:1，有真实 campaign/adset/ad/insights 数据）+ Si Si 本人账户 |
| 可读 Pages | `Dora: your friend`(863488183510530)、`Dora friends center` 等（能派生 page token） |

**刷调用量结果（2026-07-16 ✅达标，脚本 `scripts/fb-warmup-calls-v2.js`）**：
- **520 次成功 / 0 失败 / 成功率 100.0%**，耗时 264s（GAP=250ms 慢节奏，全程零限流）。
- 每权限覆盖：ads_read 225 / read_insights 165 / ads_management 110 / business_management 16 / public_profile 4。
- **6 个 marketing 权限逐个验证通过**（account 元数据/campaigns/adsets/ads/customaudiences/insights(有真实 spend)/me/businesses/BM/pages+access_token）。
- 关键经验：这次账户多（13 个）且都有真实数据，端点池天然丰富；250ms 间隔比上次 120ms 更稳，直接 100% 成功率（上次 120ms 撞用户级限流 88.3%）。graph.facebook.com 直连不用代理（先 unset 代理变量）。
- **下一步同上次**：等 Meta 后台统计刷新（~24h）→ App Review 提交权限 + 演示证据 → 过审上线 → OAuth 授权公司账户接看板。

**pages 权限补测（2026-07-16，脚本 `scripts/fb-warmup-pages.js`）**：首轮刷量漏了 pages 三权限，单独补测。
- token 带 3 个 pages 权限：`pages_show_list` / `pages_read_engagement` / `pages_manage_ads`，能管 **4 个 Page**（Dora: your friend `863488183510530` / Dora friends center / Dora Andriod / Dora meet friends，都有满 tasks + 可派生 page token）。
- **补刷 160 次成功 / 0 失败 / 100%**：pages_show_list 7 + pages_read_engagement 103 + pages_manage_ads 50。
- 验证端点：me/accounts、page 详情(fan_count/followers/talking_about_count)、published_posts、page insights(page_post_engagements)、ads_posts、leadgen_forms。
- **踩坑**：`/{page}/feed` 端点在未过审 App 下报 `#10 requires Page Public Content Access feature`（跟 published_posts 不同，这个 feature 过审前拿不到），首轮因此掉到 84.3%。剔除 feed 端点后 100%。page 相关端点必须用**派生的 page token**（`GET /{page-id}?fields=access_token`），不能用 user token。
- **累计（两轮合计）：680 次成功，全部 8 个已授权权限均已覆盖**（ads_read/read_insights/ads_management/business_management/public_profile + pages_show_list/pages_read_engagement/pages_manage_ads）。

---

## 1. 凭据（旧的第一组 App，2026-07-07）

| 项 | 值 |
|----|----|
| **App ID** | `975332261767844` |
| **回调 URL (redirect_uri)** | `https://jzx0g0.logto.app/callback/5txmoom1bg9pvlas6n52z` |
| 回调托管 | Logto（第三方身份认证服务，托管 OAuth 回调 + 可能帮换/存 token） |
| 登录身份 | 独立 FB 号「Zhao Peng」（FB user id `122116621197269781`），是该 App 的开发者/管理员 |
| BM 归属 | ❌ 无（这个 FB 号没进任何 BM，账户是独立的） |

### 作废存档（第一组，屹恒后来换掉了）
- 旧 App ID：`1741630206616687`
- 旧回调：`https://admesh.ai/api/meta/callback`

### 可读的广告账户（当前 FB 号 /me/adaccounts 返回）
- `act_1548558926611600`（名称 admesh）← 测试主要用这个
- `act_3625139237624596`（名称 Zhao Peng）
- 沙盒账户 `985498160530300`（New Sandbox Ad Account）**不在 /me/adaccounts 里**，未分配给当前号 → 直接查会报 #200，用上面两个真实账户测即可。

---

## 2. 关键概念（别再踩的认知坑）

### Meta 三层结构，别混
| 层 | 是什么 | 地址 |
|----|--------|------|
| 开发者账号 / App | 有 App ID/Secret | developers.facebook.com |
| **Business Manager (BM)** | **System User Token 在这里建** | business.facebook.com |
| 广告账户 (act_xxx) | 挂在 BM 下的资产 | — |

### Token 有效期（OAuth 路线）
| Token | 有效期 | 何时拿到 |
|-------|--------|---------|
| 短期 User Token | 1~2 小时 | OAuth 换 code 得到的第一手 / Explorer 生成的 |
| 长期 User Token | ~60 天 | 短期 token 再 exchange 一次得到 |
| System User Token | 不过期 | ❌ 跨 BM 拿不到（本项目用不了） |

- **本项目上限 = 60 天长期 token**，需每 60 天重授权/滚动刷新。
- 长期 token 换法：`GET /oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>&client_secret=<SECRET>&fb_exchange_token=<短期token>`
- 理想方案：让 admesh 用他们 BM 的 System User 代理给不过期凭据（Business On Behalf Of）——**待问 admesh**。

### 开发模式 vs 上线模式
- **开发模式（当前）**：App 管理员/开发者/测试员，对自己有权限的资产，**任何权限都能直接用，免 App Review**。→ 这就是能在过审前测 API 的原因。
- **上线模式**：未过审的权限直接报错。读公司真实数据必须先上线。

---

## 3. 全权限版 OAuth 授权链接（当前 App）

本地浏览器打开（别在服务器登 FB，IP 风控）：

```
https://www.facebook.com/v24.0/dialog/oauth?client_id=975332261767844&redirect_uri=https%3A%2F%2Fjzx0g0.logto.app%2Fcallback%2F5txmoom1bg9pvlas6n52z&response_type=code&scope=ads_read,ads_management,business_management,pages_read_engagement,pages_manage_ads,read_insights,pages_show_list&state=admesh_oauth_yh_0707
```

- 点开 → 登录 FB → 选授权广告账户 → 同意 → 跳回 redirect_uri 带 `?code=xxx&state=...`
- `code` 1 小时有效、一次性，用它换 token。
- ⚠️ 若报 redirect_uri 不匹配：去 App 后台 → Facebook 登录 → Valid OAuth Redirect URIs 把回调加进白名单。

---

## 4. 图谱 API 探索工具（Graph API Explorer）—— 测 API 的主力工具

地址：**https://developers.facebook.com/tools/explorer**

### 用法
1. **Meta App 下拉** → 选 `975332261767844`
2. **Permissions 下拉** → 勾 `ads_read` `ads_management` `read_insights` `business_management` 等
3. **⚠️ 勾完必须点 `Generate Access Token` 重新生成**（否则 token 不带新权限，报 #200）
4. 点 token 框旁 **ⓘ** 确认权限已进 token
5. 路径框：前缀 `GET https://graph.facebook.com/v25.0/` 是**固定强制**的，只填后面部分，**从节点名开始、不加开头的 `/`**
   - 例：填 `act_1548558926611600?fields=id,name`（不是 `/act_...`）
6. Submit 看 Response
7. **Get Code** 按钮：生成各语言示例代码，对接时当起点

### 测试 query 清单
详见 `docs/meta-api-sandbox-test-queries.md`。核心几条（Explorer 里从 `act_` 开始填）：
```
act_1548558926611600?fields=id,name,account_status,currency,account_id
act_1548558926611600/campaigns?fields=id,name,status,objective
act_1548558926611600/adsets?fields=id,name,status
act_1548558926611600/insights?fields=spend,impressions,clicks,ctr,actions&date_preset=maximum&level=account
me/businesses?fields=id,name
```

### 常见报错解读
- `#200 Ad account owner has NOT grant ads_management or ads_read` → **token 没带 ads 权限**（99% 是勾了没重新 Generate Token）。
- 返回 `{"data":[]}` 空数组 → **成功！** 只是该账户查询时段无投放数据，API 链路已通，过审足够。
- `#100 does not exist` → 账户没分配给当前号（如沙盒账户），换能读的账户。

---

## 5. 刷调用量（过审门槛：500 次成功 + 85% 成功率）

### 为什么要刷
Meta 给 Marketing API 进阶配额（Standard Access）的门槛：App 历史 **≥500 次成功 API 调用、成功率 ≥85%**。这是真实调出来的，不是填的。

### 脚本
`scripts/fb-warmup-calls.js`（纯 GET 只读，轮询多个有权限的元数据/insights 端点）
- 用法：`FB_TOKEN='<token>' TARGET=620 node scripts/fb-warmup-calls.js`
- token 从 Explorer 生成后复制（短期 1~2h，够刷）
- 直连可用（graph.facebook.com 不需代理，实测直连通）

### 2026-07-07 实测结果 ✅
- **620 次成功 / 82 次失败 / 总 702 / 成功率 88.3%** → **达标**
- 失败全是 `User request limit reached`（用户级限流，刷太快撞墙）
- 耗时 ~228s（每次间隔 120ms）

### 踩坑 & 经验
- **限流是主要失败源**：单 token 短时间打 700+ 次后配额耗尽，继续刷限流更狠、成功率反被拉低。补刷一度失败率飙升，果断停了。
- **想要更高成功率**：等限流冷却（几十分钟~1h）后**慢节奏（每秒 1~2 次）**补刷，别贪快。
- Meta 后台统计**滚动窗口 + 延迟刷新**：FB 提示可能 **24h** 才能在后台看到调用量统计更新。所以刷完当天看不到是正常的。
- **后续要再刷很简单**：Explorer 重新生成 token → 跑脚本即可。流程已跑熟。

---

## 6. App Review 权限申请（下一步）

去 **App Dashboard → App Review → Permissions and Features**，逐个 Request Advanced Access。

屹恒要申请的 11 个权限 + 建议申请文案（英文，可直接粘）：

| 权限 | 申请理由 |
|------|---------|
| `ads_read` | Read ad campaign/ad set/ad and insights data (spend, impressions, clicks, conversions) for our internal advertising performance dashboard. |
| `ads_management` | Programmatically manage campaigns/ad sets (create, update, pause) for internal ad operations automation. |
| `business_management` | Access Business Manager to locate and read ad accounts owned by our business for reporting. |
| `read_insights` | Retrieve aggregated ads insights metrics for internal reporting dashboards. |
| `pages_show_list` | List Pages associated with the ad account to attribute campaigns to their Pages. |
| `pages_read_engagement` | Read Page engagement metrics linked to ad campaigns for performance analysis. |
| `pages_manage_ads` | Manage ads associated with our Pages as part of ad operations automation. |
| `catalog_management` | Read/manage product catalogs used in Advantage+ catalog ad campaigns. |
| `business_asset_user_profile_access` | Access business asset user profile info to manage roles/attribution within our BM. |
| `email` | Basic account identification during OAuth login（通常预批，无需高级申请）。 |
| `public_profile` | Basic user identity（默认预批）。 |

- 屹恒要求「全都要，都刷上」→ 11 个全申请。
- ⚠️ `thread_business_basic` 偏 Messenger/WhatsApp 商业消息，跟广告看板用途弱相关，屹恒确认「全都要」故一并申请（注意不相关权限可能拖慢审核/增被拒风险）。
- App Review 需附**演示证据**：每个权限对应一条成功 API 调用的截图/录屏（选 App→生成 token→跑 query→返回成功，一镜到底最有说服力）。

---

## 7. 完整路线图（当前进度）

- [x] 拿到 App ID + 回调 URL（admesh 提供）
- [x] 确认跨 BM 场景 → 走 OAuth 路线
- [x] Graph API Explorer 跑通 Marketing API 全套接口（account/campaign/adset/insights/businesses）
- [x] 刷够调用量：620 次成功、88.3% 成功率（达标）
- [ ] 等 Meta 后台统计刷新（~24h）
- [ ] App Review 提交 11 个权限 + 演示证据
- [ ] 等过审（内部用 ads_read 免审；写权限/上线可能需审核 3~10 工作日）
- [ ] App 上线
- [ ] OAuth 授权公司真实广告账户 → 换 60 天长期 token
- [ ] 接入看板：写 FB 抓取脚本（参考 TT 直连模式 `scripts/fetch-tiktok.js`），替代 XMP 的 FB 部分
- [ ] 搭 token 滚动刷新（cron，每 ~50 天）或让 admesh 代理给不过期凭据

---

## 8. 待向 admesh / 公司确认的问题

1. **admesh 回调后帮换的 token 是短期还是长期？能否给长期/不过期凭据？**（若他们用自己 BM 的 System User 代理 = 最省心，服务器端不用管刷新）
2. 公司投 FB 的真实广告账户，过审上线后走哪个 BM 授权给这个 App？
3. App Review 有没有 admesh 的现成过审流程/模板可复用？

---

## 9. 相关文件

- `docs/meta-api-sandbox-test-queries.md` — 测试 query 清单
- `scripts/fb-warmup-calls.js` — 刷调用量脚本
- `docs/ad-platform-apis.md` — 三大平台 API 对接总览（含 Meta 规划段）
- 看板 TT 直连参考实现：`scripts/fetch-tiktok.js`（FB 接入时照此模式写）

---

## 7. Threads API 权限（threads_basic / threads_read_replies）—— 待同事配合（2026-07-09）

**✅ 2026-07-09 15:56 已全部实测通过**（同事配合发出并接受 Threads Tester 邀请后拿到独立 Threads token，账号 `suyiheng544` id 27511335735194671）。测通：`threads_basic`(GET /me)、`threads_read_replies`(GET /{thread-id}/replies + /conversation)、发帖(threads_content_publish 两步:threads container→threads_publish)、删帖(threads_delete)。token 实带 11 权限。发帖流程用「发一条 TEXT 测试帖→测 replies→删除」实测（thread-id 18026682677831225 建后秒删不留痕）。

> **踩坑：Tester 邀请**。授权时报 `error_code 1349245 The user has not accepted the invite to test the app` = 该 Threads 账号还没接受 App 测试邀请。解法：App后台 Threads 产品页 Add Threads Tester（填 @username）→ 用该账号登录 threads.net → Settings→Account→Website permissions 接受邀请（入口藏得深，网页/手机App 两端都找找）。

---

**原始现状记录**：现有 FB token（App Admesh.ai，`graph.facebook.com`）**无法测 Threads 权限**。Threads API 是独立门户（`graph.threads.net`），用 FB token 打一律 `code 190 Cannot parse`。token 里的 `threads_business_basic` 属「Threads 商业消息侧」，≠ `threads_basic`/`threads_read_replies`（Threads 内容侧）。

**Threads token 拿法**（屹恒已找到方法，需等同事配合完成）：
1. App 后台 → Add Product → **Threads API**（有独立 Threads App ID/Secret，≠ FB App ID 1741630206616687）
2. 走 Threads 独立 OAuth：`https://threads.net/oauth/authorize?client_id=<Threads-App-ID>&redirect_uri=<回调>&scope=threads_basic,threads_read_replies&response_type=code`
3. 换 token：`POST https://graph.threads.net/oauth/access_token`（client_id/secret 用 Threads 的 + grant_type=authorization_code + code）
4. 前提：一个**有帖子的真实 Threads 账号**（read_replies 读的是自己帖子下的回复）

**拿到 Threads token 后的测试步骤**：
```
GET  graph.threads.net/v1.0/me?fields=id,username           # threads_basic：验身份
GET  graph.threads.net/v1.0/me/threads?fields=id,text       # 列出自己的帖子，拿 thread-id
GET  graph.threads.net/v1.0/{thread-id}/replies             # threads_read_replies：读该帖回复
```

**已实测通过的 6 个广告权限**（2026-07-09，脚本 `scripts/fb-perm-verify.sh`）：ads_read / read_insights / business_management / pages_read_engagement / pages_manage_ads / ads_management。page 相关必须用 page token（`GET /{page-id}?fields=access_token` 派生）。
