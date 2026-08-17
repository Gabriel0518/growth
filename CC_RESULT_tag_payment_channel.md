# CC_RESULT — tag-payment-channel 服务

给 AD `ad_purchase` 事件补 `payment_channel` 字段的 PG 生产版服务，已完成并验证通过。

## 交付物

| 路径 | 说明 |
| --- | --- |
| `services/tag-payment-channel/package.json` | 包声明（`@agentic-ug/tag-payment-channel`，private，type module） |
| `services/tag-payment-channel/tsconfig.json` | 继承 `tsconfig.base.json`，`tsc -b` 编译到 `dist/` |
| `services/tag-payment-channel/src/main.ts` | 主逻辑（316 行，逐字搬 Python 版口径） |
| `deploy/Dockerfile` | 新增 `--target tag-payment-channel`（node:22-slim，跑 `dist/main.js`） |
| `deploy/tag-payment-channel.cronjob.yaml` | k8s CronJob（`20 * * * *`，`Etc/UTC`，有界 Job） |

## 逻辑要点（对齐 `dataserver/tag_payment_channel.py`）

1. **窗口**：默认=上一个完整 UTC 整点小时；支持 `argv[2]`（`2026-07-14T23:00:00Z`）回补。
2. **拉订单**：`POST paid-orders`，前后各 `BUFFER=120s` 缓冲；Node 原生 fetch，清代理直连，60s 超时。
3. **取 db 行**：月表 `records_YYYYMM`（**UTC 推月份**，不复用本地时区 `tableForDate`），`event_time` 是 TEXT 需 `CAST(...AS BIGINT)`，跨月只查存在的表（`to_regclass`）。
4. **匹配**：同金额分组（`Math.round(amount*100)` 转分）+ 时间就近优先，一订单只用一次；`gap>GAP_LIMIT=600s` 或无候选 → 默认 `Apple Pay`。**绝不按秒精确匹配**。
5. **写回**：`payload` 是 TEXT → `(jsonb_set(payload::jsonb,'{payment_channel}',to_jsonb($1::text)))::text`，事务内逐行，非 JSON 行守卫跳过，幂等可重跑。
6. **有界退出**：`try/finally` + `pool.end()` 干净退出，靠 CronJob 周期拉起（不常驻，避免 CrashLoop）。

## PG 适配点

- DSN 用 `AGENTIC_UG_DATABASE_URL` + `ssl:false`（自建 `pg.Pool`，不动 `packages/db` 的 `resolveDsn`）。
- 月表名 UTC 推导；`event_time` TEXT cast bigint；`payload` TEXT 走 `::jsonb` 中转写回。

## 验证结果

**基线窗口 `2026-07-14T23:00:00Z`（23:00–24:00 UTC）实跑：**

```
目标小时窗口 UTC [2026-07-14T23:00:00Z, 2026-07-15T00:00:00Z)
订单（含±120s缓冲）: 707
db ad_purchase 待打标: 656（表 records_202607）
匹配上订单渠道: 656，其余默认 Apple Pay: 0
打标渠道分布: {"Apple Pay":534,"ONERWAY":19,"WAFFO":103}
已写入 payment_channel 字段: 656 行 ✅
```

- **分布 Apple Pay 534 / WAFFO 103 / ONERWAY 19**，与旧 Python 脚本产出**完全一致**（curl 核心窗口真实值 535/104/19，误差 <2 单在预期内）。
- **幂等**：该小时数据此前已被旧脚本打标，新 TS 版重跑分布不变、656 行全部覆写成功。
- 本窗口 656 行全部匹配上订单（default 0），匹配质量高。

**编译/类型：**

- `pnpm -r typecheck` → 9 个项目全部 Done（含新 service）。
- `pnpm -r build` → exit 0（含 apps/web Next standalone）。
- 新 service TS 严格模式全开，无 `any` / `@ts-ignore`。

## 部署备注

- 镜像：Jenkins `docker build --target tag-payment-channel` 构建。
- Secret `agentic-ug-secrets` 需含 `AGENTIC_UG_DATABASE_URL` / `PAID_ORDERS_API_TOKEN`（manifest 用 `secretKeyRef` 占位，源码/manifest 不含真实 token）。
- schedule `:20`：给 AD 回传落库留延迟，窗口按 UTC 整点算。
