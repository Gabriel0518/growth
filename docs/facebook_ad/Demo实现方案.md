# 投放平台 Demo 实现方案

> 状态：设计阶段
> 分支：`personal/dzh/fb`
> 最后更新：2026-07-27
>
> 完整架构设计见 `docs/facebook_ad/投放平台架构设计.md`，本文档是 demo 阶段的最小落地方案。

## 0. Demo 目标

**跑通从登录到广告上线的完整创建链路**：

```
投手飞书登录 → 上传素材 → 同步到 Facebook → 创建 Campaign → 创建 AdSet → 创建 Ad → Facebook 侧投放
```

不做的：审核监控、Insights 拉取、策略引擎、操作审计（留到后续版本）。

## 1. 模块清单（7 个）

| # | 模块 | 一句话 |
|---|------|--------|
| 1 | Channel 接口能力 | `packages/fetcher/src/channels/` — FB adapter 实现核心写操作 |
| 2 | Token 管理 | 嵌入 FB adapter，读环境变量 `FB_LONG_TOKEN`，启动时校验 |
| 3 | 登录 & 权限校验 | **复用现有**飞书 OAuth + HMAC cookie，权限：飞书部门=投放 或 邮箱前缀在 {max, zhoupeijie, dingzhihao} 的自动放行 |
| 4 | 素材管理 | 输入 CDN URL → 上传 FB → 轮询转码 → 记录 channel_material_id |
| 5 | 创意管理 | 选素材 + 固定文案模板 + 选 Page → 创建 FB creative |
| 6 | 广告系列 / 广告组 / 广告管理 | Campaign → AdSet → Ad 三步创建流程，含命名规范校验 |

---

## 2. 实现顺序与文件清单

按依赖关系排列，不可并行（1 → 2 → 3 → 4/5 → 6/7）。

### Step 1：Channel 接口 + Token 管理

新包：`packages/fetcher/src/channels/`

#### 1a. 通用接口定义

**新建 `packages/fetcher/src/channels/types.ts`**

```typescript
// 渠道标识，后续扩展加 'tt' | 'gg'
export type Channel = 'fb';

export interface AdAccount {
  id: string;          // act_123456789
  name: string;
  currency: string;
  account_status: number;
}

export interface Campaign {
  id: string;                    // 平台 side ID
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';
  objective: string;
  daily_budget?: number;         // 分
  channel_extra: Record<string, unknown>;
}

export interface CreateCampaignInput {
  name: string;
  objective: string;
  status: 'ACTIVE' | 'PAUSED';
  daily_budget?: number;
  special_ad_categories?: string[];
}

export interface UpdateCampaignInput {
  name?: string;
  status?: 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';
  daily_budget?: number;
}

// ── AdGroup (AdSet) ──

export interface AdGroup {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  optimization_goal: string;
  billing_event: string;
  targeting: Record<string, unknown>;
  channel_extra: Record<string, unknown>;
}

export interface CreateAdGroupInput {
  name: string;
  campaign_id: string;
  status: 'ACTIVE' | 'PAUSED';
  optimization_goal: string;
  billing_event: string;
  targeting: Record<string, unknown>;
  promoted_object?: Record<string, unknown>;
  attribution_spec?: Record<string, unknown>[];
}

// ── Ad ──

export interface Ad {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  effective_status: string;
  channel_extra: Record<string, unknown>;
}

export interface CreateAdInput {
  name: string;
  adgroup_id: string;
  creative_id: string;
  status: 'ACTIVE' | 'PAUSED';
}

// ── Creative ──

export interface Creative {
  id: string;
  channel_extra: Record<string, unknown>;
}

export interface CreateCreativeInput {
  name: string;
  page_id: string;
  ig_account_id?: string;
  video_id?: string;
  image_hash?: string;
  titles: string[];
  bodies: string[];
  cta_type: string;
  link_url?: string;
  app_store_url?: string;
}

// ── Page ──

export interface AvailablePage {
  id: string;
  name: string;
  username: string | null;
  picture: string | null;
  source: 'owned' | 'partner';
  tasks: string[];
}

// ── Material 上传 ──

export interface ChannelMaterial {
  channel_material_id: string;   // FB: video_id
  channel_thumbnail_url: string | null;
}

export interface MaterialStatus {
  status: 'uploading' | 'ready' | 'failed';
  channel_extra: Record<string, unknown>;
}

// ── Channel Adapter ──
// 各平台实现此接口

export interface ChannelAdapter {
  readonly channel: Channel;

  // Account
  getAccount(accountId: string): Promise<AdAccount>;

  // Campaign
  listCampaigns(accountId: string): Promise<Campaign[]>;
  getCampaign(campaignId: string): Promise<Campaign>;
  createCampaign(accountId: string, input: CreateCampaignInput): Promise<Campaign>;
  updateCampaign(campaignId: string, input: UpdateCampaignInput): Promise<Campaign>;

  // AdGroup
  listAdGroups(campaignId: string): Promise<AdGroup[]>;
  createAdGroup(input: CreateAdGroupInput): Promise<AdGroup>;

  // Ad
  listAds(adgroupId: string): Promise<Ad[]>;
  createAd(input: CreateAdInput): Promise<Ad>;

  // Creative
  createCreative(input: CreateCreativeInput): Promise<Creative>;

  // Page
  listAvailablePages(): Promise<AvailablePage[]>;

  // Material
  uploadVideoByUrl(accountId: string, fileUrl: string, name: string): Promise<ChannelMaterial>;
  uploadImageByUrl(accountId: string, imageUrl: string): Promise<ChannelMaterial>;
  getVideoStatus(videoId: string): Promise<MaterialStatus>;
}
```

#### 1b. FB HTTP 客户端

**新建 `packages/fetcher/src/channels/facebook/client.ts`**

- `class FacebookClient` — 封装 graph.facebook.com 直连
- 构造：`new FacebookClient(token: string, version?: string)`（默认 v25.0）
- `async get(path, params)` → `Response`
- `async post(path, data)` → `Response`
- `async delete(path)` → `Response`
- 内置：错误码标准化（#200→权限不足、#100→参数无效、#80004/#613→限流）、请求日志（`console.debug`）
- Demo 阶段不做自动重试——失败直接抛，方便排查

**关键参数**：

- `https://graph.facebook.com/{version}/{path}`
- 每次请求自动带 `access_token` 参数
- `Content-Type: application/json`（POST body 为 JSON）
- 连接超时 30s

#### 1c. Token 管理

**新建 `packages/fetcher/src/channels/facebook/token.ts`**

```typescript
// Demo 阶段极简：读环境变量，启动时校验，60 天过期记得手动刷新。

/** 从环境变量 FB_LONG_TOKEN 读取长期 token。缺失时抛错。 */
export function loadToken(): string {
  const token = process.env['FB_LONG_TOKEN'] ?? process.env['FB_TOKEN'];
  if (!token) throw new Error('FB_LONG_TOKEN 未设置，请设置环境变量后重试');
  return token;
}

/** 调 GET /me?fields=id,name 校验 token 是否有效。无效时打印明确提示。 */
export async function validateToken(token: string): Promise<{ userId: string; userName: string }> {
  const url = `https://graph.facebook.com/v25.0/me?fields=id,name&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FB Token 校验失败 (HTTP ${res.status}): ${body}`);
  }
  const data = await res.json() as { id: string; name: string };
  return { userId: data.id, userName: data.name };
}
```

#### 1d. FB Adapter 实现

**新建 `packages/fetcher/src/channels/facebook/adapter.ts`**

- `class FacebookAdapter implements ChannelAdapter`
- 内部持有 `FacebookClient` 实例
- 每个接口方法做三件事：
  1. 参数校验（必填字段 + 类型）
  2. 调 `client.get/post`
  3. 响应解析 + 错误处理

**adapter 核心方法实现要点**：

| 方法 | FB API 端点 | 备注 |
|------|-----------|------|
| `getAccount` | `GET /{act_id}?fields=id,name,currency,account_status` | |
| `listCampaigns` | `GET /{act_id}/campaigns?fields=id,name,status,objective,daily_budget,special_ad_categories` | 过滤掉 DELETED |
| `createCampaign` | `POST /{act_id}/campaigns` | v25.0 必须传 `is_adset_budget_sharing_enabled` |
| `updateCampaign` | `POST /{campaign_id}` | 改 status 走此端点 |
| `listAdGroups` | `GET /{campaign_id}/adsets?fields=id,name,status,optimization_goal,billing_event,targeting` | |
| `createAdGroup` | `POST /{act_id}/adsets` | targeting 透传 JSON |
| `listAds` | `GET /{adset_id}/ads?fields=id,name,status,effective_status,creative` | |
| `createAd` | `POST /{act_id}/ads` | creative=`{"creative_id":"xxx"}` |
| `createCreative` | `POST /{act_id}/adcreatives` | object_story_spec 含 video_data 或 image_data |
| `listAvailablePages` | `GET /me/accounts?fields=id,name,username,picture,category,tasks` | 区分 owned/partner |
| `uploadVideoByUrl` | `POST /{act_id}/advideos?file_url=xxx` | 返回 `{id}` |
| `uploadImageByUrl` | `POST /{act_id}/adimages?url=xxx` | 返回 `{images: {hash: {...}}}` |
| `getVideoStatus` | `GET /{video_id}?fields=status` | 轮询直到 `video_status == ready` |

#### 1e. 工厂函数 + index 导出

**新建 `packages/fetcher/src/channels/index.ts`**

```typescript
import type { Channel, ChannelAdapter } from './types.js';
import { FacebookAdapter } from './facebook/adapter.js';
import { loadToken } from './facebook/token.js';

// Demo 阶段 channels 是硬编码的 token → adapter 映射。
// 后续会改成从 operator_account_binding 表按投手动态创建。

let _fbAdapter: ChannelAdapter | undefined;

export function getFbAdapter(): ChannelAdapter {
  if (!_fbAdapter) {
    const token = loadToken();
    _fbAdapter = new FacebookAdapter(token);
  }
  return _fbAdapter;
}

// 后续多平台：getAdapter(channel: Channel): ChannelAdapter
```

#### 1f. package.json 更新

**编辑 `packages/fetcher/package.json`**：无需改动。types 和主入口已有，新建的文件在 `src/channels/` 下，编译后自然导出。在 `packages/fetcher/src/index.ts` 新增：

```typescript
// 新增
export { getFbAdapter } from './channels/index.js';
export type { ChannelAdapter, CreateCampaignInput, ... } from './channels/types.js';
```

---

### Step 2：DB Schema 新增

**编辑 `packages/db/src/schema.ts`**，新增 4 张 demo 阶段表：

```sql
-- 素材
CREATE TABLE IF NOT EXISTS ad_material (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR NOT NULL,
  file_url    VARCHAR,                    -- CDN 地址
  source_type VARCHAR NOT NULL DEFAULT 'file',  -- 'file' | 'partner_post'
  partner_post_id VARCHAR,
  partner_page_id VARCHAR,
  mime_type   VARCHAR,
  duration_ms INTEGER,
  file_size   BIGINT,
  app_product VARCHAR,
  tags        JSONB DEFAULT '[]',
  created_by  VARCHAR,                    -- 飞书 open_id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 素材平台上传记录
CREATE TABLE IF NOT EXISTS ad_material_upload (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id           UUID NOT NULL REFERENCES ad_material(id),
  channel               VARCHAR NOT NULL,
  channel_material_id   VARCHAR,
  channel_thumbnail_url VARCHAR,
  status                VARCHAR NOT NULL DEFAULT 'uploading',
  channel_extra         JSONB DEFAULT '{}',
  uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 广告创意
CREATE TABLE IF NOT EXISTS ad_creative (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             VARCHAR NOT NULL,
  channel_creative_id VARCHAR,
  channel_material_id VARCHAR NOT NULL,
  page_id             VARCHAR,
  ig_account_id       VARCHAR,
  cta_type            VARCHAR,
  titles              JSONB DEFAULT '[]',
  bodies              JSONB DEFAULT '[]',
  channel_extra       JSONB DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_ad_material_upload_material ON ad_material_upload(material_id);
CREATE INDEX IF NOT EXISTS idx_ad_material_upload_channel ON ad_material_upload(channel);
```

**更新 `packages/db/src/schema.ts`**：在现有 `ensureDashboardTables` 函数或新增 `ensureAdTables` 函数中执行上面的 DDL。`services/migrate` 执行时会自动调用。

---

---

### Step 2.5：操作员权限校验

Demo 阶段不引入权限表，直接在 API 入口做**飞书身份校验**。权限规则：**满足任一即放行**。

**规则 1：飞书部门 = "投放"**

飞书登录后，从 `fs_user` 表读用户部门信息（需先在飞书 OAuth scope 中包含 `contact:contact:readonly`，确保能拿到部门字段）。

**规则 2：邮箱前缀白名单**

飞书登录后取用户邮箱（`enterprise_email` 或 `email`），提取 `@` 前的前缀，在固定白名单 `{max, zhoupeijie, dingzhihao}` 中的直接放行。

**实现位置**：`apps/web/src/lib/dashboard/ad/auth.ts`（新建）

```typescript
import type { Session } from '@/lib/dashboard/auth';

/** Demo 阶段硬编码的邮箱前缀白名单 */
const EMAIL_PREFIX_WHITELIST = new Set(['max', 'zhoupeijie', 'dingzhihao']);

/** Demo 阶段硬编码的部门白名单 */
const ALLOWED_DEPARTMENTS = new Set(['投放']);

/**
 * 校验当前登录用户的飞书身份是否有投放操作的权限。
 * 规则（满足任一即通过）：
 *   1. 飞书部门包含"投放"
 *   2. 邮箱前缀在白名单中
 * 不通过返回 403 Response。
 */
export function requireAdOperator(session: Session): Response | void {
  if (!session.authenticated) {
    return Response.json({ error: '未登录' }, { status: 401 });
  }

  // 取飞书身份信息：openId + 部门 + 邮箱
  // Demo 阶段从现有 HMAC cookie 的 oid (open_id) 解析，
  // 再调飞书 API 或从 fs_user 表读部门/邮箱信息。
  const department = getDepartment(session);   // 查飞书通讯录 API 或 fs_user 表
  const email = getEmail(session);

  // 规则 1：部门匹配
  if (department && ALLOWED_DEPARTMENTS.has(department)) return;

  // 规则 2：邮箱前缀匹配
  if (email) {
    const prefix = email.split('@')[0]?.toLowerCase();
    if (prefix && EMAIL_PREFIX_WHITELIST.has(prefix)) return;
  }

  return Response.json(
    { error: '无投放操作权限，请联系管理员' },
    { status: 403 },
  );
}
```

**调用方式**：每个 `/api/ad/*` Route Handler 在 `requireApiAuth` 之后、业务逻辑之前调用：

```typescript
export async function POST(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;

  const permission = requireAdOperator(auth);
  if (permission instanceof Response) return permission;

  // ... 业务逻辑
}
```

---

### Step 3：API Route Handlers

所有 API 在 `apps/web/src/app/api/ad/` 下，一个目录一个 `route.ts`。

**鉴权模式（所有 API 共用）**：

```typescript
// 每个 route.ts 开头
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const auth = requireApiAuth(request);
  if (auth instanceof Response) return auth;
  return withGuard(request, auth, async () => {
    // ...
  });
}
```

Demo 阶段用 `requireApiAuth`（现有 HMAC cookie），`withGuard` 的限流参数酌情调松（`GUARD_HARD_MAX_RANGE_DAYS` 对新建接口无影响，不影响）。

#### 3a. 素材 API

**新建 `apps/web/src/app/api/ad/materials/route.ts`**

| 方法 | 功能 | 参数 |
|------|------|------|
| `GET` | 素材库列表 | `?channel=fb&status=ready` |
| `POST` | 注册素材 URL | body: `{ file_url, name, app_product? }` |

业务逻辑抽到：**新建 `apps/web/src/lib/dashboard/ad/material.ts`**

```
lib/dashboard/ad/material.ts:
  - listMaterials(channel?: Channel, filters?)
    → 查 ad_material JOIN ad_material_upload
  - registerMaterial(input: { file_url, name, app_product })
    → INSERT ad_material → 返回 id
```

**新建 `apps/web/src/app/api/ad/materials/[id]/sync/route.ts`**

| 方法 | 功能 | 参数 |
|------|------|------|
| `POST` | 同步素材到指定平台 | body: `{ channel: 'fb' }` |

流程：
1. 查 `ad_material` 拿 `file_url`
2. `getFbAdapter().uploadVideoByUrl(actId, file_url, name)` → 得到 `channel_material_id`
3. INSERT `ad_material_upload`（status=`uploading`）
4. 启动后台轮询 FB 转码状态（demo 用 `setInterval` 每 5 秒调 `GET /{video_id}?fields=status`，等待 FB 自己转码完成，最长等 5 分钟）
5. FB 转码完成 → UPDATE `ad_material_upload` status=`ready`

#### 3b. Page 列表 API

**新建 `apps/web/src/app/api/ad/pages/route.ts`**

| 方法 | 功能 |
|------|------|
| `GET` | 返回 `listAvailablePages` 结果（前端选择器数据源） |

Direct passthrough to adapter.

#### 3c. 创意 API

**新建 `apps/web/src/app/api/ad/creatives/route.ts`**

| 方法 | 功能 | 参数 |
|------|------|------|
| `GET` | 已创建创意列表 | `?channel=fb` |
| `POST` | 创建创意 | body: `{ material_upload_id, page_id, ig_account_id? }` |

`POST` 流程：
1. 查 `ad_material_upload` 拿 `channel_material_id`
2. 用固定文案模板构建 creative：
   ```
   titles: ['Singles nearby🫦', 'Ready to date?💞']
   bodies:  ['Dating in your town💞', 'Find the love you\'re looking for', 'Meet girls online!👇🏻']
   cta: INSTALL_MOBILE_APP
   ```
3. `getFbAdapter().createCreative({ video_id, page_id, ... })` → 得到 `channel_creative_id`
4. INSERT `ad_creative`

**新建 `apps/web/src/lib/dashboard/ad/creative.ts`**：`createCreative()` / `listCreatives()`

#### 3d. 广告系列 API

**新建 `apps/web/src/app/api/ad/campaigns/route.ts`**

| 方法 | 功能 |
|------|------|
| `GET` | 列表 `?channel=fb`（调 adapter + 返前端） |
| `POST` | 创建 |

`POST` body（demo 最小版）：

```json
{
  "name": "Dora And_syh_260727_VO",
  "objective": "OUTCOME_APP_PROMOTION",
  "daily_budget": 100,
  "status": "PAUSED",
  "special_ad_categories": []
}
```

创建前校验命名规范：格式 `{产品}_{投手}_{日期}_{AEO|VO}`，不通过直接 400。

**新建 `apps/web/src/lib/dashboard/ad/campaign.ts`**：
- `createCampaign()` → 调 adapter → 返回结果
- `listCampaigns()` → 调 adapter → 加缓存
- `updateCampaign()` → 调 adapter `updateCampaign`

#### 3e. 广告组 API

**新建 `apps/web/src/app/api/ad/adgroups/route.ts`**

| 方法 | 功能 |
|------|------|
| `GET` | 列表 `?campaign_id=xxx&channel=fb` |
| `POST` | 创建 |

`POST` body：

```json
{
  "campaign_id": "<FB campaign ID>",
  "name": "Dora And_syh_260727_VO - AdSet 1",
  "status": "PAUSED",
  "optimization_goal": "OFFSITE_CONVERSIONS",
  "billing_event": "IMPRESSIONS",
  "targeting": {
    "countries": ["US"],
    "age_min": 18,
    "age_max": 65,
    "platforms": ["android"],
    "device_types": ["phone", "tablet"],
    "install_state": "not_installed",
    "advantage_audience": true
  },
  "promoted_object": {
    "application_id": "774714691621452",
    "object_store_url": "https://play.google.com/store/apps/details?id=com.doramatch.app",
    "custom_event_type": "PURCHASE"
  }
}
```

**新建 `apps/web/src/lib/dashboard/ad/adgroup.ts`**

#### 3f. 广告 API

**新建 `apps/web/src/app/api/ad/ads/route.ts`**

| 方法 | 功能 |
|------|------|
| `GET` | 列表 `?adgroup_id=xxx&channel=fb` |
| `POST` | 创建 |

`POST` body：

```json
{
  "adgroup_id": "<FB adset ID>",
  "creative_id": "<本地 ad_creative.id>",
  "name": "<素材文件名>",
  "status": "PAUSED"
}
```

创建流程：
1. 查 `ad_creative` 拿 `channel_creative_id`
2. `getFbAdapter().createAd({ adgroup_id, creative_id: channel_creative_id, name, status })`
3. 记录 ad id（demo 段不单独建 ad 表，后续版本补）

**新建 `apps/web/src/lib/dashboard/ad/ad.ts`**

---

### Step 4：前端

#### 4a. 注册面板

**编辑 `apps/web/src/lib/panels.ts`**

```typescript
export type PanelName =
  | 'summary'
  | 'pb-personal'
  | 'creative'
  | 'daily-report'
  | 'ad-manager';   // ← 新增

export const PANELS: { key: PanelName; label: string; path: string }[] = [
  // ... 现有
  { key: 'ad-manager', label: '投放管理', path: '/ad-manager' },
];
```

#### 4b. 页面路由

**新建 `apps/web/src/app/ad-manager/page.tsx`**

```tsx
import type { ReactNode } from 'react';
import { renderGuardedPanel } from '@/lib/dashboard/guarded-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function AdManagerPage(): Promise<ReactNode> {
  return renderGuardedPanel('ad-manager');
}
```

#### 4c. 注册面板组件到 Dashboard 壳

**编辑 `apps/web/src/components/dashboard.tsx`**

```diff
+import { AdManagerPanel } from './panels/ad-manager-panel';

 // 在 JSX 返回中：
 {panel === 'daily-report' ? <DailyReportPanel /> : null}
+{panel === 'ad-manager' ? <AdManagerPanel /> : null}
```

#### 4d. 投放管理壳组件

**新建 `apps/web/src/components/panels/ad-manager-panel.tsx`**

- 顶部子 Tab 栏：`[素材库] [广告系列] [广告组] [广告] [创意]`
- 子 Tab 用 `useState` 管理，不 push URL（demo 简单做）
- 每个子 Tab 渲染对应子面板组件

#### 4e. 素材库面板

**新建 `apps/web/src/components/panels/ad-material-panel.tsx`**

功能：
- 素材列表：`GET /api/ad/materials?channel=fb`
- 新添素材表单：输入 CDN URL + 文件名 → `POST /api/ad/materials`
- 「同步到 Facebook」按钮 → `POST /api/ad/materials/{id}/sync`
- 同步状态显示（uploading / ready / failed）
- 已同步的展示 `channel_material_id` 和缩略图

#### 4f. 创意面板

**新建 `apps/web/src/components/panels/ad-creative-panel.tsx`**

功能：
- 已创建创意列表
- 新建创意表单：
  - 下拉选 Page（从 `GET /api/ad/pages` 加载，分组显示自有/合作方）
  - 下拉选素材（从素材库已同步到 FB 的，筛选 `status=ready`）
  - IG 账号（可选）
  - 预览：显示选中的 Page 名 + 素材缩略图 + 固定文案
  - 提交 → `POST /api/ad/creatives`
- 创建结果展示（`channel_creative_id`）

#### 4g. 广告系列面板

**新建 `apps/web/src/components/panels/ad-campaign-panel.tsx`**

功能：
- Campaign 列表：`GET /api/ad/campaigns?channel=fb`，显示 name/status/objective/daily_budget
- 新建表单：
  - 名称（自动拼接 `{产品}_{投手}_{今日日期}_{AEO|VO}`，投手产品可下拉改）
  - objective（下拉，默认 OUTCOME_APP_PROMOTION）
  - 日预算（$）
  - 初始状态（PAUSED——demo 默认暂停，要手动开）
  - 提交 → `POST /api/ad/campaigns`
- 状态操作：每个 campaign 行有「启动/暂停」按钮 → `PATCH /api/ad/campaigns?id=xxx`

#### 4h. 广告组面板

**新建 `apps/web/src/components/panels/ad-adgroup-panel.tsx`**

功能：
- 先选择 Campaign（下拉，从 campaign 列表加载）
- AdGroup 列表：`GET /api/ad/adgroups?campaign_id=xxx&channel=fb`
- 新建表单：
  - 名称
  - optimization_goal（下拉）
  - 定向：国家（多选）、年龄范围、设备平台、3A 开关
  - promoted_object（App ID + 商店链接，demo 硬编码）
  - 提交 → `POST /api/ad/adgroups`

#### 4i. 广告面板

**新建 `apps/web/src/components/panels/ad-ad-panel.tsx`**

功能：
- 先选择 AdGroup（下拉）
- Ad 列表：`GET /api/ad/ads?adgroup_id=xxx&channel=fb`
- 新建表单：
  - 选择创意（下拉，从已创建创意列表加载）
  - 名称（自动填素材名）
  - status（默认 PAUSED）
  - 提交 → `POST /api/ad/ads`

#### 4j. 客户端 API 封装

**新建 `apps/web/src/lib/client/ad/api.ts`**

- 封装 fetch 调 `/api/ad/*` 各端点
- 通用 `getJson<T>(url)` / `postJson<T>(url, body)` —— 复用 `apps/web/src/lib/client/api.ts` 已有的模式

#### 4k. 前端类型定义

**新建 `apps/web/src/lib/client/ad/types.ts`**

- 与 `packages/fetcher/src/channels/types.ts` 对齐的前端 DTO（去掉 adapter 级，只保留 API 返回的扁平结构）

---

### Step 5：环境变量

**编辑 `.env.example`**，新增：

```bash
# Facebook Marketing API
FB_LONG_TOKEN=        # 长期 User Token（60 天有效，从 Graph API Explorer 生成后用 fb_exchange_token 换）
FB_AD_ACCOUNT_ID=     # 默认广告账户 act_xxx
FB_APP_ID=            # App ID（token 刷新用，demo 可不配）
FB_APP_SECRET=        # App Secret（token 刷新用，demo 可不配）
```

---

## 3. 完整文件清单（28 个文件）

### 新建文件（22 个）

| # | 文件 | 说明 |
|---|------|------|
| 1 | `packages/fetcher/src/channels/types.ts` | ChannelAdapter interface + 所有 DTO |
| 2 | `packages/fetcher/src/channels/facebook/client.ts` | FB HTTP 客户端封装 |
| 3 | `packages/fetcher/src/channels/facebook/token.ts` | Token 加载 & 校验 |
| 4 | `packages/fetcher/src/channels/facebook/adapter.ts` | `FacebookAdapter implements ChannelAdapter` |
| 5 | `packages/fetcher/src/channels/index.ts` | 工厂函数 `getFbAdapter()` |
| 6 | `apps/web/src/lib/dashboard/ad/auth.ts` | 操作员权限校验（飞书部门 + 邮箱前缀） |
| 7 | `apps/web/src/lib/dashboard/ad/material.ts` | 素材业务逻辑 |
| 8 | `apps/web/src/lib/dashboard/ad/creative.ts` | 创意业务逻辑 |
| 9 | `apps/web/src/lib/dashboard/ad/campaign.ts` | Campaign 业务逻辑 |
| 10 | `apps/web/src/lib/dashboard/ad/adgroup.ts` | AdGroup 业务逻辑 |
| 11 | `apps/web/src/lib/dashboard/ad/ad.ts` | Ad 业务逻辑 |
| 12 | `apps/web/src/app/api/ad/materials/route.ts` | 素材 API |
| 13 | `apps/web/src/app/api/ad/materials/[id]/sync/route.ts` | 素材同步 API |
| 14 | `apps/web/src/app/api/ad/pages/route.ts` | Page 列表 API |
| 15 | `apps/web/src/app/api/ad/creatives/route.ts` | 创意 API |
| 16 | `apps/web/src/app/api/ad/campaigns/route.ts` | Campaign API |
| 17 | `apps/web/src/app/api/ad/adgroups/route.ts` | AdGroup API |
| 18 | `apps/web/src/app/api/ad/ads/route.ts` | Ad API |
| 19 | `apps/web/src/app/ad-manager/page.tsx` | 投放管理页面路由 |
| 20 | `apps/web/src/components/panels/ad-manager-panel.tsx` | 投放管理壳（子 Tab） |
| 21 | `apps/web/src/components/panels/ad-material-panel.tsx` | 素材库面板 |
| 22 | `apps/web/src/components/panels/ad-creative-panel.tsx` | 创意面板 |
| 23 | `apps/web/src/components/panels/ad-campaign-panel.tsx` | 广告系列面板 |
| 24 | `apps/web/src/components/panels/ad-adgroup-panel.tsx` | 广告组面板 |
| 25 | `apps/web/src/components/panels/ad-ad-panel.tsx` | 广告面板 |
| 26 | `apps/web/src/lib/client/ad/types.ts` | 前端类型 |
| 27 | `apps/web/src/lib/client/ad/api.ts` | 前端 API 封装 |

### 编辑文件（5 个）

| # | 文件 | 改动内容 |
|---|------|---------|
| 1 | `packages/fetcher/src/index.ts` | 新增 `getFbAdapter` + 类型导出 |
| 2 | `packages/db/src/schema.ts` | 新增 3 张表 DDL + `ensureAdTables()` |
| 3 | `apps/web/src/lib/panels.ts` | PanelName 类型 + PANELS 数组加 'ad-manager' |
| 4 | `apps/web/src/components/dashboard.tsx` | import + 条件渲染 AdManagerPanel |
| 5 | `.env.example` | 新增 FB 相关环境变量 |

---

## 4. 关键约束与简化

| 维度 | Demo 做法 | 后续升级 |
|------|----------|---------|
| Token | 读 `FB_LONG_TOKEN`，过期手动刷新 | 自动刷新 + 飞书过期预警 |
| 广告账户 | 硬编码一个 `act_646387524897026`（`FB_AD_ACCOUNT_ID` 环境变量） | 多账户绑定 |
| 操作员 | 飞书部门=投放 或 邮箱前缀在 {max, zhoupeijie, dingzhihao} 自动放行 | 权限绑定表 + RBAC |
| 文案模板 | 硬编码 `Singles nearby🦫` / `Ready to date?💞` 等固定文案 | 可配置模板库 |
| 定向 | 表单自由输入 JSON → 透传 API | 结构化定向表单 + preset |
| 素材上传 | FB `POST /advideos?file_url=xxx`，FB 自己下载+转码，本侧轮询等待 | 队列异步处理 |
| 错误处理 | API 直接 throw → 前端展示 `error.message` | 统一错误码 + 用户友好提示 |
| 操作审计 | **不做** | ad_operation_log 表 |
| 审核监控 | **不做** | ad-review-watch CronJob |
| Insights | **不做**（现有看板 XMP 数据已有） | ad-insight-sync CronJob |
| 幂等防重 | 不做（demo 手工操作，不会大量重复建） | 策略引擎 + daily-build |
| CBO | 支持但 UI 上先写死 `daily_budget` 在 campaign 层 | 非 CBO 模式 |
| 批量创建 | 单条同步创建 | 异步批量 |
| Partnership Ads | Page 选择器已列出所有 Page，投手自己选 | 帖子推广素材类型 |
