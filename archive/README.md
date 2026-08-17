# archive/ —— 旧架构代码归档

本目录保存 **Next.js 全量改造之前** 的旧实现（Python FastAPI 数据中心 + Express 数据看板 +
一批独立脚本）。这些代码已被 `personal/duhuan/production` 分支上的新单体仓库
（`apps/` + `packages/` + `services/`）整体取代，仅作历史参照与回溯保留，**不再参与构建与部署**。

判定标准：凡在 `main` 分支上已存在、且被本次重构取代的目录/文件，均归档于此。
新代码（改造后新增的部分）保留在仓库根目录，详见根 [`README.md`](../README.md) 与
[`REFACTORY_NOTE.md`](../REFACTORY_NOTE.md)。

## 归档内容与原始位置

| 归档路径 | 原始位置 | 说明 | 被谁取代 |
|----------|----------|------|----------|
| `archive/dashboard/` | `dashboard/` | 投放数据看板：Express `server.js`（约 5000 行、37 路由）+ `fetcher.js` 定时抓取 + `public/` 原生 JS SPA + `data/` 本地 JSON 缓存 | `apps/web`（Next.js App Router UI + `/api/*` Route Handlers）、`packages/fetcher`、`services/scheduler` |
| `archive/dataserver/` | `dataserver/` | 数据中心：FastAPI `app.py`（约 490 行），`asyncio.Queue` + `batch_writer` 批写，按月分表 `records_YYYYMM`，SQLite 存储 | `apps/web` 上报 Route Handlers（写 `ingest_inbox`）+ `services/ingest-worker`（批量落库） |
| `archive/scripts/` | `scripts/`（除 `pg-backfill/`） | 旧的 js/py/sh 辅助脚本：雅典娜/XMP/AF 抓取、飞书表格写入、UG 早报、审计对账等 | 运行时抓取逻辑迁入 `packages/fetcher` + `packages/integrations`；一次性/分析脚本不再随运行时保留 |
| `archive/analysis/` | `analysis/` | 一次性数据分析：修正系数因子分析（Python）、宽表 CSV、eLTV 趋势脚本等 | 无（探索性产物，仅存档） |
| `archive/config/` | `config/` | `mcporter.json`（旧 MCP 客户端配置） | 无 |
| `archive/docs/` | `docs/` | 旧服务技术文档：`dashboard.md`、`dataserver.md`、各外部 API 说明与对账/事故记录 | 架构说明由根 `README.md` + `REFACTORY_NOTE.md` + `REFACTOR-PLAN-NEXTJS.md` 承接；外部 API 参考文档如仍需可从此处查阅 |
| `archive/SERVER_OVERVIEW.md` | `SERVER_OVERVIEW.md` | 旧架构的完整技术总览（约 74KB），面向 AI Agent 的详解 | 根 `README.md` + `REFACTORY_NOTE.md` |

## 保留在根目录（未归档）的旧路径

- `scripts/pg-backfill/`：本次改造新增的一次性 PG 回填工具（`dl.cjs` / `loader.cjs`），
  用于把历史数据灌入统一 PostgreSQL，属于新迁移工作的一部分，故留在 `scripts/` 下。

## 如何恢复某个旧文件

归档只是 `git mv`，历史完整保留。需要参照旧实现时直接读取 `archive/…` 即可；
如需还原到原位，用 `git mv archive/<path> <path>` 即可撤销。
