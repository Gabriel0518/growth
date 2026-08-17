# Facebook/Meta 安卓「一句话建广告」+ autopilot（✅ 已打通全链路，2026-07-21）

> 仿 TikTok 那套，从「验证写权限」到「跑通建广告 + 自动运维」全部打通。仅服务单账户 `act_646387524897026`（省广_Dora_And_3_syh_Agentic，安卓 Dora 产品）。
> 相关脚本：`scripts/fb-android-prep.py` / `scripts/fb-create-android-ad.py` / `scripts/fb-android-daily-build.py` / `scripts/fb-android-autopilot.py`
> 配置：`config/fb-android-material-lib.json`（本地素材库）/ `config/fb-material-blacklist.json` / `config/fb-material-greylist.json`

---

## 1. 凭据 & 账户

- **App**：名 `marketing API`，App ID `1708296213710928`，已 publish + 进公司 BM（青岛天泽源盛 `1522249045620600`）
- **App Secret**：`a1446928faadb2a3446189f56be8444b`
- **长期 token**：存 `/etc/environment` 的 **`FB_LONG_TOKEN`**（60 天，约 **2026-09-18 到期**）。脚本读 `FB_LONG_TOKEN`（兜底 `FB_TOKEN`）。到期需屹恒去 Graph API Explorer 生成短 token，再 `GET /oauth/access_token?grant_type=fb_exchange_token&client_id=&client_secret=&fb_exchange_token=` 换新 60 天长 token。
- **账户锁死 `act_646387524897026`**（USD，时区上海）。token 技术上能读写 BM 13 个账户，但**只操作这一个**，脚本硬编码。排除 `Partnership Ads_test2`。

## 2. 建广告四层结构（1:1 从该账户真实老广告扒，全固定值）

- **Campaign**：`objective=OUTCOME_APP_PROMOTION` / `special_ad_categories=[]` / **CBO（daily_budget 在 campaign 层，= 3A 预算开关）** / `bid_strategy=LOWEST_COST_WITHOUT_CAP` / 默认 `status=PAUSED`
- **AdSet**（1个，不放预算）：AEO→`optimization_goal=OFFSITE_CONVERSIONS`，VO→`VALUE`；`billing_event=IMPRESSIONS`；`destination_type=APP`；`promoted_object`={app_id `774714691621452`(FB侧App资产) + Google Play `com.doramatch.app` + `custom_event_type=PURCHASE`}；`attribution_spec`=点击后7天；targeting=美国/18-65/安卓手机+平板/未安装/**`targeting_automation.advantage_audience=1`（3A受众开关）**
- **Ad**：name=素材文件名；status 跟随 campaign
- **Creative**：Page `717745171433271`(Dora meet friends) + IG `17841477175558188` + CTA `INSTALL_MOBILE_APP`→商店链接；文案固定（titles: `Singles nearby🫦`/`Ready to date?💞`；bodies: `Dating in your town💞`/`Find the love you're looking for`/`Meet girls online!👇🏻`）
- **默认结构**：1 campaign → 1 adset → **10 素材**（每素材 1 条 ad）

### 3A/进阶赋能型广告 = 两层叠加
① Campaign 层 **CBO**（预算统一分配）② AdSet 层 **advantage_audience=1**（年龄/地区当建议，系统自动扩量）。**CBO 预算在 campaign 层，别只看 adset。**

## 3. 素材：FB 素材库直传（prep 预备）

`fb-android-prep.py`：近3天 FB 素材榜（`dashboard/data/creative-*.json`，channel=FB，按 newUserRevenue 排序）→ 换 Dora 版名 → XMP 同名寻址拿 `file_url` → 上传 FB `/{act}/advideos`(by URL) → 轮询转码 `status.video_status==ready` → 拿 `picture` 缩略图 → 存 `config/fb-android-material-lib.json`。幂等凑 10 条。

## 4. 黑灰名单（与 TikTok 完全独立隔离）

- `config/fb-material-blacklist.json`（materials 数组）+ `config/fb-material-greylist.json`（counts 拒审计数）
- **规则**：拒审 1~2 次 → 灰名单但**照常可用建广告**；满 **3 次** → 不再用于新建/换素材（不主动删在投）；满 **5 次** → 进黑名单**删该 ad**（含在投）
- 归一化匹配：抹掉产品段(Dora/Romi/Doni/Luma/Jovia/GraceChat/Kira/Nalo) + 末尾 .mp4/.mov + 转小写；写任一产品版本即拦全部同款
- FB 优势：能读真实审核状态（`ad.effective_status==DISAPPROVED` + `ad_review_feedback`），TT 读不到这么细

## 5. autopilot + daily-build（2026-07-21 上线，节奏完全对齐 TT）

### 每日调度（crontab，env 注入同 TT `set -a && source /etc/environment && set +a`）
```
20 11 * * *  fb-android-autopilot.py                              # 拒审换素材 + eLTVROAS 调预算/关停
40 11 * * *  fb-android-prep.py                                   # 只预热素材，不建广告（2026-07-23 屹恒改：上午不建）
20 23 * * *  fb-android-autopilot.py
40 23 * * *  fb-android-prep.py; fb-android-daily-build.py --enable  # ★唯一建广告时点（每天仅此一次真投放）
10 0  * * *  fb-android-autopilot.py --retry-budget              # 降预算失败补偿
```

> ⚠️ **2026-07-23 屹恒定：上午 11:40 只跑 prep 不建广告，每天唯一建广告时点是 23:40。** 之前 11:40 也带 `--enable` 会上午先建、晚上幂等跳过（0722 即如此），与屹恒「只有晚上才建」的意图不符，故去掉 11:40 的 build。crontab 备份见 `output/crontab-backups/`。

日志：`output/fb-{autopilot,prep,build}-android.log`

### daily-build（`fb-android-daily-build.py`）
- **PLANS = `[("AEO",100.0),("VO",100.0)]`** —— AEO×1 + VO×1，各 CBO **$100/天**（屹恒 2026-07-21 定，FB AEO/VO 都不带出价，只定条数+预算）
- 命名 `Dora And_syh_<yymmdd>_<AEO|VO>`（同 TT 规范，可重名）
- 库内直取素材（复用 create 的 `pick_materials`）；幂等查重（读账户现存非 DELETED/ARCHIVED campaign 名，今日同名 AEO/VO 已存在则跳过）
- 默认 PAUSED，`--enable` 才 ACTIVE（cron 带 `--enable` 真投放）
- 0 素材守卫：绝不建空壳；skip 标记 `scripts/.skip_build_date_fb_android`

### autopilot（`fb-android-autopilot.py`）
**① 拒审处理（FB 特有，屹恒 2026-07-21 拍板「替换同一个 ad 的素材，不删不补建」）**
- 扫账户所有 ACTIVE 且名字前缀 `Dora And_syh_` 的 campaign 下所有 ad，读 `effective_status`
- 发现 `DISAPPROVED`：该素材归一化名 → 灰名单 counts+1
  - 满 5 次 → 进黑名单 + `DELETE /{ad_id}`（全删含在投）
  - 1~4 次 → **换同一 ad 的素材**：从库 `pick_clean_material`（counts<3 且非黑名单，优先本 adset 未用过）→ `build_creative` 建新 creative → `POST /{ad_id}` 把 ad 的 `creative` 指向新 creative id + 同步 ad 名为新素材名。**ad_id 不变、仍在原 adset/campaign。**
  - ⚠️ **FB creative 建后不可改素材**（Meta 限制），故「换素材」= 建新 creative + 重指 ad 的 creative，而非改旧 creative。
- 回写灰/黑名单（原子 `.tmp`+rename）

**② eLTVROAS 阶梯调预算/关停（阈值/系数完全照搬 TT）**
- 读个人面板 syh→Dora And→FB→campaign 算当天 eLTVROAS
- `cost>20`（COST_THRESHOLD）才动；`=0` 关停；`<0.6`降20%；`0.6~0.9`降10%；`0.9~1.1`不变；`1.1~1.3`增10%；`1.3~1.6`增20%；`1.6~2`增30%；`>2`增40%；降后 `<39`（MIN_BUDGET）关停
- **FB 调预算 = `POST /{campaign_id}` daily_budget（分×100）**；关停 = `POST /{campaign_id}` status=PAUSED
- eLTV倍数+修正系数走远端优先（`ug-data-callback.sitinai.com`）失败 fallback 本机；消耗+收入走本机 postback
- 降预算失败（撞下限）→ `output/fb-budget-retry-android.json`，次日 00:10 `--retry-budget` 补偿
- 飞书私聊屹恒（openid `ou_b2467dac5ff1d686fb48ccf1fbaa0c0d`，`lark-cli im +messages-send --as bot`，cron 内注入 PATH `~/.npm-global/bin`）

### create 脚本可编程入口
`fb-create-android-ad.py` 拆出 `build_creative(fn,vid,thumb)` 和 `build_ad(cfg, mats=None, verbose=True)` 供 daily-build import；命令行入口不变（`--opt AEO|VO --budget <美元> --name <命名> --countries US [--enable]`）。

## 6. ⚠️ 踩坑（务必记住）

1. **`standard_enhancements` 已被 Meta 废弃**，新建 creative 传它报 `error_subcode 3858504`。老广告历史遗留带着，新建必须去掉。保留 `enhance_cta/inline_comment/text_optimizations/video_auto_crop`。
2. **curl 打 graph.facebook.com 时 token 特殊字符（`?`等）会被 shell globbing 干扰**导致空响应。用 `curl -g`（关 globbing）或 `--data-urlencode`。之前「空返回」都是这原因不是网络。
3. **graph.facebook.com 直连可用，不用代理**（先 `unset https_proxy http_proxy`）。
4. **CBO 预算单位是「分」**（daily_budget ×100）。
5. **DoF 模式**：asset_feed_spec 至少一个字段（titles/bodies）要多于1个。我们 2 titles+3 bodies，OK。

## 7. 首批上线记录（2026-07-21）

- **Campaign `120247817902080601`**（`Dora And_syh_260721_VO`）VO/CBO $100/ACTIVE，1 adset → 10 条 ad 全 ACTIVE（手动跑 `build --enable` 建成）。
- 另有上午测试建的 `Dora And_syh_260721_AEO`（Campaign `120247814494400601`）为 PAUSED，幂等查重今天不会重建。
- dry-run 已验证：daily-build 幂等/素材、autopilot 拒审扫描/eLTV+修正系数远端取数/面板读数。拒审换素材 + 实际调预算分支需真实投放后触发（代码已对齐 TT 且静态验证）。
