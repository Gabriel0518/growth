# dataserver（端口 5000）—— 数据接收服务

> 专家文档：数据接收与存储层。从 SERVER_OVERVIEW.md 拆分。

---

## 基本信息

- 代码：`/home/admin/dataserver/app.py`（FastAPI + uvicorn + uvloop + aiosqlite）
- Python 版本：3.6.8
- 服务文件：`/etc/systemd/system/dataserver.service`
  - `uvicorn app:app --host 0.0.0.0 --port 5000 --workers 2 --loop uvloop --http httptools --log-level warning --backlog 2048`
  - `LimitNOFILE=65536`

## 数据库

- 路径：`/home/admin/dataserver/data.db`（~629MB，SQLite WAL 模式）
- 按月分表：`records_YYYYMM`（当前 `records_202605` ~76.5万条 + `records_202606` ~13.6万条，总计级1GB）
- **索引**：
  - `idx_records_YYYYMM_campaign(campaign)` + `idx_records_YYYYMM_camp_evt_time(campaign, event_name, date(event_time, '+8 hours'))` — AI 建议查询依赖
  - `idx_records_YYYYMM_evt_app_camp(event_name, app_id, campaign)` + `idx_records_YYYYMM_evt_app_ms(event_name, app_id, media_source)` — campaign-context 查询依赖（2026-06-05）
  - `idx_records_YYYYMM_evt_time_range(event_name, event_time)` + `idx_records_YYYYMM_evt_inst_range(event_name, install_time)` — channel-summary 范围查询依赖（2026-06-10）
- 写入采用队列 + 批量 flush（`QUEUE_MAXSIZE=20000, BATCH_SIZE=500, FLUSH_INTERVAL=1.0s`）
- 自动每日 WAL checkpoint

### 表结构（`records_YYYYMM`）

```
id, source, app_id, event_name, event_time, revenue, currency,
campaign, media_source, ad_id, adset, country, device_id,
install_time, is_retargeting, payload(JSON), created_at
```

### ⚠️ 新月份索引

`records_YYYYMM` 表在新增月份时需要手动创建索引（dataserver 的 app.py 不自动创建）：
```sql
-- 单列索引
CREATE INDEX IF NOT EXISTS idx_records_YYYYMM_campaign ON records_YYYYMM(campaign);
CREATE INDEX IF NOT EXISTS idx_records_YYYYMM_camp_evt_time ON records_YYYYMM(campaign, event_name, date(event_time, '+8 hours'));

-- 组合索引（campaign-context 查询性能关键，2026-06-05 新增）
CREATE INDEX IF NOT EXISTS idx_records_YYYYMM_evt_app_camp ON records_YYYYMM(event_name, app_id, campaign);
CREATE INDEX IF NOT EXISTS idx_records_YYYYMM_evt_app_ms ON records_YYYYMM(event_name, app_id, media_source);

-- 复合索引（channel-summary / correction-factors 范围查询性能关键，2026-06-10 新增）
CREATE INDEX IF NOT EXISTS idx_records_YYYYMM_evt_time_range ON records_YYYYMM(event_name, event_time);
CREATE INDEX IF NOT EXISTS idx_records_YYYYMM_evt_inst_range ON records_YYYYMM(event_name, install_time);
CREATE INDEX IF NOT EXISTS idx_records_YYYYMM_evt_app_time ON records_YYYYMM(event_name, app_id, event_time);
```

## API 接口

| 接口 | 说明 |
|------|------|
| `GET/POST /adjust` | Adjust 回传（即 "ad"） |
| `GET/POST /appsflyer` | AppsFlyer 回传（即 "af"） |
| `POST /data` | 通用接收 |
| `GET /data` | 查询 |
| `GET /stats` | 表统计、DB 大小 |
| `GET /` | 健康检查 |
| `POST /admin` | 接收雅典娜收入推送（按日期存 `/home/admin/dataserver/athena_data/YYYY-MM-DD.json`） |
| `GET /admin?date=YYYY-MM-DD` | 查询已收到的雅典娜数据 |

## 回传事件类型

| 事件 | 说明 |
|------|------|
| `af_purchase` / `ad_purchase` | 付费事件（有 revenue） |
| `af_complete_registration` / `ad_complete_registration` | 注册完成事件（用作"安装"计数，计算 CPI） |

## 数据字段注意事项

- AF `event_time`/`install_time`：ISO 格式文本（UTC），如 `2026-05-11 16:17:24.493`
- AD `event_time`/`install_time`：**Unix 时间戳（秒）**
- AD 字段 `campaign`/`adgroup`/`creative` 是 URL 编码的，末尾带 `(唯一ID)` 括号
- server.js 在读取 AD 数据时自动 decode + 去括号
- AD（Adjust）数据仅限 iOS 产品（Dora iOS / Romi iOS / Luma），Android 产品无 AD 数据

## 告警脚本

`alert_monitor.py`：
- `af_purchase` 过去 60 min 事件数 ≤ 前日同时段均值 × 2% → 报警
- 总事件 < 5% → 报警
- 锁目录：`.alert_locks/`，30 分钟冷却
