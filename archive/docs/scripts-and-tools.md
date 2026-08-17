# 脚本、工具与 Git 管理

> 专家文档：workspace 目录结构、脚本清单、常用查询、Git 管理。从 SERVER_OVERVIEW.md 拆分。

---

## workspace 目录结构

- `scripts/` —— 数据抓取/写入脚本集合
  - `fetch-revenue.sh` / `sitin-dashboard.js` — 雅典娜收入抓取（旧版 Playwright，已被 API 替代，保留作 fallback）
  - `fetch-xmp-api.sh` / `fetch-xmp-api.js` — XMP 全公司消耗（API 版）
  - `fetch-personal-xmp-api.sh` / `.js` — XMP 个人面板消耗（API 版）
  - `fetch-af.sh` / `af-dashboard.js` — AF 全公司数据（旧版 Playwright，已被 DB 实时查询取代）
  - `gen-ug-report.py` / `send-ug-report.sh` — UG 早报生成和发送
  - `compute-eltv-trend.js` — eLTV D180 趋势分析
  - `write-sheet.js` / `write-xmp-sheet.js` / `write-af-sheet.js` — 飞书表格写入
  - `daily-report-sheet.js` — 飞书日报数据自动采集与写入（详见 `docs/daily-report.md`）
  - `operator-daily-report.js` — 投手日报文字生成（消耗/收入/利润/利润率）
  - `operator-multiday-data.js` — 投手多天数据导出（JSON，供图表脚本用）
  - `operator-charts.py` — 投手折线图生成（收入趋势 + 利润率趋势）
  - `send-operator-report.sh` — 投手日报发送到飞书群（文字+图表）
  - `eltv-comparison.js` — eLTV 多模型对比分析工具（三指数/双指数 × D30/D180）
- `dashboard/` —— 投放看板（详见 `docs/dashboard.md`）
  - `backfill-check.js` — 数据补全检查（cron 05:30，检查前3天雅典娜/XMP数据是否为0）
- `dataserver/` —— 数据接收服务（详见 `docs/dataserver.md`）
- `docs/` —— 项目专家文档
- `output/` —— 脚本输出日志

## 常用查询

```bash
# 查看服务状态
systemctl status dataserver sitin-dashboard caddy --no-pager

# Dashboard API 登录
curl -s -c /tmp/dash_cookie -L 'http://localhost:8081/login' \
  -d 'username=admin&password=<DASHBOARD_ADMIN_PASS>' -o /dev/null

# 查询 eLTV 倍数
curl -s -b /tmp/dash_cookie 'http://localhost:8081/api/eltv-multipliers?date=2026-05-15' | python3 -m json.tool

# 查询修正系数
curl -s -b /tmp/dash_cookie 'http://localhost:8081/api/correction-factors?date=2026-05-15' | python3 -m json.tool

# 查询汇总数据
curl -s -b /tmp/dash_cookie 'http://localhost:8081/api/data/latest' | python3 -m json.tool

# 雅典娜 API 直查
curl -s -H "Authorization: Bearer <ATHENA_API_KEY>" \
  'https://admin-api-prod.sitin.ai/api/open/admin/revenue?date=2026-05-20'

# SQLite 查询示例
sqlite3 ~/dataserver/data.db "SELECT COUNT(*) FROM records_202605;"
```

## Git 版本管理

- **GitHub 仓库**：`presence-io/Agentic-UG-Demo`（Org Private）
- **本地 Git 目录**：`/home/admin/.openclaw/workspace/`
- **远程**：origin → main
- **Token**：Classic PAT（`repo` 权限），存 `/etc/environment`（`GITHUB_TOKEN`）
- **日常操作**：屹恒说「提交」→ 助手执行 `git add -A && git commit && git push`
- **.gitignore 排除**：数据库、data/、node_modules/、output/、state/、skills/、个人 .md 等

### 飞书表格写入注意

`write-sheet.js` 和 `write-xmp-sheet.js` 的 `request()` 函数**必须带 `Content-Length` header**，否则 `insert_dimension_range` 可能静默失败导致数据覆盖。

## 关联文档

- `MEMORY.md` —— 业务/偏好长期记忆
- `TOOLS.md` —— 环境特定工具配置（XMP API 凭据等）
- `docs/af-api-checklist.md` —— AF 接入检查表
- `docs/athena-revenue-push.md` —— 雅典娜推送说明
