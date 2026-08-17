# TikTok 自动建广告：迁 crontab + 素材预备架构改造（CC 施工规格）

> 需求方：屹恒（2026-07-20）。执行：CC。监工：龙虾。
> 目标：把 iOS + 安卓两个账户的 TikTok 自动建广告，从「OpenClaw cron 走 AI」迁到「系统 crontab 纯脚本」，并新增「中午素材预备（新鲜度检查+补抓+预上传到 TT 库）」，让晚上 23:40 建广告只走库内直取、零外部依赖。

---

## 0. 背景 / 为什么改（务必先理解，别改跑偏）

现状（改造前）：
- 两个 OpenClaw cron（iOS：`tiktok-ios-noon`/`tiktok-ios-night`；安卓：`tiktok-android-noon`/`tiktok-android-night`），payload 是 `agentTurn`——**每晚起一个 AI 会话让 LLM 去跑脚本**。
- 脚本本身是纯 Python，飞书汇报也是脚本内部用 lark-cli 发的，**不依赖 AI**。走 AI 唯一作用是失败时让 AI 兜底解释。

暴露的两个故障（就是这次改造的动机）：
1. **07-19 夜间 cron 整体失败**：`LLM request failed: proxy or tunnel configuration blocked the provider request`。**AI 没被叫醒 → 两个脚本一步没跑 → 当晚 0 条广告**。→ 走 AI 是脆弱点，要去掉。
2. **07-18 建成 8 条空壳广告**：daily-build 取素材榜窗口 7/15~7/17，但 `dashboard/data/creative-2026-07-15.json`/`-16.json` **当时不存在**（creative 数据管线断更）→ 素材榜全局 0 条 → 每产品「备好 0 条」→ 建 Ad 报 `40002 at least 1 creative_info is required` → campaign/adgroup 建成但 0 ad = 空壳，不消耗。→ daily-build 缺「素材数据新鲜度检查 + 缺失自动补抓」，且没有「0 素材即中止」保护。

屹恒拍板的方案（4 点，已确认）：
1. **迁到系统 crontab（方案 A）**：纯脚本执行、脚本内发飞书、失败也发飞书告警，彻底摆脱 LLM 依赖。
2. **iOS + 安卓两账户都做素材预上传**。
3. **iOS 和安卓统一架构**。
4. 交给 CC 写。

---

## 1. 目标架构（改造后）

把「素材准备（慢：补抓+上传+转码）」和「建广告（快：只读库）」拆成两个时段：

| 时间 | 任务脚本 | 账户 | 干什么 |
|---|---|---|---|
| **11:40**（中午） | 素材预备 + 运维 | iOS + 安卓 | ①**新鲜度检查**：当天窗口(prev3~prev1) 的 `creative-{date}.json` 缺就**自动补抓**（调 fetch-creative-data.js 对应日期）；②按榜同名寻址筛出今晚每产品要用的素材；③**预上传到 TT 创意素材库**（走 XMP file_url → UPLOAD_BY_URL，等转码就绪）；④跑 autopilot（调预算+关停+灰名单清理，已有） |
| **23:40**（晚上） | 建广告 | iOS + 安卓 | daily-build **只走「库内直取」分支**（素材中午已进库）→ 秒建、零 XMP、零上传。若库内缺某素材则记录告警但不阻塞（顺延/跳过） |

关键收益：晚上建广告零外部依赖（不连 XMP、不等转码、不依赖当天数据管线），07-18/07-19 两类故障都根治。

---

## 2. 具体要做的事（拆成可验收的子任务）

### 2.1 新增「素材预备脚本」`scripts/tiktok-material-prep.py`
- 参数：`--platform ios|android`（或都做，二选一实现方式 CC 定，但要能分别对两账户跑）；`--dry-run`。
- 逻辑：
  1. **新鲜度检查 + 自动补抓**：算当天窗口 `dates=[prev(d,3),prev(d,2),prev(d,1)]`（复用 daily-build 的 `today_bj`/`prev`）。对每个 date，若 `dashboard/data/creative-{date}.json` 不存在或明显过小/损坏，则调用 `node dashboard/fetch-creative-data.js` 补抓该日（fetch-creative-data.js 已有 `fetchAndSaveDate(dateStr)` 导出，也有 `--init`；CC 需确认/补一个「按指定日期补抓」的 CLI 入口，如 `node fetch-creative-data.js --date 2026-07-18`，若没有就加）。补抓要尊重 XMP 限流（20 QPM，跑得慢是正常，中午有时间）。
  2. **筛素材 + 预上传**：复刻 daily-build 的 `build_rank()` + `swap()`（同名寻址）+ 黑名单过滤，为每个产品选出今晚要用的 N=10 素材。对每个选中素材：先查 TT 库（`tt_lib_index`）有没有同名，**没有才上传**（`file/video/ad/upload` UPLOAD_BY_URL），上传后**等转码就绪**（可用 suggestcover 能取到封面作为就绪信号）。**注意封面比例校验**（见 §4 已知坑：非 9:16 素材要顺延，别上传没用的）。
  3. 汇报：预备了多少素材、补抓了哪几天、上传了几个/库内已有几个、失败几个 → 发飞书（脚本内 lark-cli，见 §3）。
- **幂等**：中午可能被重跑，已在库的不重复传。
- 两账户各自的 AID/产品/identity 见 §5。

### 2.2 改 daily-build 加「纯库内模式」
- iOS：`scripts/tiktok-ios-daily-build.py`；安卓：`scripts/tiktok-android-daily-build.py`。
- 加一个开关（如 `--lib-only` 或环境变量），开启后 `resolve()` **只走 TT 库同名直取分支，去掉 XMP 上传兜底**。库内缺的素材：记录告警、顺延到下一个候选；若某产品凑不满 10 条则用现有条数建（≥1 条即可建，别建空壳）。
- **加「0 素材即中止」保护**：任何产品若最终 0 素材，**跳过该产品的建广告并飞书告警**，绝不建空壳 campaign/adgroup。（这是 07-18 空壳的根治）
- 保留现有幂等查重（同名 campaign 已存在则跳过）。

### 2.3 迁移到系统 crontab
- **删除 4 个 OpenClaw cron**（迁移完成、验证通过后再删；先并存验证）：
  - iOS：`tiktok-ios-noon`(id `0f751a1a-866f-42c0-9901-421e4efe8a7e`)、`tiktok-ios-night`(id `fada9a27-0d21-4b8f-9c02-117e2a2c1d9c`)
  - 安卓：`tiktok-android-noon`(id `b3614089-b0c9-416b-8cc1-ff4ec9ff1d90`)、`tiktok-android-night`(id `aa57599e-db3e-4939-b2d3-4a3cd0438dec`)
  - ⚠️ 删 OpenClaw cron 由**龙虾**用 cron 工具删，CC 不要碰 OpenClaw cron。
- **新增系统 crontab**（4 条，tz 是服务器本地时区，确认服务器 TZ；现有 crontab 都按本地时间写）。参考现有 crontab 惯例（`cd workspace && ... >> output/xxx.log 2>&1`）。大致：
  ```
  # 11:40 素材预备+运维（先预备后运维，或并行；两账户）
  40 11 * * * cd /home/admin/.openclaw/workspace && set -a && source /etc/environment && set +a && python3 scripts/tiktok-material-prep.py --platform ios >> output/tt-prep-ios.log 2>&1
  40 11 * * * cd /home/admin/.openclaw/workspace && set -a && source /etc/environment && set +a && python3 scripts/tiktok-material-prep.py --platform android >> output/tt-prep-android.log 2>&1
  # autopilot（调预算+灰名单）也挪来 crontab，或并进 prep；CC 定，但 11:40 和 23:40 都要跑 autopilot（现状如此）
  # 23:40 建广告（纯库内）
  40 23 * * * cd /home/admin/.openclaw/workspace && set -a && source /etc/environment && set +a && python3 scripts/tiktok-ios-daily-build.py --lib-only >> output/tt-build-ios.log 2>&1
  40 23 * * * cd /home/admin/.openclaw/workspace && set -a && source /etc/environment && set +a && python3 scripts/tiktok-android-daily-build.py --lib-only >> output/tt-build-android.log 2>&1
  ```
  - **autopilot 归属**：现状 noon=只autopilot，night=autopilot+build。改造后建议：11:40 跑 prep + autopilot，23:40 跑 autopilot + build（保持每天两次调预算+灰名单）。具体编排 CC 提方案给龙虾确认。
  - **crontab 里跑 lark-cli 必须注入 PATH**（`~/.npm-global/bin`）——autopilot/prep 脚本内部发飞书依赖，见 MEMORY「cron 里用 lark-cli 必须脚本内注入 PATH」。脚本内已处理的就不用管，新脚本要照做。

### 2.4 失败告警（替代 AI 兜底）
- 每个脚本：正常结束发正常飞书汇报；**异常/关键步骤失败时也发飞书告警**（带脚本名+错误摘要），并以非 0 退出码退出（方便日志排查）。
- 特别是：素材预备时「补抓失败」「某产品预上传 0 条」要显式告警；建广告时「某产品 0 素材跳过」要告警。

---

## 3. 飞书发送（脚本内，别依赖 AI）
- 工具：`~/.npm-global/bin/lark-cli im +messages-send --as bot --user-id ou_b2467dac5ff1d686fb48ccf1fbaa0c0d --text "..."`
- crontab 环境需注入 PATH：`export PATH=~/.npm-global/bin:$PATH`（或脚本内 `env["PATH"]=...`，autopilot 已有写法可抄）。
- 屹恒 open_id：`ou_b2467dac5ff1d686fb48ccf1fbaa0c0d`。

---

## 4. 已知坑（务必处理，别重蹈）
- **非 9:16 封面报 `Unsupported image size`**：某些 AIGC 素材源视频比例非 9:16（如 1080x1790=1.657），其 suggestcover 所有候选都非标，TT Smart+ 拒收。`tiktok-android-daily-build.py` 已加 `_cover_ok()`（只认 h/w≈1.7778±0.03，全非标则该素材返回 None 顺延）。**iOS 的 `tiktok-ios-daily-build.py` 的 `suggest_cover` 还是盲取 list[0]，未校验——这次一并修**，并且**素材预备脚本上传前也要校验**（别把没法用的素材传进库白占空间）。
- **建 campaign v25 类坑**：建广告走现有 `tiktok-create-ios-ad.py` / `tiktok-create-android-ad.py`，别自己重写建广告逻辑。
- **XMP 限流 20 QPM**：补抓/寻址慢是正常，加节流别打爆。
- **幂等**：prep 重跑不重复上传；build 同名 campaign 已存在则跳过。
- **不要建空壳**：0 素材必跳过 + 告警。

---

## 5. 关键标识符
- **iOS 账户** AID `7553499098226819079`（省广_Romi_Luma_iOS_syh_Agentic）；产品：Romi iOS / Luma / GraceChat。
- **安卓账户** AID `7559144904526708753`（省广_Dora_Doni_Jovia_And_syh_Agentic）；产品：Doni / Dora And / Jovia And。
- app_id / identity：见 `docs/tiktok-create-ads.md` §8.9（安卓）和 iOS 部分；identity 属 Presence BC `7118908157199384578`。
- 榜单来源：`dashboard/data/creative-{date}.json`，字段 `creatives[].{product,name,channel,newUserRevenue}`，只取 `channel=="TT"` 聚合（注意：安卓 daily-build 是按 FB 通道排序——`channel=="FB"`，见其脚本；prep 要跟对应 build 的通道一致）。
- 黑/灰名单：`config/tiktok-material-blacklist.json` / `tiktok-material-graylist.json`（iOS 安卓共用）。
- fetch-creative：`dashboard/fetch-creative-data.js`（导出 `fetchAndSaveDate(dateStr)`、`todayBeijing`、`prevDate`；`--init` 取最近3完整天）。
- 建广告模块：`scripts/tiktok-create-ios-ad.py`、`scripts/tiktok-create-android-ad.py`。
- 现有系统 crontab 已有 9 条纯脚本任务，模式：`cd workspace && ... >> output/xxx.log 2>&1`。

---

## 6. 交付验收标准
1. `scripts/tiktok-material-prep.py` 写好，`--dry-run` 能跑通：正确算窗口、检测缺失、（dry不真抓不真传）打印将补抓哪几天/将上传哪些素材。
2. 真跑一次 prep（iOS+安卓），验证：缺失日期被补抓、素材进了 TT 库、飞书汇报正常。
3. daily-build `--lib-only` 模式跑通：只走库内、0 素材产品被跳过+告警、不建空壳、幂等生效。
4. 系统 crontab 4 条就位（先跟 OpenClaw cron 并存，龙虾验证一晚 OK 后再让龙虾删 OpenClaw cron）。
5. 失败告警链路验证（人为造一个失败看有没有发飞书）。
6. iOS 的 suggest_cover 封面校验修复。
7. 全程别碰 OpenClaw cron（那是龙虾的活）、别改 OpenClaw 配置。

---

## 7. 边界
- CC 只写脚本 + 系统 crontab + 文档。**OpenClaw cron 增删由龙虾用 cron 工具做。**
- 改动先 dry-run / 小范围验证，真上投放（ENABLE 建广告）前让龙虾过一眼。
- 别提交 git（屹恒说不用）。
