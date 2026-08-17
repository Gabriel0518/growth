# 全自动投放日报面板 — Session 记录 (2026-07-23)

## 会话概览

屹恒要求把原来的「全自动投手日报」（早上 2 点 cron 写飞书文档的版本）改成 Web 前端面板，
同时修复飞书 API 鉴权问题。

实际产出是 **PR #33 → #34 → #35 → #36** 的迭代，最终所有改动已合入 main。

---

## 最终合并 (PR #36)

**链接**: https://github.com/presence-io/Agentic-UG-Demo/pull/36  
**分支**: `feat/feishu-daily-report` → `main`  
**状态**: ✅ 屹恒点 merge

---

## 改动的所有文件

### 新增
| 文件 | 用途 |
|------|------|
| `apps/web/src/app/api/daily-report/route.ts` | 日报数据 API。读 daily_snapshots(kind='personal')，返回投手列表 + 汇总行(渠道聚合) + 明细 sheet |
| `apps/web/src/components/panels/daily-report-panel.tsx` | 日报面板前端组件。投手筛选 → Sheet 筛选（汇总/FB/TT/GG/产品×渠道明细）→ 11列表格 + CSV 下载 |
| `apps/web/src/app/daily-report/page.tsx` | 日报面板路由（`/daily-report`） |

### 修改
| 文件 | 改动 |
|------|------|
| `apps/web/src/lib/panels.ts` | 注册「投放日报」tab，路径 `/daily-report` |
| `apps/web/src/components/dashboard.tsx` | 渲染 DailyReportPanel |
| `services/scheduler/src/main.ts` | **去掉早上 2 点的飞书 cron**。注释说明日报已迁移至 Web 面板。personal/correction/dau/main 快照仍在 1 点生成 |
| `packages/fetcher/src/feishu-daily-report.ts` | **飞书 API 鉴权改用 lark-cli --as bot**（替代 FEISHU_APP_ID/FEISHU_APP_SECRET）。已测试通过但不再被 scheduler 调用 |

---

## 日报面板功能

### 顶部栏
- 👤 **投手选择**：syh(苏屹恒) / lh(刘欢) / zm1(张苗) / ... 共 11 人
- 📄 **Sheet 筛选**：「汇总」+ 该投手所有有消耗的产品×渠道组合（如 `Romi iOS FB`）
- 📅 **日期范围**：自动展示所有有 personal snapshot 的天（从最新到最旧）

### 表格 11 列
| 列 | 公式 |
|---|------|
| 日期 | |
| 渠道 | 汇总行显示 `FB/TT/GG`，渠道行显示 `FB`/`TT`/`GG`，明细行显示产品名 |
| 消耗 | |
| 总收入 | = 修正收入（原始收入 × 修正系数） |
| 返点 | TT 渠道 × 2.5% |
| PWA成本 | 按 DAU 分摊到产品，再按投手修正收入比例分配 |
| 纯利率 | = 纯利润 / 消耗 |
| 推理成本 | = 消耗 × 0.07 |
| 总ROAS | = 总收入 / 消耗 |
| 运营净利润 | = 总收入 × 0.99 - 消耗 + 返点 - PWA成本 |
| 纯利润 | = 总收入 - PWA成本 |

### 汇总 vs 明细
- **汇总模式**：按 FB/TT/GG 三个渠道聚合所有产品的数据，每天 1 行汇总 + 3 行渠道
- **明细模式**：选具体产品×渠道（如 `Romi iOS FB`），展示该组合每天的原始数据（11 列）

### CSV 下载
- ⬇ 按钮导出当前筛选下的表格

---

## 验证
- ESLint：零 error ✓
- TypeScript typecheck：全仓库通过 ✓
- Prettier format：零 warn ✓
- 飞书 API 读写：已测试（7/22 数据写入 13 个分表） ✓
- PG 数据：7/11~7/23 有 personal/correction/dau/main 快照 ✓

---

## 注意/坑

1. **部署需要 lark-cli**：`packages/fetcher/src/feishu-daily-report.ts` 依赖 lark-cli 的 bot 身份调飞书 API。但该文件目前**不被 scheduler 调用了**（2 点 cron 已删），所以生产不跑这个代码。如果后续要启用飞书写入，镜像需要装 `@lark-project/cli`
2. **数据依赖**：日报面板的数据来自 `daily_snapshots(kind='personal')`，由 scheduler 每天 1 点生成。如果某天没生成 personal 快照，那天的数据就不会显示
3. **PR #34/35 已合并**，但当时 token 有问题。最新的改动在 PR #36
4. **GitHub token**：`ghp_***` 有效期 90 天，2026-10 过期。Git remote URL 里嵌着（存在 `/etc/environment` 的 GITHUB_TOKEN 变量不准确，实际 token 在 remote URL 里）
