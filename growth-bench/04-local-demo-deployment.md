# Agentic UG 本地演示部署说明

## 部署状态

- Web 地址：<http://localhost:3000>
- 健康检查：<http://localhost:3000/health>
- 客户演示门户：<http://localhost:3000/demo>
- Web 运行时：Node.js 22.23.2
- 数据库：PostgreSQL 16，本地数据库 `agentic_ug`
- Web 端口：`3000`

## 演示账号

### 主站看板

- 地址：<http://localhost:3000/login>
- 用户名：`admin`
- 密码：`local-demo-only`

本地已启用账密兜底登录。飞书应用凭据未配置，因此飞书 OAuth 和卡片确认链路暂不可用。

### 客户门户

- 地址：<http://localhost:3000/demo>
- 用户名：`sitin`
- 密码：`aifantasy`

## 已完成的初始化

1. 安装并启用 Node.js 22。
2. 安装 PostgreSQL 16，并注册为 Homebrew 后台服务。
3. 创建本地数据库 `agentic_ug`。
4. 安装 pnpm workspace 依赖。
5. 执行数据库迁移，创建当前月表 `records_202608` 及看板、鉴权、广告管理相关表。
6. 构建 Next.js 生产版本，并在端口 `3000` 启动。
7. 验证健康检查、主站账密登录、客户门户登录。

## 本地配置

本地配置分别保存在仓库根目录 `.env` 和 `apps/web/.env.local`。两个文件均被 `.gitignore` 忽略，不会提交到 Git。

外部服务凭据当前留空，包括 XMP、Athena、飞书、Facebook 和 LLM。对应实时同步、飞书登录、Facebook 投放数据及 AI 能力只有在补齐合法凭据后才可用。

## 日常检查

查看 Web 是否正在监听：

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

查看健康状态：

```bash
curl http://localhost:3000/health
```

查看 Web 日志：

```bash
tail -f /tmp/agentic-ug-web.log
```

查看 PostgreSQL 状态：

```bash
/opt/homebrew/opt/postgresql@16/bin/pg_isready
```

## 停止与重新启动

停止 Web：

```bash
kill "$(lsof -tiTCP:3000 -sTCP:LISTEN)"
```

停止 PostgreSQL：

```bash
brew services stop postgresql@16
```

重新启动 PostgreSQL：

```bash
brew services start postgresql@16
```

重新启动 Web：

```bash
cd /Users/gabriel/Developer/Agentic-UG-Demo
PATH=/opt/homebrew/opt/node@22/bin:$PATH \
  nohup /opt/homebrew/opt/node@22/bin/corepack pnpm \
  --filter @agentic-ug/web exec next start -p 3000 \
  >/tmp/agentic-ug-web.log 2>&1 &
```

## 当前演示数据说明

数据库结构与登录账号已经初始化，但未导入生产数据，也未配置外部广告平台凭据。因此页面可以完整访问和演示交互，业务指标目前会显示为空或为 `0`。如需用于正式汇报，下一步应导入一套脱敏样例数据或配置可用的测试环境数据源。
