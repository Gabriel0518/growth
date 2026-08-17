# 对外取数接口 事故始末（External Data-Pull API Incident）

> 路径：`/home/admin/.openclaw/workspace/docs/external-api-incident.md`
> 记录时间：2026-07-05 01:50
> 状态：**已回滚 + 已从网络层关闭 8081 公网访问**（屹恒 01:48 操作）
>
> 本文完整复盘 dashboard「对外取数接口」从规划、搭建、反复加护栏维修、到最终扛不住硬回滚并关闭公网访问的全过程。供未来重新开放此能力时参考——**别重蹈覆辙**。

---

## 0. 一句话总结

为了让外部 agent 能按 URL/key 直接从 dashboard 取投放数据，7-02 开放了 `/api/ext/*` 对外接口（复用登录密码鉴权）。但 **dashboard 是单线程 Node 服务、8081 端口裸奔公网**，外部 agent（含被泄露 key 的攻击者）持续高频/慢查询/高并发刷接口，反复把单线程事件循环堵死、前端打不开。加了 4 轮护栏（并发闸→硬超时→串行槽→慢查询优化→kill-switch）都没能根治，最终 **7-05 凌晨硬回滚到开放前的版本 `fd32d620` + 屹恒从网络层关闭 8081 公网访问**。

**根本病因（写死）：单线程服务 + 端口裸奔公网 + 无反代/无网关限流。对外接口只是放大了这个病因的攻击面。**

---

## 1. 时间线（提交级）

| 时间 | commit | 事件 | 性质 |
|------|--------|------|------|
| 07-02 18:48 | `25c26d0f` | **对外接口正式开放**：`authCheck` 支持 `?key=`/Bearer 密码鉴权（复用 dashboard 登录密码），`/api/*` 全部可供外部 agent 直取；新增 `/api/ext/records`（AF/AD 原始库直查+聚合+payload）、`/api/ext/xmp`（XMP消耗缓存优先）、`/api/ext/meta`（数据地图）；配套 `skills/richang-daily-data` | 规划搭建 |
| 07-02 19:06 | `4c907400` | XMP Open API 全能力透传 `/api/ext/xmp-{report,material,fields}`（此前只用 cost/impression/click 3 指标，现覆盖 FB240/TT428/GG125/material144 全维度） | 扩展 |
| 07-03 11:39 | `64c1eefd` | XMP消耗细化到 adset 广告组级 + **首版接口保护中间件**（api-guard 雏形） | 业务+护栏① |
| 07-03 18:24 | `6afd28a3` | **XMP 请求加 30s 硬超时**（修「卡在死 await、低 CPU」——`xmpApiRequestPath` 用 https.request 没设超时，上游连上不返回时 Promise 永不 settle，高频 await 全堵住） | 护栏② |
| 07-04 22:59 | `18c858ac` | **接口保护升级**：分级并发闸（每IP4/全局8）+ 单请求180s硬超时 + 绝对硬范围闸（45天，含真人session） | 护栏③ |
| 07-05 00:52 | `5191af1f` | **慢查询根治**：`postback/personal` 单日 `date(event_time,'+8h')=?` 非sargable → 范围条件，11.2s→~130ms（~85x）+ api-guard 加 M2M 串行槽 | 护栏④+性能 |
| 07-05 00:53 | `306d9c40` | dataserver 每月新表自动建 `evt_time_range`/`evt_inst_range` 索引 | 性能 |
| 07-05 01:14 | `fb734452` | **M2M kill-switch**：`?key=`/Bearer 请求在认证源头一律 503（修 `/api/ext/*` 绕过 apiGuard 的漏洞） | 护栏⑤ |
| 07-05 01:36 | — | **硬回滚**：`git reset --hard fd32d620`（`25c26d0f` 的父）+ force push | 放弃 |
| 07-05 01:48 | — | **屹恒从网络层彻底关闭 8081 公网访问** | 根治止血 |

---

## 2. 规划与搭建（07-02）

### 设计初衷
- 让外部 agent（如日报生成、投手个人数据拉取）**无需浏览器 session、直接按 URL/token 取数**。
- 复用 dashboard 登录密码作为 M2M 凭据：`?key=<密码>` 或 `Authorization: Bearer <密码>`——"持有密码者本就有全 dashboard 权限"，逻辑上等价。
- 配套 `skills/richang-daily-data` skill，封装取数能力给外部 agent 用。

### 接口清单
- `/api/*`（所有原有接口）：加了 key 鉴权后全部对外可取
- `/api/ext/records`：AF/AD 原始库直查 + 聚合 + payload（零盲区查 DB）
- `/api/ext/xmp`：XMP 消耗（缓存优先）
- `/api/ext/meta`：数据地图（freshness、enums、endpoint 目录）
- `/api/ext/xmp-{report,material,fields}`：XMP Open API 1:1 透传

### 埋下的隐患（事后看）
1. **`/api/ext/*` 走独立 authCheck，挂载在 apiGuard 之前** → 后加的所有 apiGuard 护栏对它无效（见 §4.5）。
2. **鉴权=单个静态密码**，一旦泄露=完全放开，无法按 agent 区分/吊销。
3. **接口本身是重查询**（原始库直查、跨天聚合），单请求就能占用大量单线程 CPU。

---

## 3. 攻击面画像

外部 agent（含恶意/失控的）对接口的访问模式，**精准绕过了每一版护栏**：

| 攻击特征 | 绕过了哪个护栏 |
|---------|--------------|
| 单日查询（跨度=1天） | 绕过「范围闸」（只拦大范围） |
| 频率中低（没到 30/min） | 绕过「频率闸」 |
| 单请求本身就慢（非sargable查询 4-15s同步CPU） | 绕过「假设慢=大范围/高频」的所有闸 |
| 打 `/api/ext/xmp`（async 打上游、绕过 apiGuard） | 绕过 M2M 串行槽/并发闸 |
| 伪造 `X-Forwarded-For` 头 | 让日志里的源 IP 失真，误导 IP 封禁 |
| 代理池分散 IP（几十个各开 2-4 连接） | 绕过单 IP connlimit、绕过 IP 黑名单 |
| 换不带 key 的匿名请求打范围接口 | 绕过 M2M kill-switch（只拦带 key 的） |

**核心教训：护栏若基于「攻击=量大/大范围/高频」的假设，会被「单请求慢 + 中低频 + 分布式」的真实攻击面完美绕过。**

---

## 4. 五轮护栏维修（都没能根治）

### 护栏① 首版接口保护中间件（`64c1eefd`, 07-03）
- api-guard 雏形，基础限流。**未拦住**：请求跨度=1天、频率不高。

### 护栏② XMP 请求 30s 硬超时（`6afd28a3`, 07-03）
- 修「卡在死 await、低 CPU」型卡死：`xmpApiRequestPath` 的 https.request 没设超时，XMP 上游连上但不返回数据时 Promise 永不 settle，高频 await 它的 handler 全堵住 → 进程 active、CPU~1%、大量 CLOSE-WAIT、HTTP 000。
- 加 `req.setTimeout(30s)→destroy` + `settled` 幂等标志。**有效但只堵住一个漏点**。

### 护栏③ 分级并发闸 + 180s硬超时 + 硬范围闸（`18c858ac`, 07-04）
- 每IP并发4 / 全局并发8 / 单请求180s硬超时 / 绝对硬范围闸45天（含真人session）。
- **未拦住**：`eltv-multipliers` 不在 HEAVY 清单；单请求慢+中低频完美绕过。

### 护栏④ 慢查询根治 + M2M串行槽（`5191af1f`+`306d9c40`, 07-05）
- **B方案（治本方向）**：`postback/personal` 单日 + `getPersonalDataLive()` 的 `date(event_time,'+8 hours')='YYYY-MM-DD'` **非 sargable** 写法（索引失效、6万+付费行逐行全表扫），改写为 sargable 范围 `event_time >= dayLo AND < dayHi`（北京日=UTC前一天16:00到当天16:00）。新增 `beijingDayBounds(date)` 辅助函数。**单日 11.2s→~130ms（~85x），逐查询 count/revenue 完全等价**。
- dataserver 每月新表自动建 `evt_time_range`/`evt_inst_range` 索引。
- **A方案（防雪崩）**：api-guard 加 M2M 全局串行槽 `M2M_SERIAL_SLOTS=1`。诚实结论：**同步 SQLite 独占事件循环时新请求到不了 guard 中间件，JS 层任何并发/串行闸对纯同步接口都无法拦截**——A 仅缓解雪崩，非真拦截。
- **仍卡死**：攻击者改打 `/api/ext/xmp`（见④.5）。

### 护栏⑤ M2M kill-switch（`fb734452`, 07-05 01:14）
- **发现关键漏洞**：`/api/ext/*` 系列走独立 authCheck、挂载在 apiGuard（server.js line 579）**之前**，带 key 请求在 authCheck 就放行返回，**根本走不到 apiGuard 的 M2M 闸**。实测 `/api/ext/xmp?key=` 返回 200 漏网。
- **修复**：把 kill-switch **下沉到认证源头 authCheck**：凡 `?key=`/Bearer 的 M2M 请求一律 503（5ms 秒拒，不碰 DB/上游）。开关 `GUARD_BLOCK_M2M`（默认 '1'=关闭对外API）。
- **仍卡死**：攻击者**换不带 key 的匿名请求打范围接口**（`/api/data?startDate=`），匿名虽秒 401，但**海量并发连接本身**（estab 涨到 11、CLOSE-WAIT 堆积）照样压垮单线程。

---

## 5. 硬回滚 + 关闭公网（07-05 01:36-01:48）

### 屹恒决策
- 「先彻底回滚，因为记录全都在，未来有能力了再全部回滚回来，什么也不会少」
- 「回滚后不要再基于回滚到的这一版代码再次开发（对外功能）」

### 执行
```bash
git stash push -u -m "回滚前保存"          # 未提交改动+临时脚本入stash，不丢
git reset --hard fd32d620                  # 25c26d0f 的父，开放对外接口之前的干净版
git push --force-with-lease                # 本地+远程都到 fd32d620
sudo systemctl restart sitin-dashboard     # 加载回滚后代码
```

### 数据零风险（确认过）
- **代码与数据完全分离**：git 只管代码，真实数据在 `/home/admin/dataserver/data.db`（2.9G，records_202605/06/07）**不在 git 里**，回滚碰不到。
- git 里的 `dataserver/database.db` 是 **0字节空占位**（6-09遗留），且回滚前后无变化。
- 回滚的是查询/接口层，**不动表结构**，DB 完全兼容旧代码。
- 真正不可逆的只有 `rm data.db` / `DROP TABLE` / `git clean -x`——都不在回滚操作里。

### 回滚后验证
- `authCheck`（回滚版 server.js line 418）**只认 session cookie，无任何 `?key=`/Bearer 鉴权** → 对外取数能力从代码层彻底消失。
- `/api/*?key=` 一律 **401**。✅ 干净态达成。

### 屹恒最终止血（01:48）
- **从网络层彻底关闭 8081 端口的公网访问能力**——这才是根治。8081 不再裸奔，攻击者从网络层就进不来。

---

## 6. 当前状态（2026-07-05 01:50）

- **代码版本**：`fd32d620`（无对外接口，只 session 登录访问）
- **8081 公网访问**：❌ 已由屹恒从网络层关闭
- **iptables**：凌晨临时加的 connlimit/限速规则已成冗余（公网已关），可后续清理
- **服务**：sitin-dashboard active，前端 session 访问正常（汇总46ms/AF428ms；个人面板~6.2s——回滚丢了sargable优化，能返回不卡死）
- **数据接收（dataserver）**：全程未受影响，持续正常入库

---

## 7. 未来重新开放对外接口的前提（务必满足，否则别开）

1. **8081 收回内网**：从 `*:8081` 改为 `127.0.0.1:8081` 只监听本地，**绝不裸奔公网**。
2. **前置反代/网关**：Caddy 加 server 块反代 dashboard（现 Caddy 只转 5000/3000），在网关层做 TLS + 限流 + WAF。
3. **鉴权升级**：弃用「单个静态密码=完全放开」。改为**按 agent 独立 token + 可吊销 + 限权限范围（只读特定接口）**。密码泄露后能定点吊销，而非全线放开。
4. **对外接口独立化**：`/api/ext/*` 单独进程/单独限流池，**别和真人前端共用单线程**。或改为异步任务队列（取数请求入队、后台算、结果轮询），避免同步查询独占事件循环。
5. **护栏放在认证源头**：kill-switch/限流必须在 authCheck 层，别只在末端 apiGuard（`/api/ext/*` 曾绕过后挂的 apiGuard）。
6. **查询必须 sargable**：所有对外可触发的查询预先验证走索引、亚秒返回，杜绝「单请求慢」攻击面。
7. **完整代码可一键恢复**：回滚前的完整实现在 commit **`fb734452`**，`git reset --hard fb734452` 即可全取回（含 §4 所有护栏、§4.4 的 85x 慢查询优化、BytePlus实时取数、新渠道、adset细化等一周业务成果）。对外接口起点 `25c26d0f`。

---

## 8. 沉淀的通用教训（跨事故复用）

1. **单线程服务裸奔公网 = 根本隐患**。应用层拦截（并发闸/串行槽/kill-switch）都只是缓冲，治本永远是「收回内网 + 反代 + 网关限流」。屹恒 01:48 关公网才真正解决。
2. **护栏中间件挂载顺序 = 安全边界**。`/api/ext/*` 走独立 authCheck 且挂在 apiGuard 之前，导致后挂的护栏形同虚设。**防护必须放在认证源头才无死角**。
3. **追封 IP 是死路**。代理池 + 伪造 XFF 头，逐个封永远追不上。要么应用层按凭据/行为拦，要么网络层 connlimit + 全局限速，别陷入 IP 黑名单军备竞赛。
4. **日志里的源 IP 可能是 XFF 伪造的**。被 iptables DROP 的 IP 还在日志高频出现 = XFF 头被伪造，真实连接来自别处，别被日志带偏。
5. **护栏别假设「攻击=量大」**。真实攻击面是「单请求慢 + 中低频 + 分布式」，完美绕过范围闸/频率闸/并发闸。
6. **静态密码鉴权 = 一旦泄露即全线放开**，且无法定点吊销。对外凭据必须可区分、可吊销、可限权。
7. **三类卡死对号入座**（排查口诀）：
   - 跨月慢查询打满CPU：CPU高、请求积压→502。修：范围SQL+缓存+范围闸。
   - 卡在死await、低CPU：进程active但curl超时，CLOSE-WAIT堆积+日志停更+CPU极低。排查 `ss -tn|grep 端口` 看连接分布，锁定没超时/漏防护的对外async请求。
   - 单请求慢+分布式绕闸：分接口测带/不带key耗时，锁定慢接口 + 网络层限流。
8. **git 回滚永远不丢 data.db**：数据库不在版本控制、物理文件独立。深夜大操作前 reflog/force-with-lease 保留历史，「什么也不会少」。

---

*相关文档：`docs/dashboard.md`（面板技术细节）、`docs/dataserver.md`（数据层）、`docs/ad-platform-apis.md`（XMP/平台API）、`memory/2026-07-05.md`（当日原始排查记录）*
