# Dashboard 经 Caddy 反代 + 只监听本地 —— 外网安全访问方案

> 路径：`/home/admin/.openclaw/workspace/docs/dashboard-caddy-reproxy-plan.md`
> 编写：2026-07-05
> 背景：7-05 凌晨对外接口事故后，dashboard(8081) 已用 iptables 挡住公网。本方案在**不再裸奔单线程服务**的前提下，让屹恒和团队重新从外网访问 dashboard 前端。
> 相关：`docs/external-api-incident.md`（事故复盘 §7 重新开放前提）

---

## 0. 目标与非目标

**目标**
- 团队从外网通过**域名 + HTTPS** 重新访问 dashboard 前端（session 登录）。
- dashboard 单线程服务**收回内网**（只监听 127.0.0.1），公网只暴露 Caddy(443)。

**非目标（明确不做）**
- ❌ 不重新开放 `/api/ext/*` 对外取数 API（屹恒已定：回滚版之上不再做对外功能）。
- ❌ 不给外部 agent 开机器取数能力。
- 本方案只解决「人用浏览器登录访问前端」。

---

## 1. 方案核心（三步）

```
公网用户 ──HTTPS(443)──> Caddy ──反代──> 127.0.0.1:8081 (dashboard, 仅本地监听)
                          │
                          └─ TLS 自动证书 + 限流 + 只转前端/登录路由
```

1. **dashboard 改为只监听 `127.0.0.1:8081`**（不再 `0.0.0.0`）。
2. **Caddy 加一个 server 块**反代到 `127.0.0.1:8081`，自动 HTTPS + 限流。
3. **iptables 收尾**：公网直连 8081 继续 DROP（保持现状即可，甚至更严），只允许本机；公网只走 Caddy 443。

相比"裸开 8083"：单线程服务永远不直接面对公网，攻击者打不到 Node 进程；并发/限流由 Caddy(多路复用、成熟网关) 兜住。

---

## 2. 前置准备：一个域名

Caddy 自动签 Let's Encrypt 证书需要一个**解析到本服务器公网 IP 的域名**。两个选择：

- **A. 复用免费动态域名**（和 `datareceive.chickenkiller.com` 同源，afraid.org FreeDNS）：再申请一个二级域名，如 `dashboard-ug.chickenkiller.com`，A 记录指向服务器公网 IP。
- **B. 用自有域名**：加一条 A 记录 `dashboard.yourdomain.com → 公网IP`。

> ⚠️ 需要屹恒确认用哪个域名 + 完成 DNS 解析（这步我做不了，需要你的域名账号）。下面文档以占位 `DASHBOARD_DOMAIN` 表示，落地时替换。

---

## 3. 实施步骤（逐步，可回滚）

### 步骤 1：dashboard 只监听本地

**改 `dashboard/server.js` 第 4574 行：**

```js
// 改前
app.listen(PORT, () => {
  console.log(`[Server] Sitin Dashboard running at http://localhost:${PORT}`);
});

// 改后
const BIND_HOST = process.env.DASHBOARD_BIND || '127.0.0.1';
app.listen(PORT, BIND_HOST, () => {
  console.log(`[Server] Sitin Dashboard running at http://${BIND_HOST}:${PORT}`);
});
```

> 默认 `127.0.0.1`，绝不裸奔。保留环境变量开关方便本地调试。

重启并验证只监听本地：
```bash
sudo systemctl restart sitin-dashboard
ss -tlnp | grep 8081
# 期望：LISTEN ... 127.0.0.1:8081 ...  （不再是 *:8081 / 0.0.0.0:8081）
```

### 步骤 2：Caddy 加反代 server 块

**编辑 `/etc/caddy/Caddyfile`，追加：**

```caddyfile
DASHBOARD_DOMAIN {
    # 限流：单 IP 每秒最多 N 个请求（Caddy v2 需 rate_limit 模块，或用下方 import 简版）
    reverse_proxy 127.0.0.1:8081 {
        # 传递真实客户端 IP，便于 dashboard 日志与将来审计
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        # 覆盖客户端可能伪造的 XFF（防事故复盘里"伪造 XFF 误导封禁"）
        header_up -X-Forwarded-For
        header_up X-Forwarded-For {remote_host}
    }

    # 可选：安全响应头
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        -Server
    }

    log {
        output file /var/log/caddy/dashboard-access.log {
            roll_size 50mb
            roll_keep 5
        }
    }
}
```

> **限流**：Caddy v2 原生不带 rate_limit，需 `caddy-ratelimit` 插件。若当前 Caddy 无该插件，先用「iptables 全局限速（步骤4）+ 单 IP connlimit」兜底，后续再装插件精细化。

**校验并重载（不中断服务）：**
```bash
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 步骤 3：验证反代通路

```bash
# 本机通过域名走 443 → Caddy → 127.0.0.1:8081
curl -I https://DASHBOARD_DOMAIN/
# 期望：200 或 302(跳登录)，且证书有效
```

浏览器访问 `https://DASHBOARD_DOMAIN/` → 出现 dashboard 登录页 → 用 `admin` / 现有密码登录 → 各面板正常。

### 步骤 4：iptables 收尾（收紧，不是放开）

现有规则已经是「127.0.0.1 放行 8081 + 公网 DROP」，**保持不变即可**——Caddy 在本机访问 127.0.0.1:8081 本就命中放行规则。

只需**确保 443 对公网开放**（Caddy 用）：
```bash
# 查看 443 是否被限（正常 Caddy 已在监听，公网需可达）
sudo iptables -L INPUT -n --line-numbers | grep -E ':443|dpt:443'
# 如无 DROP 443 的规则即可。如需给 443 也加全局限速兜底：
# sudo iptables -I INPUT -p tcp --dport 443 -m state --state NEW -m limit --limit 100/sec --limit-burst 200 -j RETURN
# sudo iptables -A INPUT -p tcp --dport 443 -m state --state NEW -j DROP   # 谨慎，可能误伤正常突发
```

> ⚠️ 8081 的公网 DROP 规则**必须保留**——这是"不裸奔"的最后一道网络层保险，即使 server.js 哪天被误改回 0.0.0.0 也挡得住。

---

## 4. 安全对照（对齐事故复盘 §7 前提）

| 复盘要求 | 本方案是否满足 |
|---------|--------------|
| ① 8081 收回内网(127.0.0.1) | ✅ 步骤1 + iptables 双保险 |
| ② 前置反代/网关 + TLS | ✅ 步骤2 Caddy 443 反代 + 自动证书 |
| ③ 鉴权升级(可吊销 token) | ⚠️ **本方案仍用 dashboard 原 session 登录**——因为只对人开放前端、不对外开 API，静态密码风险面小得多（无 `?key=` 机器接口）。如需更强可加 Caddy basic_auth 二道门。 |
| ④ 对外接口独立化 | ✅ **不适用**——不开对外接口 |
| ⑤ 护栏在认证源头 | ✅ Caddy 在最外层，未登录请求打不到重查询（回滚版无 ext 接口，匿名请求秒 401，且被 Caddy 限流挡在前面） |
| ⑥ 查询 sargable | ⚠️ 回滚版丢了 85x 慢查询优化，个人面板单日 ~6s。**人用不刷、无对外高频**，可接受；将来可择机把 `fb734452` 的 sargable 优化单独 cherry-pick 回来（只挑查询优化、不带对外接口）。 |
| ⑦ 完整代码可恢复 | ✅ 对外接口完整实现仍在 `fb734452`，随时可查 |

**关键结论**：本方案把「单线程裸奔公网」这个**根本病因**根治了。剩下的残留风险（静态密码、慢查询）都因为「不对外开 API + 只给人用」而大幅收敛，可接受。

---

## 5. 可选增强（按需，非必须）

1. **Caddy basic_auth 二道门**：在 dashboard 自身登录之外再加一层 HTTP Basic 认证，双重密码。
   ```caddyfile
   basic_auth {
       teamuser $2a$14$...(bcrypt hash)
   }
   ```
2. **IP 白名单**：若团队出口 IP 固定，Caddy `@allowed remote_ip x.x.x.x/32` 只放行团队 IP，其余 403。**最强防护**，但成员换网络就进不来。
3. **caddy-ratelimit 插件**：精细化每 IP/每路径限流。
4. **cherry-pick sargable 优化**：从 `fb734452` 只取 `beijingDayBounds` + `postback/personal` 查询改写，恢复个人面板亚秒响应（不碰对外接口代码）。

---

## 6. 回滚方案（如出问题）

| 出问题 | 回滚动作 |
|--------|---------|
| Caddy 反代异常 | `Caddyfile` 删掉新 server 块 + `systemctl reload caddy` |
| dashboard 只监听本地后本地也连不上 | 环境变量 `DASHBOARD_BIND=0.0.0.0` 临时放开（配合 iptables 仍挡公网） |
| 证书签发失败 | 检查域名 DNS 是否解析到本机公网 IP、80/443 是否可达（Let's Encrypt HTTP-01 校验走 80） |
| 想彻底退回现状 | 保持 8081 iptables DROP，删 Caddy 块，回到"仅本机/内网访问"状态 |

---

## 7. 需要屹恒决策/执行的事项（我做不了的）

1. **确定域名**：复用 chickenkiller 免费二级域名，还是自有域名？完成 DNS A 记录解析到公网 IP。
2. **网络层操作拍板**：iptables/Caddy 属网络与配置层，按 SOUL.md 红线我不主动改配置——需你确认或亲自执行这些命令。
3. **是否加二道门**：要不要 Caddy basic_auth / IP 白名单（可选增强）。

**我可以直接做的**：改 `server.js` 让它只监听 127.0.0.1（应用代码，非配置）、准备好所有 Caddyfile 片段与命令给你、验证通路。
