# TikTok Marketing API 对接文档

> 目标：绕过 XMP 中转，直接从 TikTok Marketing API 拉取投放数据（消耗 / 展示 / 点击 / 转化 / 安装），比 XMP 更实时、更精准，且支持素材级明细。
>
> 状态：✅ **已打通全链路（2026-07-02）**——凭据已配、token 已换、账户信息与报表接口均验证通过。等下午正式开发抓取脚本。

---

## 1. 官方技术文档

| 用途 | 链接 |
|------|------|
| Marketing API 文档总入口 | https://business-api.tiktok.com/portal/docs |
| 开发者门户（My Apps / 授权管理） | https://business-api.tiktok.com/portal |
| 授权与鉴权（Authorization / Authentication） | https://business-api.tiktok.com/portal/docs?id=1738373141733378 |
| 换取 Access Token（oauth2/access_token） | https://business-api.tiktok.com/portal/docs?id=1739702343469058 |
| Reporting API（报表总览） | https://business-api.tiktok.com/portal/docs?id=1738864915188737 |
| Basic Report（基础报表：消耗/效果） | https://business-api.tiktok.com/portal/docs?id=1740302848100353 |
| 同步报表 get（integrated/get） | https://business-api.tiktok.com/portal/docs?id=1740302848100353 |
| 支持的指标（Metrics）与维度（Dimensions） | https://business-api.tiktok.com/portal/docs?id=1751443967255553 |
| Advertiser info（广告主信息） | https://business-api.tiktok.com/portal/docs?id=1739593083610113 |
| Rate Limit（限频说明） | https://business-api.tiktok.com/portal/docs?id=1737172488964097 |

> 注：门户文档为 JS 渲染，`web_fetch` 抓不到正文；需要查具体字段时在浏览器打开对应 id 页面。

---

## 2. 凭据体系（已配置）

| 凭据 | 值 / 位置 | 有效期 |
|------|-----------|--------|
| App ID | `7644778357107720209`（也存于 `/etc/environment` 的 `TIKTOK_APP_ID`） | ✅ 永久 |
| App Secret | `/etc/environment` → `TIKTOK_APP_SECRET` | ✅ 永久 |
| Access Token | `/etc/environment` → `TIKTOK_ACCESS_TOKEN` | ✅ **不过期**（Marketing API access token 长期有效，无需刷新） |
| auth_code | 授权回调临时返回 | ❌ 1 小时、一次性（已用掉，无需保留） |

- 读取方式：脚本里 `source /etc/environment` 后用 `$TIKTOK_ACCESS_TOKEN` 等。
- ⚠️ Access Token 等同长期密钥，勿写进 git、勿打日志明文。已确认三个变量都在 `/etc/environment`。
- 如需撤销：调用 `POST /open_api/v1.3/oauth2/revoke_token/`。

---

## 3. 授权流程与 URL（已完成，留档备查）

### 3.1 广告主授权 URL（Marketing API，拉投放数据用的就是这个 ✅）

```
https://business-api.tiktok.com/portal/auth?app_id=7644778357107720209&state=your_custom_params&redirect_uri=https%3A%2F%2Fapi.admesh.ai%2Foauth%2Ftiktok%2Fcallback
```

- redirect_uri（解码后）：`https://api.admesh.ai/oauth/tiktok/callback`（admesh 侧回调服务，非本机）
- 广告主点「同意」后，TikTok 会带 `auth_code` 回调到该地址，形如：
  `https://api.admesh.ai/oauth/tiktok/callback?auth_code=XXX&code=XXX&state=your_custom_params`
- admesh 回调服务会报 `invalid_oauth_state`（它自身 state 校验），**不影响**我们——只需从 URL 里取 `auth_code` 即可。

### 3.2 TikTok 账户授权 URL（Login Kit / Content Posting API，与投放数据无关 ❌）

```
https://www.tiktok.com/v2/auth/authorize?client_key=7644778357107720209&scope=user.info.basic,...,video.publish,video.upload,...&redirect_uri=https%3A%2F%2Fadmesh.ai%2Fapi%2Fintegrations%2Ftiktok%2Faccount-holder%2Fcallback
```

- 这是给创作者/内容账号授权的（读用户信息、发视频等），**不是 Marketing API**。拉广告报表用不上，仅记录。

### 3.3 换 Access Token（已成功执行）

```bash
source /etc/environment
curl -s -X POST "https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"${TIKTOK_APP_ID}\",\"secret\":\"${TIKTOK_APP_SECRET}\",\"auth_code\":\"<AUTH_CODE>\",\"grant_type\":\"authorization_code\"}"
```

- 返回体含 `access_token` + `advertiser_ids`（授权的全部广告主）+ `scope`。
- ⚠️ 换 token 用 **JSON body**，字段是 `app_id` / `secret`（不是 `client_key` / `client_secret`），不带 `redirect_uri`。

---

## 4. 已验证的核心端点

Base URL：`https://business-api.tiktok.com/open_api/v1.3`
鉴权：请求头 `Access-Token: <TIKTOK_ACCESS_TOKEN>`（report/advertiser 接口用 header；换 token 例外用 body）。

### 4.1 广告主信息 `GET /advertiser/info/`

```bash
source /etc/environment
curl -s -G "https://business-api.tiktok.com/open_api/v1.3/advertiser/info/" \
  -H "Access-Token: ${TIKTOK_ACCESS_TOKEN}" \
  --data-urlencode 'advertiser_ids=["7254799851504943106"]' \
  --data-urlencode 'fields=["advertiser_id","name","currency","status","company","timezone"]'
```
- 已验证返回：name、currency（USD）、timezone（Asia/Shanghai）、company（如「北京临场感科技有限公司」「广州符柴商贸有限公司」）。

### 4.2 投放报表 `GET /report/integrated/get/`（核心）

```bash
source /etc/environment
curl -s -G "https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/" \
  -H "Access-Token: ${TIKTOK_ACCESS_TOKEN}" \
  --data-urlencode 'advertiser_id=7541289778224627728' \
  --data-urlencode 'report_type=BASIC' \
  --data-urlencode 'data_level=AUCTION_ADVERTISER' \
  --data-urlencode 'dimensions=["advertiser_id","stat_time_day"]' \
  --data-urlencode 'metrics=["spend","impressions","clicks","conversion"]' \
  --data-urlencode 'start_date=2026-06-28' \
  --data-urlencode 'end_date=2026-07-01' \
  --data-urlencode 'page_size=100'
```

参数要点：
- `report_type`：`BASIC`（基础报表，消耗/效果）
- `data_level`：`AUCTION_ADVERTISER`（账户级）/ `AUCTION_CAMPAIGN` / `AUCTION_ADGROUP` / `AUCTION_AD`（越细越接近素材级）
- `dimensions`：按天用 `stat_time_day`；配合 level 加 `campaign_id`/`adgroup_id`/`ad_id`
- `metrics`：`spend`,`impressions`,`clicks`,`conversion`（还可加 `ctr`,`cpc`,`cpm`,`real_time_conversion` 等）
- 日期范围查询，最长跨度受限（大范围用异步报表 `report/task/*`）

已验证真实回样（`省广_Luma_iOS_1_wcx` = `7541289778224627728`）：

| 日期 | 消耗($) | 展示 | 点击 | 转化 |
|------|--------|------|------|------|
| 2026-06-28 | 2473.59 | 203,655 | 1,548 | 85 |
| 2026-06-29 | 2580.76 | 254,868 | 1,938 | 107 |
| 2026-06-30 | 2583.21 | 267,821 | 1,791 | 63 |
| 2026-07-01 | 2579.12 | 302,734 | 2,277 | 81 |

- 无投放的账户返回 `data.list: []`（正常）。
- 响应统一格式：`{"code":0,"message":"OK","data":{...}}`，`code != 0` 即失败，`message` 带原因。

---

## 5. 授权的广告主账户

- **共 148 个账户**（access_token 返回的 advertiser_ids），已成功拉取 140 个名称。
- 主体：北京临场感科技、广州符柴商贸等；命名多为「省广_<产品>_<平台>_<序号>_<投手缩写>」。
- 产品分布（粗略计数）：Romi 26 / 待使用 24 / Dora 15 / Luma 14 / Doni 13 / AI 11 / Jovia 9 / Haven 8 / PWA 8 / 其他 12。
- 状态：正常投放（ENABLE）119 个，受限（LIMIT）21 个。
- **完整清单见** → [`docs/tiktok-advertiser-accounts.md`](tiktok-advertiser-accounts.md)

> 待确认（开工前问屹恒）：是全部 148 个账户都纳入抓取，还是只挑他负责的产品线？投手缩写（syh/wcx/zmf/mcy/ymt/lh/cyl/zmiao/zjc/wvv 等）→ 投手真名的映射需要补一份。

---

## 6. 相比 XMP 的优势

- 消耗数据**直连 TikTok**，不经 XMP 中转，更精准。
- **无缓存延迟**（XMP 缓存 30 分钟）。
- **素材级明细**：可下钻 campaign / adgroup / ad，拿创意信息。
- 安装/转化更准（TikTok 原生归因，非 MMP 中转）。
- **Access Token 不过期**：不用像 XMP 每次算 sign。
- 同步 + 异步双模式，大数据量可异步拉取不怕超时。

---

## 7. 下午开工待办（TODO）

1. **确认账户范围**：全部 148 还是指定产品线？确定后设计脚本入参。
2. **写抓取脚本** `scripts/fetch-tiktok.js`（对标 `fetch-xmp-api.sh`）：
   - 入参 `[start_date] [end_date] [advertiser_ids?]`
   - 批量遍历 advertiser_ids，`report/integrated/get` 拉日粒度消耗
   - 输出 JSON，字段对齐现有 dashboard 数据流
   - 处理限频（Rate Limit）、空数据、分页（page/page_size）
3. **产品映射**：advertiser_id → 产品名（对齐雅典娜/AF 的对外产品名），投手缩写 → 真名。
4. **接入 dashboard**：逐步用 TikTok 直连替换 XMP 的 TT 渠道部分（先并行跑、比对差异，再切换）。
5. **大范围历史数据**：评估是否需要异步报表（`report/task/create` + 轮询）。

---

*凭据敏感，本文档只写位置不写明文 secret/token。创建于 2026-07-02，全链路验证通过。*

---

## 8. Smart+ 广告接口（2026-07-02 摸清，来自官方 SDK）

> 现有真实广告是 Smart+（`campaign_automation_type=UPGRADED_SMART_PLUS`）。**普通 `campaign/create` 传 automation_type 会被忽略、降级成 MANUAL**，必须走 Smart+ 专用接口。
> 字段定义来源：github.com/tiktok/tiktok-business-api-sdk（js_sdk/docs/SmartPlus*）。

**三层专用接口（均已实测存在、有写权限）：**
- `POST /open_api/v1.3/smart_plus/campaign/create/`
- `POST /open_api/v1.3/smart_plus/adgroup/create/`
- `POST /open_api/v1.3/smart_plus/ad/create/`
- 状态更新：`smart_plus/{campaign,adgroup,ad}/status/update/`；查询 `smart_plus/{...}/get/`

**Campaign 层必填**：`advertiser_id`, `campaign_name`, `objective_type`, `request_id`(幂等串)。
常用可选：`app_promotion_type`, `budget_mode`, `budget`, `budget_optimize_on`, `campaign_type`, `operation_status`, `roas_bid`, `is_advanced_dedicated_campaign`。
（注意：Smart+ campaign 无 `campaign_automation_type` 入参——走这个接口本身就是 Smart+。）

**Ad Group 层必填**：`advertiser_id`, `campaign_id`, `adgroup_name`, `billing_event`, `optimization_goal`, `promotion_type`, `schedule_type`, `schedule_start_time`, `targeting_spec`, `request_id`。
出价：`bid_type`, `conversion_bid_price`(AEO CPA), `roas_bid`(VO), `deep_bid_type`, `optimization_event`。
定向包在 `targeting_spec{}`：`location_ids`, `gender`, `age_groups`, `languages`, `operating_systems`, `spending_power` 等。

**Ad 层必填**：`advertiser_id`, `adgroup_id`, `ad_name`, `request_id`。
素材：`creative_list[].creative_info{ ad_format(必填), identity_id, identity_type, video_info{video_id}, image_info[{web_uri}] }`。
文案/CTA：`ad_text_list[{ad_text}]`, `call_to_action_list[{call_to_action}]`, `landing_page_url_list`, `deeplink_list`。
