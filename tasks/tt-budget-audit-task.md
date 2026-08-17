# 任务：TT 预算 + 拒审提醒接入个人面板

> 面向 Claude Code 的完整任务书。所有字段/枚举/口径均已由龙虾实测确认，**照此实现，不要自行改口径**。
> 工作根目录：`/home/admin/.openclaw/workspace`
> dashboard 项目：`dashboard/`（server.js + public/app.js + public/style.css）
> TT 抓取脚本：`scripts/fetch-tiktok.js`（现有，只抓消耗）

---

## 一、背景与目标

dashboard 的**个人面板**（前端 `renderPbPersonal()` / 数据接口 `/api/postback/personal`）当前展示 TT/FB/GG 三渠道的消耗+收入树（渠道→产品→campaign→adset→ad）。

**本任务新增两类信息，只针对 TT 渠道：**
1. **预算**：在每行「消耗」列**左边**新增「预算」列。
2. **拒审红三角**：广告被拒/部分素材受限时，在名称处显示红色三角小标。

**FB/GG 不涉及**（它们没走直连 API，预算/审核暂不做），只有 TT 渠道的行有预算和红三角。

---

## 二、已实测确认的 TT API 字段与口径（务必照此，不要臆测）

### 2.1 预算（`/campaign/get/` 和 `/adgroup/get/`，GET）

请求示例（Access-Token 在 header，凭据见 `/etc/environment` 的 `TIKTOK_APP_ID/APP_SECRET/ACCESS_TOKEN[_2/_3/_4]`，171 账户分 4 个 token，遍历方式抄 `scripts/fetch-tiktok.js`）：
- `GET /open_api/v1.3/campaign/get/?advertiser_id=X&page=1&page_size=1000&fields=["campaign_id","budget","budget_mode","budget_optimize_on"]`
- `GET /open_api/v1.3/adgroup/get/?advertiser_id=X&page=1&page_size=1000&fields=["adgroup_id","campaign_id","budget","budget_mode","secondary_status"]`

**预算判定规则（实测确认，正好对应"大部分预算在campaign层、小部分在adgroup层"）：**
- `budget_mode === 'BUDGET_MODE_INFINITE'` → **该层无预算约束**（不是$0，是"不限"），视为**无预算，budget=null，跳过**。
- CBO 开启时（`budget_optimize_on === true`）→ 预算在 **campaign 层**（`budget` 为正数，如 150），此时对应 adgroup 的 budget=0/INFINITE。
- CBO 关闭时 → campaign 是 INFINITE（无预算），预算在 **adgroup 层**（`budget` 为正数）。
- 币种：全部按**美元**处理，直接用数值，不转换。

### 2.2 审核状态（`adgroup.secondary_status`，就在上面 adgroup/get 里带回）

**实测枚举分布（扫 70 账户 2164 adgroup）：**
| 枚举值 | 含义 | 是否触发红三角 |
|---|---|---|
| `ADGROUP_STATUS_AUDIT_DENY` | 整组拒审 | ✅ 是 |
| `ADGROUP_STATUS_REVIEW_PARTIALLY_APPROVED` | 部分素材受限/被拒 | ✅ 是 |
| `ADGROUP_STATUS_AUDIT` | 审核中（还没结果） | ❌ **否**（用户明确：只做"被拒"提醒，审核中不提醒） |
| 其他（`_CAMPAIGN_DISABLE` / `_DISABLE` / `_DELIVERY_OK` 等） | 禁用/正常投放 | ❌ 否 |

**红三角触发判定**（写成一个可扩展的集合，方便以后补拒审类枚举）：
```js
const TT_REJECT_STATUSES = new Set(['ADGROUP_STATUS_AUDIT_DENY', 'ADGROUP_STATUS_REVIEW_PARTIALLY_APPROVED']);
function isTtReject(secondaryStatus) { return TT_REJECT_STATUSES.has(secondaryStatus); }
```
**不需要下钻到 ad 层**（用户只做提醒，不做具体素材定位），adgroup 层的 secondary_status 就够。

### 2.3 产品/投手归属
复用现有映射：`config/tiktok-appid-product-map.json`（app_id→产品，adgroup 层 app_id）+ `scripts/fetch-tiktok.js` 里的 `matchOperator()`（campaign_name→投手）。**保持与消耗侧完全一致的归属逻辑**，否则预算/审核会挂错节点。

---

## 三、缓存架构（用户拍板，务必照此，这是本任务的关键设计）

**预算+审核数据独立缓存，与消耗解耦：**

1. **缓存时长 = 1 小时**（独立于消耗的 30 分钟 XMP 缓存）。
2. **抓取时机 = 只在每小时 xx:05 的预热 cron 里**，且是在现有 `await fetchXmpCampaigns(today)`（消耗预热）**跑完之后紧接着追加一步**抓取。1小时缓存 > 1小时抓取间隔，缓存永远新鲜。
3. **前端/接口请求时只读缓存，绝不主动触发抓取**：`/api/postback/personal` 注入预算/审核时，读缓存版函数；缓存为空就返回空（预算显示 `-`、无红三角），**绝不在请求链路里打 `/campaign/get`+`/adgroup/get`**（那是 171账户两轮遍历，会拖慢前端）。
4. **服务启动时也预热一次**（跟现有 XMP 启动预热同处理），避免重启后到首个 xx:05 之间的空窗（否则空窗期最长近1小时预算列全是 `-`）。
5. **抓取失败时保留上一次缓存值**（顶多旧1小时），前端照常显示，不报错。

**为什么这样设计**：`/campaign/get`+`/adgroup/get` 是 171账户×2轮遍历（约3~5分钟），代价大且预算/审核变化不频繁。放进 xx:05 定时、前端只读缓存，既保证前端秒开，又避免每次消耗刷新都拖着重接口跑。

---

## 四、后端实现

### 4.1 新增抓取脚本 `scripts/fetch-tiktok-meta.js`

- 遍历 171 账户（4 token，遍历骨架抄 `scripts/fetch-tiktok.js` 的 `getAdvertisers` + token 循环）。
- 每账户调 `/campaign/get/` 和 `/adgroup/get/` 拉上述字段（注意分页 page/page_size，`page_info.total_page` 翻页，抄现有脚本的翻页写法）。
- 产品归属：adgroup 的 app_id → `tiktok-appid-product-map.json`；未列出的 app_id 忽略（跟消耗脚本一致）。
- 投手归属：campaign_name → `matchOperator()`。
- **输出 JSON**（stdout），结构建议：
  ```json
  {
    "budgets": [
      { "level": "campaign", "product": "...", "operator": "...", "campaign": "<campaign_name>", "budget": 150 },
      { "level": "adgroup",  "product": "...", "operator": "...", "campaign": "<campaign_name>", "adset": "<adgroup_name>", "budget": 50 }
    ],
    "audits": [
      { "product": "...", "operator": "...", "campaign": "<campaign_name>", "adset": "<adgroup_name>", "reject": true }
    ]
  }
  ```
  - 只输出**有意义**的行：budget 仅输出 `budget_mode !== INFINITE 且 budget > 0` 的；audits 仅输出 `isTtReject(secondary_status) === true` 的（reject=false 的不用输出，省体积）。
  - campaign/adset 名称必须与消耗侧口径一致（campaign_name 直接 trim；adgroup_name → 注入时用 `normAdset()` 归一化，见 4.2）。
- stderr 打印进度（`token1: N advertisers` 之类），跟现有脚本风格一致。
- CLI 用法：`node scripts/fetch-tiktok-meta.js`（不需要日期参数，预算/审核是当前实时态，不分日期）。

### 4.2 `dashboard/server.js` 改动

**(a) 新增独立缓存 + 读/抓函数**（放在 XMP 缓存相关代码附近）：
```js
const TT_META_CACHE_TTL = 60 * 60 * 1000; // 1 小时
let ttMetaCacheMem = null; // { budgets: {...索引}, audits: {...索引}, fetchedAt }

// 纯读缓存版：接口/请求链路只调这个，缓存空就返回空索引，绝不打 API
function getTtMetaCached() {
  if (ttMetaCacheMem && (Date.now() - ttMetaCacheMem.fetchedAt) < TT_META_CACHE_TTL) return ttMetaCacheMem;
  return ttMetaCacheMem || { budgets:{}, audits:{}, fetchedAt: 0 }; // 过期也先返回旧值，不主动抓
}

// 真抓版：只在 xx:05 cron 和启动预热里调
async function refreshTtMeta() {
  // execFileSync 调 scripts/fetch-tiktok-meta.js（抄 fetchTiktokCampaigns 的 execFileSync 写法，timeout 600000, maxBuffer 64MB）
  // 解析后建立**便于注入的索引**（见下），写入 ttMetaCacheMem
}
```
**索引结构**（注入时 O(1) 查）：预算按 `product||channel(TT固定)||campaign` 和 `...||campaign||adset` 两级 key；审核按 `...||campaign||adset` key（adset 用 normAdset 归一化）。channel 恒为 'TT'。

**(b) 在 `scheduleXmpWarm()` 里追加**（`await fetchXmpCampaigns(today)` 之后）：
```js
try { await refreshTtMeta(); console.log('[Scheduler] TT meta (budget/audit) refreshed'); }
catch (e) { console.error('[Scheduler] TT meta refresh error:', e.message); } // 失败保留旧缓存
```

**(c) 启动预热**：在现有启动预热 XMP 的地方（或 `startSchedulers()` 附近）追加一次 `refreshTtMeta().catch(...)`。

**(d) `/api/postback/personal` 注入预算+审核到树**：
在现有 XMP 消耗注入（约 server.js:2725 `for (const xmpRow of xmpCampaigns)` 那段）**之后**，加一段注入：
```js
const ttMeta = getTtMetaCached();
// 1) 预算：从下往上，只 TT 渠道
//    - adgroup 有真实预算 → 写 adset.budget
//    - campaign 有真实预算(CBO) → 写 campaign.budget
//    - 上层无原始预算 → 用下层加总：campaign.budget ??= Σ adset.budget；channel.budget = Σ campaign.budget
//    - 只加到渠道级(channel)，**不做产品级汇总**（用户明确）
// 2) 审核：从下往上冒泡 reject 布尔
//    - adset.reject = isTtReject(该 adgroup)
//    - campaign.reject = 任一 adset.reject
//    - channel.reject = 任一 campaign.reject
```
注意：
- **只处理 channel==='TT' 的节点**，FB/GG 节点不加 budget/reject 字段（前端据此判断是否渲染）。
- adset 匹配用 `normAdset()`（跟 XMP 消耗注入同一归一化），对不上的预算/审核落到 `(unknown)` adset 不报错、不丢。
- 预算"从下往上加总"：**先注入原始层（campaign/adgroup 各自的真实 budget），再对没有原始 budget 的上层做 Σ下层**。channel.budget 恒为 Σ campaign.budget（渠道级不会有原始预算源）。
- 快照路径（saveSnapshot / 多日聚合）：预算/审核是**当前态**，不入历史快照、不做多日聚合。**只在单日 live 视图注入**即可（多日模式下预算列可留空/`-`，红三角不显示）。若实现上简单，也可只在最新单日显示。**以不破坏现有多日聚合为准**。

### 4.3 数据字段落到树节点
在 channel / campaign / adset 节点对象上新增：
- `budget`（number | null）
- `reject`（bool，默认 false / undefined）

---

## 五、前端实现（`dashboard/public/app.js` + `style.css`）

### 5.1 表头加「预算」列（在「消耗」左边）
现表头（`renderPbPersonal()` 内，约 app.js:1614）：
`渠道 | 消耗 | CPM | CPC | CPI | 总收入 | 新用户收入 | 新用户ROAS | eLTV ROAS`（9列）
改为：
`渠道 | 预算 | 消耗 | CPM | CPC | CPI | 总收入 | 新用户收入 | 新用户ROAS | eLTV ROAS`（10列）
- 所有 `colspan="9"` 的懒加载占位行 → 改 `colspan="10"`（app.js 里搜 `colspan="9"`，个人面板相关的几处：channel/campaign/adset 懒加载占位行）。

### 5.2 四个层级的行加「预算」单元格
涉及函数：`renderPbPersonal()`（channel 行）、`_renderCampaignRows()`（campaign 行）、`_renderAdsetRows()`（adset 行）。ad 层不加预算（ad 层本就没有预算概念，预算单元格显示 `-` 或留空对齐即可）。
- 预算单元格插在「消耗」`<td>` **前面**：
  ```html
  <td class="col-num">${node.budget != null && node.budget > 0 ? fmt(node.budget) : '-'}</td>
  ```
- **只有 TT 渠道**的行才有真实预算；FB/GG 行 budget 为 undefined → 显示 `-`。

### 5.3 红三角拒审标记
- 在**渠道名/campaign名/adset名**单元格（`.col-channel`）里，若 `node.reject === true`，名称后追加：
  ```html
  <span class="tt-reject-flag" title="存在拒审/受限素材">▲</span>
  ```
- 从 adset 一直冒泡显示到渠道级（后端已算好 reject 布尔，前端只渲染）。
- 样式（style.css 新增）：`.tt-reject-flag { color: var(--red); font-size: 0.75rem; margin-left: 4px; }`

### 5.4 列间距缩短 10%
用户反馈加了预算列后列间距太大。改 `style.css`：
- `.pb-channel-table thead th` 和 `.pb-channel-table table.pbp-detail-table .col-num` 的 `padding: 10px 12px` → 横向缩10%：`10px 10.8px`。
- `.pbp-camp-table .col-num` 宽度 `127px → 114px`（127×0.9≈114），min/max 同步改。
- **只影响个人面板表格**（`.pbp-detail-table` / `.pbp-camp-table` 作用域内），不动其他面板。

---

## 六、验证（必须做，给出证据）

1. **脚本独测**：`node scripts/fetch-tiktok-meta.js` 跑通，输出里能看到：至少一个 CBO campaign 的 campaign 级预算（正数）、一个非CBO 的 adgroup 级预算；audits 里能看到已知的 `AUDIT_DENY`/`REVIEW_PARTIALLY_APPROVED`（下面有已知样本账户）。
2. **后端注入**：重启 dashboard，等启动预热跑完（或手动触发一次 refreshTtMeta），登录后请求 `/api/postback/personal?startDate=<今天>&endDate=<今天>`，确认 TT 渠道节点有 budget 字段、渠道级 budget = Σ campaign、有 reject 的节点冒泡到渠道级。
3. **前端**：登录 dashboard（用户名 admin / 密码见 server.js `ADMIN_PASS`，本地 `http://127.0.0.1:8081`）→ 个人面板 → 确认：预算列在消耗左边、TT 有值 FB/GG 显示`-`、红三角在有拒审的 TT 行冒泡到渠道级、列间距缩窄后不拥挤。用 Playwright 无头截图佐证（项目里有 Playwright，参考现有 dashboard 验证方式）。
4. **不破坏现有**：FB/GG 消耗/收入/ROAS 照常；多日聚合模式不报错；`node -c` 语法检查两个改动文件。

### 已知拒审样本（实测扫到，供定位验证）
扫描时在 4 token 前 40 账户/token 范围内出现：`ADGROUP_STATUS_AUDIT_DENY` × 1、`ADGROUP_STATUS_REVIEW_PARTIALLY_APPROVED` × 3。全量 171 账户跑会更多。脚本跑通后应能在 audits 输出里看到这些。

---

## 七、约束与红线

- **改动前先备份**：`server.js` / `app.js` / `style.css` 各 `cp` 一份 `.bak-ttmeta-<时刻>`（.bak 已被 gitignore）。
- **FB/GG 逻辑一律不动**，只加 TT 的预算/审核。
- **不动消耗数据链路**（上午刚把 TT 消耗切成直连，`fetchXmpCampaigns` 内 FB/GG走XMP、TT走`fetchTiktokCampaigns`，别碰）。
- 大文件（server.js ~234KB）改完必须 `node -c` 检查，防止括号不匹配/重复代码块（历史踩过 CC 编辑残留重复块导致启动 SyntaxError 的坑）。
- 每步改完留痕，最后汇总：改了哪些文件、验证证据、有无风险。
- **不要自行 git commit/push**（交给龙虾统一提交）。
