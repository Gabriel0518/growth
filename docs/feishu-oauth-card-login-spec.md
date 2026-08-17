# 飞书 OAuth + 卡片确认登录 —— 接入规格（方案 C）

> 给 Claude Code 的实现规格。这套流程已在服务器上用独立原型（/home/admin/login-poc）**端到端实测通过**，
> 本文把已验证的技术细节、坑、决策固化下来。**严格按此实现，不要自行改动飞书交互方式（如改扫码/免登跳转登录）。**

## 0. 背景与目标

替换现有「统一账号密码登录」为：
- **首次登录**：登录页点「飞书授权登录」→ 跳飞书 OAuth → 授权后回调换 `open_id + 姓名` → 存库 → 通过飞书 bot 推「确认登录」交互卡片 → 用户在飞书点「✅ 确认登录」→ 网页轮询到已确认 → 种 session。
- **二次登录**：登录页显示「你是谁?」下拉（列出已授权用户姓名）→ 选自己 → 用库里存的 open_id 直接推卡片 → 确认 → 种 session。（无需再 OAuth）
- **敏感操作二次确认**（预留能力）：任意敏感操作前，用当前登录用户的 open_id 推一张确认卡片，点确认才执行。

核心诉求：agent 场景下「背后员工点一下授权/确认就能登录、拉数据」，**不要扫码那种繁琐流程**。

## 1. 已实测确定的飞书技术事实（照抄，别重新试错）

- **应用**：新应用 `cli_aad2ec939cb9dce9`（正式用它）。可用范围=全员，已审批。
  - APP_ID / APP_SECRET 走环境变量：`FEISHU_APP_ID` / `FEISHU_APP_SECRET`（.env.example 已有位）。
- **飞书 SDK**：`@larksuiteoapi/node-sdk`（原型用 1.71.1，OK）。需加到 `apps/web` 依赖。
- **OAuth 授权 URL**（v1 authorize）：
  `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=<APP_ID>&redirect_uri=<encoded>&scope=contact:user.base:readonly&state=<state>`
- **重定向 URL（正式）**：`https://ug-data-callback.sitinai.com/auth/callback`（已让用户加到飞书后台白名单）。
- **code 换 open_id+姓名**（SDK）：
  ```js
  const tok = await client.authen.accessToken.create({ data: { grant_type:'authorization_code', code } });
  const uat = tok.data.access_token;
  const info = await client.authen.userInfo.get({}, Lark.withUserAccessToken(uat));
  // info.data.open_id, info.data.name, info.data.avatar_url
  ```
- **推交互卡片**（bot 应用身份，msg_type=interactive，receive_id_type=open_id）：
  ```js
  await client.im.message.create({
    params: { receive_id_type:'open_id' },
    data: { receive_id: openId, msg_type:'interactive', content: JSON.stringify(card) },
  });
  ```
- **收卡片按钮回调 —— 必须走长连接（WSClient），不是普通 event 订阅**：
  - lark-cli 的 event consume **不支持** card.action.trigger；必须用官方 SDK 的 `Lark.WSClient`。
  - **注册方式（关键坑）**：card 回调要注册进 `EventDispatcher` 的 `'card.action.trigger'`，不是单独的 cardActionHandler 参数。
  - 飞书后台「事件与回调」里必须**订阅 `card.action.trigger` 回调 + 订阅方式选长连接**（用户已配）。
  - **公网不需要**：长连接是出站 WebSocket，服务器公网关闭也能收回调。已验证。
  - 已验证 handler 形态：
    ```js
    const dispatcher = new Lark.EventDispatcher({}).register({
      'card.action.trigger': async (data) => {
        const value = data.action.value;      // { action:'confirm'|'reject', nonce }
        const openId = data.operator.open_id; // 点击人
        // ...校验 nonce + open_id 归属 → 标记 confirmed/rejected
        return { toast:{type:'success',content:'已确认'}, card:{ type:'raw', data:{...新卡片...} } }; // 就地更新卡片
      },
    });
    new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error })
      .start({ eventDispatcher: dispatcher });
    ```
  - 回调返回值即「就地更新卡片 + toast」，点完卡片变「已确认/已拒绝」。已验证。
- **卡片按钮 value** 里塞 `{ action, nonce }`；回调用 nonce 找登录挑战、校验 `data.operator.open_id === challenge.open_id`（防串号）。
- **邮箱反查 open_id 不可靠**：很多账号通讯录没登记企业邮箱，batch_get_id 只回显邮箱不给 id。**所以才用 OAuth 拿 open_id**，别退回邮箱反查。

## 2. 现有代码接触面（工程化仓库 agentic-ug-web）

- `apps/web/src/lib/dashboard/auth.ts`：无状态 HMAC 签名 cookie（`dashboard_session`）。`Session={authenticated,panelAccess}`，`TokenPayload={a,p,exp}`。
  → **扩展**：payload 增加可选 `oid`(openId)、`nm`(name) 做审计；`Session` 增加 `openId?`,`name?`。保持向后兼容（老 token 无 oid 仍有效）。
- `apps/web/src/app/login/actions.ts`：现在校验 adminUser/adminPass 后 `buildSessionToken` 种 cookie。→ 改造/新增登录动作。
- `apps/web/src/app/login/page.tsx`：登录表单。→ 改为「飞书授权登录」按钮 + 「你是谁」二次登录下拉。
- `apps/web/src/lib/config.ts`：增 `feishu:{appId,appSecret}`（`FEISHU_APP_ID`/`FEISHU_APP_SECRET`）+ `baseUrl`（`APP_BASE_URL`，默认 `https://ug-data-callback.sitinai.com`，用于拼 redirect_uri）。
- `packages/db/src/schema.ts`：新增两张表（幂等 DDL），`services/migrate` 会自动应用。
- 需要一个**长连接 consumer**。见 §5 部署考量。

## 3. 新增 PG 表（加进 packages/db/src/schema.ts 的 ensureBaseTables 里，幂等）

```sql
CREATE TABLE IF NOT EXISTS fs_user (
  open_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  union_id   TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS login_challenge (
  nonce      TEXT PRIMARY KEY,
  open_id    TEXT NOT NULL,
  purpose    TEXT NOT NULL DEFAULT 'login',   -- 'login' | 'sensitive'
  status     TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'confirmed'|'rejected'|'expired'
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_challenge_open ON login_challenge(open_id);
```
- 挑战 TTL 3 分钟；一次性（confirmed/rejected 后不可再用）。

## 4. 新增/改造模块

### 4.1 `apps/web/src/lib/feishu/client.ts`
- 导出 `larkClient`（Lark.Client，appId/secret 从 config.feishu）。
- `buildAuthUrl(state)`：用 config.baseUrl + '/auth/callback' 拼授权 URL。
- `exchangeCode(code) -> {openId,name,unionId,avatarUrl}`。
- `sendConfirmCard(openId,{nonce,purpose,detail,name}) -> messageId`。卡片样式见原型 lark.mjs（login=蓝、sensitive=橙）。

### 4.2 `apps/web/src/lib/feishu/store.ts`（走 @agentic-ug/db 的 pool）
- `upsertUser`, `listUsers`, `getUser`。
- `createChallenge(openId,purpose,detail) -> nonce`、`getChallenge(nonce)`（读时判过期→'expired'）、`markChallenge(nonce,status)`（仅 pending→x）。

### 4.3 长连接 consumer `apps/web/src/lib/feishu/card-consumer.ts`
- 导出 `startCardConsumer()`：起 WSClient + dispatcher('card.action.trigger')。
- 回调逻辑：查 challenge → 校验 open_id 归属 + pending → confirm/reject → markChallenge → 返回就地更新卡片。
- **单例守卫**：模块级 `let started=false`，避免多次 start。

### 4.4 路由（App Router Route Handlers）
- `GET /auth/start`：生成 state（存一次性、或用签名 state），302 到 buildAuthUrl。
- `GET /auth/callback`：取 code → exchangeCode → upsertUser → createChallenge('login') → sendConfirmCard → 把 pending 信息放进一个**短期签名 cookie**（pendingNonce/openId/name）→ 302 到 `/login/waiting`。
  - ⚠️ 用 HMAC 签名 cookie 存 pending（无状态，跟现有 auth.ts 一致），不要用内存 session（多副本/无状态部署要求）。
- `POST /login/pick`：body.openId → getUser 校验存在 → createChallenge → sendConfirmCard → 种 pending cookie → 302 waiting。
- `GET /login/waiting`：页面，JS 轮询 `/login/status`。
- `GET /login/status`：读 pending cookie 的 nonce → getChallenge；若 confirmed → 用 buildSessionToken({authenticated:true,panelAccess:false,openId,name}) 种正式 session cookie、清 pending → 返回 {status}。
- `GET /api/fs-users`（或 server component 直出）：给登录页二次登录下拉用（列 open_id+name）。
- 敏感操作演示（可选，先做 lib 能力 + 一个示例）：`requireConfirm(openId,detail)` 发卡 + 轮询确认的通用封装。

### 4.5 登录页改造 `login/page.tsx`
- 「🆕 首次登录（飞书授权）」→ `/auth/start`。
- 「已授权用户」下拉（server 端 listUsers 直出）→ POST `/login/pick`。
- 保留一个隐藏的/兜底的 admin 账密登录？——**默认去掉**，但建议保留一个 env 开关 `LEGACY_ADMIN_LOGIN=1` 时仍可用账密（应急）。

## 5. 部署考量（务必处理，别只做本地能跑）

- 现状 web 是 Next standalone 常驻 Deployment（`pnpm start`，端口 3000）。
- **长连接 consumer 放哪**：最简单=在 web 进程启动时 `startCardConsumer()`（Next 自定义 instrumentation：`apps/web/instrumentation.ts` 的 `register()` 里，仅 nodejs runtime、仅生产、单例）。
  - 注意：Next 多副本时每副本都会连——飞书长连接允许多连接，回调会被其中一个消费；但 challenge 状态在 PG 共享，任意副本处理都 OK。可接受。
  - 若 dora-k8s 只跑单副本 web，最省心。CC 需在 REFACTOR 说明里标注「web 副本数 >1 时长连接行为」。
- `.env.example` 增：`FEISHU_APP_ID` / `FEISHU_APP_SECRET`（已有）、`APP_BASE_URL=https://ug-data-callback.sitinai.com`、`LEGACY_ADMIN_LOGIN=`。
- k8s Secret 注入飞书 APP_SECRET（提示用户在 dora-k8s-config 配）。

## 6. 质量门禁（必须过）
- `pnpm typecheck` / `pnpm lint`（flat config, type-checked，最严格）/ `pnpm build` 全绿。
- 业务口径零改动（本次不碰任何 dashboard 数据逻辑）。
- 不破坏现有 `/api/*` 鉴权：`requireApiAuth` 仍认 session cookie；扩展 payload 后老逻辑不受影响。

## 7. 参考实现
- 原型全量代码在服务器 `/home/admin/login-poc/`：`lark.mjs`（飞书封装+SQLite）、`server.mjs`（express 版全流程）。**逻辑照搬，技术栈换成 Next Route Handler + PG + 无状态签名 cookie。**
- 卡片 JSON、OAuth 调用、长连接注册方式都在原型里验证过，直接复用。

## 8. 交付
- 新分支（如 `feat/feishu-oauth-card-login`），改动集中、可 review。
- 简短 PR 说明 + 在 AgenticUG.md 的鉴权段补一句指向本方案。
- 列出「需用户在飞书后台/ k8s 做的配置」清单。
