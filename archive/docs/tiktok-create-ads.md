# TikTok Smart+ 从 0 建广告（Marketing API）

> 目标：用 TikTok Marketing API 从 0 建出真正的 **Smart+** 广告（campaign→adgroup→ad 三层），严格复刻已有优质广告的结构，全程暂停态（DISABLE），跑通后由投手手动开投。
>
> 状态：✅ **全链路已打通（2026-07-02）**——Jovia And 首条 Smart+ AEO 广告成功建成（含 dark_post、10 素材、BC identity）。已固化为一键脚本，可复用到其它安卓产品。
>
> 关联文档：[`docs/tiktok-marketing-api.md`](tiktok-marketing-api.md)（拉数据/报表）、[`docs/tiktok-advertiser-accounts.md`](tiktok-advertiser-accounts.md)（148 个授权账户清单）。

---

## 0. 🚀 一键操作手册（SOP，照着做即可）

> **场景**：屹恒说「上新素材投 TT 安卓广告」——把某产品/榜单上表现好的素材，换皮到目标安卓产品，建 VO + AEO 广告。**按下面 5 步走，不用重新摸索。**

### 需要问屹恒确认的 4 件事
1. **目标产品**（如 Doni And / Jovia And）——决定 advertiser_id / app_id / identity（见 §3 表）
2. **哪些素材**（从哪个榜单选、选几个）——通常从 dashboard 素材面板 FB 表按 `newUserRevenue` 取 top N
3. **出价**：VO 的 roas_bid（如 0.3）+ AEO 的 CPA（如 16 美元）
4. **预算 + 是否直接开投**：每 campaign 日预算（如 $50）；`op_status` = `ENABLE`(真实花钱) 还是 `DISABLE`(暂停验证)。**ENABLE 是真实花钱，务必明确确认。**

### Step 1 — 选素材 + 定「同名寻址」目标名 ★核心
- 从 dashboard 素材面板 FB 表取 top 素材的**完整原始名**（含产品 token + 序号 + `.mp4`，如 `转_1005_KN_Romi_暗示动作_6.mp4`）。
- **把产品 token 换成目标产品**：`转_1005_KN_Romi_暗示动作` → `转_1005_KN_Doni_暗示动作`。
- ⚠️ **这是“同名寻址”，不是“借文件”**：用改名后的名字回 XMP 搜，拿到的是 **目标产品自己那一套同款素材**的链接（每个产品各投一套，名字同、file_url 不同），**不是**把原产品的文件借给目标产品。
- **同名搜索（XMP）**：`POST /v1/media/material/list`，body `{material_name:["完整名含产品+序号+.mp4"], page, page_size}`（material_name 是**数组**，必须带 `.mp4`，响应在 `data.data[]`）。序号未知就遍历 `_1`~`_12`。
- **注意两种情况**：① 新产品（如 Jovia）可能**缺部分同款** → 缺的跳过（或问屹恒怎么补）；② 少数素材 XMP 里**不分产品、就一个共用文件**（用任何产品名搜都返回同一 material_id），直接用即可。
- 工具：同名寻址解析器参考下面 Step 的脚本片段（把“挖掉产品 token → 拼目标产品 → 精确搜”写成循环即可）。

### Step 2 — 上传素材到 TT（URL 直传，零下载）
- XMP 返回的 `file_url`（`xmp-material.mobvista.com/...`，公网无鉴权 HTTP 200）直接丢给 TT，不用本地下载。
- `POST file/video/ad/upload`，`{advertiser_id, upload_type:"UPLOAD_BY_URL", video_url:<file_url>, file_name:<改名后>}` → 返回 `video_id`。
- 封面：`GET file/video/suggestcover?advertiser_id=&video_id=` → `data.list[0].id` 就是 `image_info.web_uri`（字段名是 `id` 不是 web_uri）。**刚上传要等转码**，cover 可能先取不到，重试几次（等 ~10s）。
- ⚠️ **video_id 按 advertiser 隔离**，换产品/账户必须重新上传，不能跨账户复用。

### Step 3 — 生成 config 并建广告
- 把上传好的素材拼成 `materials:[[video_id, cover_web_uri, file_name],...]`。
- 每个产品建两个 config（VO + AEO）：
```json
{"advertiser_id":"<目标产品>", "app_id":"<目标产品>", "identity_id":"<目标产品>",
 "op_status":"ENABLE",  "opt_type":"VO", "bid":0.3, "campaign_name":"<产品> And_syh_YYMMDD_VO_N",
 "materials":[["video_id","cover_web_uri","file_name"], ...]}
```
  AEO 版改 `"opt_type":"AEO", "bid":16, "campaign_name":"..._AEO_N"`。
- 跑脚本：`source /etc/environment && python3 scripts/tiktok-create-android-ad.py cfg.json`（一次一个 config，预置已锁死 Smart+/dark_post/定向/文案等）。

### Step 4 — 验证（★用 campaign_ids 读，别用 ad_ids）
- **create 响应打印的“素材数=N”就是权威值**，这是实际挂上的。
- 要复核就按 `filtering.campaign_ids` 查 `smart_plus/ad/get`，再按 `ad_name` 找自己的 ad。**千万别用 `filtering.ad_ids`**——它返回的常是账户里另一条无关 ad，素材数乱跳（看上去像被污染其实是读错了广告，别被坑）。
- 建完 adgroup 进 `ADGROUP_STATUS_AUDIT`（审核）属正常，过审后自动跑量。

### Step 5 — 收尾
- 清理临时文件（`scripts/_tt_*`、`/tmp/*.json` 等过程产物）。
- 向屹恒汇报：每条广告的 campaign_id、素材数、出价、预算、状态（ENABLE/审核中）。
- 提醒屹恒去后台按广告名搜一下确认素材是对应产品自己的版本。

---

## 1. 核心结论（先看这个）

**建安卓广告，只有 4 类变量要改，其余全部锁死**（严格复刻源 `Jovia And_syh_260605_VO_1` 的 Smart+ 结构）：

### 4 个变量（每次要问/要定的）
1. **命名** — campaign/adgroup/ad 三层同名，格式 `{产品} {平台}_{投手}_{YYMMDD}_{优化类型}_{序号}`（如 `Jovia And_syh_260702_AEO_1`）
2. **优化事件** — AEO 还是 VO
   - AEO：`optimization_goal=IN_APP_EVENT` + `optimization_event=ACTIVE_PAY` + `deep_bid_type=AEO` + `conversion_bid_price=<CPA$>`
   - VO：`optimization_goal=VALUE` + `deep_bid_type=VO_MIN_ROAS` + `roas_bid=<如0.3>`
3. **出价** — AEO 填 CPA 美元数（如 16）；VO 填 roas_bid（如 0.3）
4. **素材** — 哪几个视频：`[[video_id, cover_web_uri, file_name], ...]`（封面用 `file/video/suggestcover` 取）

### 锁死不变的部分（全 App 通用）
- **Campaign**：`objective_type=APP_PROMOTION` / `app_promotion_type=APP_INSTALL` / `campaign_type=REGULAR_CAMPAIGN` / 动态日预算 $50（源是400）/ CBO（`budget_optimize_on`）/ Smart+
- **Ad Group**：`promotion_type=APP_ANDROID` / 自动版位（TikTok+Pangle）/ `billing_event=OCPM` / `bid_type=BID_TYPE_CUSTOM` / 归因 7 天点击·1 天展示 / CBO(INFINITE 预算) / 定向=美国(`6252001`)·仅男·全年龄·英语·Android
- **Ad**：1 个广告挂多素材（`creative_list` 数组）/ identity=该产品 BC_AUTH_TT / **`ad_configuration.dark_post_status=ON`（仅作为广告展示，不发主页）** / CTA=`DOWNLOAD_NOW` / 增强策略 `[TRANSLATE_AND_DUB, VIDEO_QUALITY, MUSIC_REFRESH]`
- **3 条固定文案**（全产品通用）：`Meet girls online!` / `Dating in your town` / `Find the love you're looking for`
- **全程 `operation_status=DISABLE`**（暂停态，跑通后用户手动开投）

---

## 2. 一键脚本

`scripts/tiktok-create-android-ad.py` —— 传一个 config.json（含 4 变量 + 账户/app/identity），自动建 campaign→adgroup→ad 三层，全暂停态。

```bash
source /etc/environment && python3 scripts/tiktok-create-android-ad.py cfg.json
```

config.json 字段：`advertiser_id, app_id, identity_id, opt_type(AEO/VO), bid, campaign_name, [adgroup_name], [ad_name], materials[[vid,cover,name]...]`

### ✅ VO 分支已验证（2026-07-03）
- **VO(D0 ROAS) 已跑通**：Jovia And `Jovia And_syh_260703_VO_1`（campaign `1869680589167026` / adgroup `1869680589171874` / ad `1869680592158977`，D0 ROAS 0.3，10 素材，全 DISABLE）。
- **★ 关键坑：VO 必须带 `vbo_window=ZERO_DAY`（=D0 ROAS）**。不带会默认 D7，而 **TikTok 已下线「7 日目标 ROAS」策略**，新建直接报 `40002 the day 7 target ROAS bidding strategy is no longer available`（这个报错只要 optimization_goal=VALUE 且 vbo_window 非 ZERO_DAY 就触发，跟 deep_bid_type 具体值无关，很迷惑）。
- VO 正确字段组合：`optimization_goal=VALUE` / `deep_bid_type=VO_MIN_ROAS` / `bid_type=BID_TYPE_NO_BID` / `optimization_event=ACTIVE_PAY` / **`vbo_window=ZERO_DAY`** / `roas_bid=<如0.3>`（均从源 VO adgroup `1867144823568546` 逐字核对得出；同时修正了脚本原来 VO 误用 BID_TYPE_CUSTOM）。
- `deep_bid_type` 合法枚举（服务器泄露）：`AEO, DEFAULT, MIN, PACING, VO_HIGHEST_VALUE, VO_MIN, VO_MIN_ROAS`。VO_HIGHEST_VALUE=最大化价值不设目标ROAS；VO_MIN_ROAS+vbo_window 才是目标 ROAS。
- **Doni 的 app_id/package 待查**（用 adgroup/get 从现有 Doni 广告读，或 app/list）。

---

## 3. 各产品固定参数（账户 / App / identity）

| 产品 | advertiser_id | app_id | package | BC_AUTH_TT identity_id |
|---|---|---|---|---|
| Jovia And | `7576940782100430856` | `7585065113720225808` | `com.qiga.vio` | `d5c65e1b-ca66-55f9-be50-3d40a879e7c6` |
| Doni And | `7559144904526708753` | `7571754591199281159` ✅已核实 | (建广告只需 app_id) | `6a413d04-8ef6-5910-b382-8f2dca3057cb` |

- identity 都归属 BC `7118908157199384578`（Presence BC），即 `identity_authorized_bc_id`。
- **Doni 也用这套安卓模板**，只改 4 变量 + 换 advertiser_id/app_id/identity。
- **两个 iOS 产品（Luma iOS `7553499098226819079` / Romi iOS `7553497951788728328`）可能不一样**，届时单独确认（`promotion_type=APP_IOS`，SKAN/归因窗口/定向 OS 等可能变，不要照搬安卓模板）。

### 4 个测试账户（逐个从 0 建广告）
| advertiser_id | 账户名 | 产品/平台 | 状态 |
|---|---|---|---|
| `7576940782100430856` | 省广_Jovia_And_1_syh | Jovia / Android | ✅ 已建（AEO + VO 均验证） |
| `7559144904526708753` | 省广_Doni_And_1_syh | Doni / Android | ✅ 已建（AEO+VO 均已开投 2026-07-03）|
| `7553499098226819079` | 省广_Luma_iOS_syh | Luma / iOS | 待建（iOS 模板需单独确认） |
| `7553497951788728328` | 省广_Romi_iOS_syh | Romi / iOS | 待建（iOS 模板需单独确认） |

---

## 4. 关键技术发现（踩坑记录，重要）

### 4.1 Smart+ 有专用接口，普通 campaign/create 建不出 Smart+
- 普通 `campaign/create` 传 `campaign_automation_type=UPGRADED_SMART_PLUS` → **被忽略**，返回 `MANUAL`（退化成普通广告）。
- **Smart+ 专用接口前缀是 `smart_plus/`**：
  - `smart_plus/campaign/create/`
  - `smart_plus/adgroup/create/`
  - `smart_plus/ad/create/`
- 建成后 campaign 返回 `smart_plus_adgroup_mode: MULTIPLE` = 确认是真 Smart+。
- **权威字段来源**：官方 SDK 仓库 `github.com/tiktok/tiktok-business-api-sdk`（比门户 JS 文档好扒——用 git tree API 拿文件名再 grep）。

### 4.2 Smart+ 各层结构差异（vs 普通接口）
- **campaign 层**：多了 `request_id`（必填，int64 幂等用，用 `int(time.time()*1e6)+i`）、`is_advanced_dedicated_campaign`。
- **adgroup 层**：定向包在 `targeting_spec` 里（不是散字段）。
- **ad 层**：素材包在 `creative_list[].creative_info` 里；文案是 `ad_text_list`，CTA 是 `call_to_action_list`（都是数组）。

### 4.3 一个 ad 挂多素材（不是建 N 条 ad）★ 结构纠错
- 正确做法是 **1 个 ad 的 `creative_list` 数组塞多个 video**（1 个 smart_plus_ad_id + N 个 creative），**不是**建 N 条独立 ad。
- 源 VO 那 7 条 ad 底层共享同一个 `smart_plus_ad_id`（前台 UI = 1 个广告含 7 创意）。一开始建成 10 条独立 ad（10 个不同 smart_plus_ad_id）是错的，已删除重建。**这也是 TikTok Smart+ 推荐做法。**
- 删 ad 用 `smart_plus/ad/status/update`，传 `smart_plus_ad_ids`（**不是** ad_ids）。

### 4.4 "仅作为广告展示"开关 = `ad_configuration.dark_post_status`
- 用户要求开"仅作为广告展示（不发布到 TikTok 主页）"。**真正的开关是 ad 层 `ad_configuration.dark_post_status`**，源广告值=`"ON"`。补上 `"ad_configuration":{"dark_post_status":"ON"}` 即对齐。
- **干扰项**：identity 的 `ads_only_mode`（identity/get 返回里有，但 create 无此入参，且源 identity 那字段是 False）——不是它。
- **定位法**：对比 `smart_plus/ad/get` 里源 vs 新的 `ad_configuration` 全字段，一眼看出差异。**不猜、直接 diff 源真实数据**是最硬的排查法。

### 4.5 BC_AUTH_TT identity 必须带 `identity_authorized_bc_id`
- 用 BC_AUTH_TT 类型 identity 建 ad，报错"need identity_bc_id"。从源 VO 广告完整 creative 读出 `identity_authorized_bc_id = 7118908157199384578`（Presence BC），补上即通过。

### 4.6 Smart+ ad 强制要求至少 1 条 ad_text
- 虽然源广告 ad/get 读出来 ad_text 全空（319 条全空，Smart+ 自动文案不回填），但 `smart_plus/ad/create` **强制要 `ad_text_list` 非空**，不能省。

### 4.7 创意增强策略枚举
- create 时合法枚举只有 `IMAGE_QUALITY / IMAGE_RESIZE / MUSIC_REFRESH / TRANSLATE_AND_DUB / VIDEO_QUALITY`。
- 读出来的 `CALL_TO_ACTION_ENHANCEMENT` / `AIGC_CARD` 是展示值，**不能回传**（否则 40002）。

### 4.8 封面图（cover）
- Smart+ ad 的 `image_info[].web_uri` 需要封面。视频 poster_uri 读出来是空，用 `file/video/suggestcover` 拿建议封面 web_uri。

### 4.9 并发限制 41021
- 循环建 ad 太快会报 41021（并发），`time.sleep(0.5)` 仍偶发失败，补建时加大间隔即可。

---

## 5. 关键 ID 速查

- **API base**：`https://business-api.tiktok.com/open_api/v1.3/`
- **Token**：环境变量 `TIKTOK_ACCESS_TOKEN`（`/etc/environment`），header 名 `Access-Token`
- **源 VO campaign**（复刻模板）：`1867144823568530`（`Jovia And_syh_260605_VO_1`）
- **Jovia And 建成结果**：
  - campaign `1869593678637202` / adgroup `1869593692832802`
  - 最终 ad：`smart_plus_ad_id 1869597550485794`（dark_post=ON，10 素材，DISABLE）
  - （旧的没 dark_post 的 `1869595018013089`、退化成 MANUAL 的 `1869592823479073` 均已删）

---

## 5.5 上新素材：XMP 素材库 → TT（URL 直传，零下载）✅（2026-07-03 打通）

从 dashboard 素材面板（FB 表，TT 表数据质量差）选素材 → 换皮到目标产品 → 上传到 TT 新建 campaign。**全程不用下载视频文件，走公网 URL 直传。**

**链路**：dashboard 素材名 → XMP `xmp_material_id` → XMP `file_url`（公网 CDN）→ TT `UPLOAD_BY_URL` → `video_id` → 建 ad。

1. **dashboard 取榜**：`GET /api/creative/data?days=7&key=<ADMIN_PASS>`（8081 端口），返回 `fb`/`tt` 数组，字段 `newUserRevenue` 排序。ADMIN_PASS 见 server.js。
2. **XMP 拿 material_id**：`POST /v2/media/material_report/list`（body 需 `cost_currency`，metrics 用 `currency_cost`，**不是** `cost`），返回行含 `xmp_material_id` + `md5_file_id`。⚠️ dashboard 名是清洗过的（去 `.mp4`/`_序号`/`剥削`前缀/合并 `A | B`），少数素材（AIGC、混剪等多产品共用）对不上 XMP 原始名，需人工确认。
3. **XMP 拿 file_url**：`POST /v2/media/material/list`，body `{material_id:[<int>], page, page_size}`（material_id 是 **int 数组**），返回 `file_url`（如 `https://xmp-material.mobvista.com/video/xx/<md5>.mp4`，公网无鉴权 HTTP 200，TT 服务器可抓）。
4. **上传 TT**：`POST file/video/ad/upload`，`{advertiser_id, upload_type:"UPLOAD_BY_URL", video_url:<file_url>, file_name:<改名后>}` → 返回 `video_id`。`upload_type` 枚举：UPLOAD_BY_FILE / **UPLOAD_BY_URL** / UPLOAD_BY_FILE_ID / UPLOAD_BY_VIDEO_ID。
5. **拿封面**：`GET file/video/suggestcover?advertiser_id=&video_id=` → `data.list[0].id` 就是 `image_info.web_uri`（**不是** web_uri 字段名，是 `id`）。
6. **建 ad**：把 `[[video_id, cover_web_uri, file_name],...]` 塞进标准脚本的 `materials`。

**首次真实开投（op_status=ENABLE）**：脚本已支持 config `op_status`（默认 DISABLE 安全；`ENABLE`=直接开投真实花钱）。三层（campaign/adgroup/ad）统一用该值。开投后 adgroup 进 `ADGROUP_STATUS_AUDIT`（审核）属正常。
**已跑通实例**：Jovia And VO `Jovia And_syh_260703_VO_3`（camp 1869683265896529，D0 ROAS 0.3，$50/天）+ AEO `Jovia And_syh_260703_AEO_2`（camp 1869683278613746，CPA $16，$50/天），各 7 个 FB top 素材换皮 Jovia，均 ENABLE。

---

## 6. 遗留待办
- [x] ~~固化建广告流程时把 VO 分支字段与源 VO 逐字核对~~（2026-07-03 已验证，关键=`vbo_window=ZERO_DAY`）
- [x] ~~查 Doni 的 app_id/package~~（2026-07-03 核实 app_id=7571754591199281159, identity=6a413d04-8ef6-5910-b382-8f2dca3057cb）
- [ ] 逐个测试账户从 0 建广告（~~Doni And~~ ✅；Luma/Romi iOS 单独确认 iOS 模板）
- [ ] 后续：抓取脚本 `scripts/fetch-tiktok.js` + 产品映射 + 接入 dashboard 替换 XMP

---

## 7. 上新素材 + 读取验证（2026-07-03 补充，重要）

### 7.1 ★ 上新素材的正确逻辑：「同名寻址」，不是「借文件」
- 看板看到某产品表现好的素材（如 Romi `转_1005_KN_Romi_暗示动作`），把产品字段改成目标产品（`转_1005_KN_Doni_暗示动作`），**拿改名后的名字回 XMP 搜**，得到该产品自己那一套同款素材的链接——不是把 Romi 的文件借给别人。
- 每个产品各投一套同名素材（产品字段不同，file_url 不同）。但**不是所有素材都有全产品版本**：新产品（如 Jovia）可能缺部分同款；另有少数素材 XMP 里不分产品、就一个共用文件（用任何产品名搜都返回同一 material_id）。
- XMP 同名搜索：`POST /v1/media/material/list`，body `{material_name:["完整名含产品+序号+.mp4"], page, page_size}`（material_name 是**数组**，必须带 `.mp4`，响应在 `data.data[]`）。序号未知就遍历 `_1`~`_12`。

### 7.2 ★ 读取验证坑：smart_plus/ad/get 按 ad_ids 过滤不可靠
- 用 `filtering.ad_ids` 查单条 ad，**返回的常是账户里另一条无关 ad**（如旧的 `广告名称2026-05-26`），且 `creative_list` 数量乱跳（5/10/16）——看上去像"素材被 Smart+ 自动污染"其实是**读错了广告**。
- **正确读法**：按 `filtering.campaign_ids` 查，再在返回列表里按 `ad_name` 找自己的 ad。这样 creative_list 与 create 传入完全一致。
- **create 响应才是权威**：脚本打印的"素材数=N"就是实际挂上的。别用 ad_ids 去"复核"。

### 7.3 URL 直传（零下载）
- XMP `file_url`（`xmp-material.mobvista.com/...`，公网无鉴权 HTTP 200）→ TT `file/video/ad/upload` 的 `upload_type=UPLOAD_BY_URL` + `video_url` → 返回 `video_id`。
- 封面：`file/video/suggestcover?advertiser_id=&video_id=` → `data.list[0].id` 就是 `image_info.web_uri`（字段名是 `id` 不是 web_uri）。刚上传的视频要等转码，cover 可能先取不到，重试几次。
- video_id 按 advertiser 隔离，跨账户要重新上传。

### 7.4 已建成实例（2026-07-03，均同名正确素材 + ENABLE + $50/天）
| 广告 | campaign_id | 素材数 | 出价 |
|---|---|---|---|
| Jovia And_syh_260703_VO_4 | 1869685640752209 | 6 | VO D0 ROAS 0.3 |
| Jovia And_syh_260703_AEO_3 | 1869685644937345 | 6 | AEO CPA $16 |
| Doni And_syh_260703_VO_2 | 1869685653920994 | 7 | VO D0 ROAS 0.3 |
| Doni And_syh_260703_AEO_2 | 1869685657764881 | 7 | AEO CPA $16 |

（Jovia 缺 `暗示动作` 同款，按屹恒要求跳过，故 6 个）
