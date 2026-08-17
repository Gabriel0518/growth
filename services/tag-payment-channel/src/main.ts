import pg from 'pg';

/**
 * tag-payment-channel —— 给 AD ad_purchase 事件补「支付渠道」字段（PG 生产版）
 *
 * 逐字搬 dataserver/tag_payment_channel.py 的口径到 PostgreSQL：
 *   1. 确定目标小时窗口 [winStart, winEnd)（UTC 整点，默认=上一个完整小时；支持 argv 指定）
 *   2. 拉 paid-orders API 该小时前后各 BUFFER 秒的订单（含 channel 支付渠道）
 *   3. 取 PG 月表 records_YYYYMM 中该小时的 ad_purchase 行（按 event_time,id 升序）
 *   4. 同金额分组 + 时间就近优先匹配（一个订单只用一次；gap>GAP_LIMIT 视为不可信）
 *   5. 匹配上→写订单 channel；db 有订单无→默认 Apple Pay；订单有 db 无→丢弃
 *   6. jsonb_set 在 payload 里写入 payment_channel 字段（不动表结构，幂等可重跑）
 *
 * 以「有界一次性 Job」运行：跑完 pool.end() 干净退出，由 k8s CronJob 每小时周期拉起。
 *
 * PG 适配要点（相对旧 SQLite 版）：
 *   - event_time 是 TEXT 存 Unix 秒，查询/比较必须 CAST(event_time AS BIGINT)。
 *   - 月表名按【北京月】推算（不复用 packages/core 的 tableForDate），跨月只查存在的表。
 *   - payload 列是 TEXT，写回需 (jsonb_set(payload::jsonb, ...))::text；非 JSON 行守卫跳过。
 *   - DSN 用 AGENTIC_UG_DATABASE_URL + ssl:false（不复用 packages/db 的 resolveDsn）。
 *
 * 用法：
 *   node dist/main.js                       # 处理上一个完整 UTC 小时
 *   node dist/main.js 2026-07-14T23:00:00Z  # 处理指定 UTC 整点那一小时（回补用）
 */

const API_URL = 'https://admin-api-prod.sitin.ai/api/open/admin/paid-orders';
const BUFFER = 120; // 订单前后各多读 120s（±2 分钟）缓冲，抗跨小时错配
const GAP_LIMIT = 600; // 匹配时间差超过此值(秒)视为不可信 → 默认 Apple Pay
const DEFAULT_CHANNEL = 'Apple Pay';
const FETCH_TIMEOUT_MS = 60_000;

/** 结构化日志（stdout，k8s 收集），带 ISO 时间戳。 */
function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Unix 秒 → `YYYY-MM-DDTHH:MM:SSZ`（无毫秒，对齐 Python iso_z 发给 API 的格式）。 */
function isoZ(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Unix 秒 → 月表名 records_YYYYMM，按【北京自然月】切分。
 *
 * 月表的实际切分口径是北京月（见 packages/core/src/tables.ts 的 currentTable 与
 * dashboard/dates.ts 的 tableForMonth），此处必须一致。原实现按 UTC 月推算，
 * 在北京已跨月、UTC 未跨月的那 8 小时里会去上个月的表找 ad_purchase 而扑空，
 * 导致这批订单补不上 payment_channel（2026-08-01 即因此漏了两小时）。
 *
 * 处理的时间窗口本身仍是 UTC 整点（CronJob 按 UTC 每小时拉起），只有「这一刻属于哪张月表」
 * 改成北京口径 —— 二者互不影响。
 */
function monthTableForSec(sec: number): string {
  const d = new Date(sec * 1000 + 8 * 3_600_000); // +8h 后取 UTC 分量 = 北京墙上时间
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `records_${y.toString().padStart(4, '0')}${m.toString().padStart(2, '0')}`;
}

/** 目标小时可能横跨两个月表（仅北京月 1 号 0 点那一小时），返回涉及的月表名（去重排序）。 */
function monthTablesFor(winStart: number, winEnd: number): string[] {
  const set = new Set<string>();
  set.add(monthTableForSec(winStart));
  set.add(monthTableForSec(winEnd - 1));
  return [...set].sort();
}

/** paidAt（`2026-07-14T23:00:08.000Z`）→ Unix 秒（截断到整秒，对齐 Python timetuple）。 */
function paidAtSec(paidAt: string): number {
  return Math.floor(Date.parse(paidAt) / 1000);
}

/** 金额（字符串/数字）→ 分（四舍五入），用于同金额分组。 */
function normAmt(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

interface Order {
  paidSec: number;
  channel: string;
  amtCents: number;
  used: boolean;
}

interface DbRow {
  id: string; // BIGSERIAL，pg 以字符串返回，直接用于 WHERE id=$
  table: string; // 归属月表，写回时定位
  tsSec: number;
  amtCents: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 拉订单（带缓冲窗口）。用 Node 原生 fetch，先清掉代理环境变量直连该 API，
 * 加 AbortController 超时；校验 success 与响应结构后返回过滤到缓冲窗口内的订单。
 */
async function fetchOrders(winStart: number, winEnd: number, token: string): Promise<Order[]> {
  // 本机直连该 API，别走代理（对齐旧脚本的 unset proxy 直连）。
  for (const key of ['https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY']) {
    // 这里必须用 delete：process.env 赋 undefined 会被 Node 存成字符串 "undefined"，
    // 反而变成一个「有值」的代理配置，直连就失效了。故禁用 no-dynamic-delete。
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env[key];
  }

  const body = JSON.stringify({
    start: isoZ(winStart - BUFFER),
    end: isoZ(winEnd + BUFFER),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  let json: unknown;
  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`API HTTP ${resp.status.toString()}`);
    }
    json = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  if (!isRecord(json) || json['success'] !== true) {
    throw new Error(`API 返回 success!=true: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const data = json['data'];
  const rawOrders = isRecord(data) ? data['orders'] : undefined;
  if (!Array.isArray(rawOrders)) {
    throw new TypeError('API 返回缺少 data.orders 数组');
  }

  const lo = winStart - BUFFER;
  const hi = winEnd + BUFFER;
  const orders: Order[] = [];
  for (const raw of rawOrders) {
    if (!isRecord(raw)) continue;
    const paidAt = raw['paidAt'];
    const amount = raw['amount'];
    const channel = raw['channel'];
    if (typeof paidAt !== 'string' || typeof channel !== 'string') continue;
    if (typeof amount !== 'string' && typeof amount !== 'number') continue;
    const sec = paidAtSec(paidAt);
    // 只保留缓冲窗口内的订单（对齐 Python 的二次过滤）。
    if (sec < lo || sec >= hi) continue;
    orders.push({ paidSec: sec, channel, amtCents: normAmt(amount), used: false });
  }
  return orders;
}

/** 判断表是否存在（to_regclass 不存在返回 NULL）。 */
async function tableExists(pool: pg.Pool, table: string): Promise<boolean> {
  const r = await pool.query<{ reg: string | null }>('SELECT to_regclass($1) AS reg', [
    `public.${table}`,
  ]);
  return r.rows[0]?.reg != null;
}

/** 取目标小时内待打标的 ad_purchase 行（跨月合并，按 (ts,id) 升序）。 */
async function fetchDbRows(
  pool: pg.Pool,
  tables: string[],
  winStart: number,
  winEnd: number,
): Promise<{ rows: DbRow[]; usedTables: string[] }> {
  const rows: DbRow[] = [];
  const usedTables: string[] = [];
  for (const table of tables) {
    if (!(await tableExists(pool, table))) continue;
    usedTables.push(table);
    const res = await pool.query<{ id: string; ts: string; revenue: number | null }>(
      `SELECT id, CAST(event_time AS BIGINT) AS ts, revenue
         FROM ${table}
        WHERE event_name = 'ad_purchase'
          AND CAST(event_time AS BIGINT) >= $1
          AND CAST(event_time AS BIGINT) < $2`,
      [winStart, winEnd],
    );
    for (const r of res.rows) {
      rows.push({ id: r.id, table, tsSec: Number(r.ts), amtCents: normAmt(r.revenue ?? 0) });
    }
  }
  // 跨表合并后统一按 (ts, id) 升序（id 为数值序，字符串比较不可靠故转数值）。
  rows.sort((a, b) => a.tsSec - b.tsSec || Number(a.id) - Number(b.id));
  return { rows, usedTables };
}

/** 同金额分组 + 时间就近优先匹配（一个订单只用一次），返回 row→channel 及匹配计数。 */
function assignChannels(
  rows: DbRow[],
  orders: Order[],
): { assigned: Map<DbRow, string>; matched: number } {
  const byAmt = new Map<number, Order[]>();
  for (const o of orders) {
    const list = byAmt.get(o.amtCents);
    if (list) list.push(o);
    else byAmt.set(o.amtCents, [o]);
  }

  const assigned = new Map<DbRow, string>();
  let matched = 0;
  for (const row of rows) {
    const cands = byAmt.get(row.amtCents) ?? [];
    let best: Order | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const o of cands) {
      if (o.used) continue;
      const diff = Math.abs(o.paidSec - row.tsSec);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = o;
      }
    }
    if (best && bestDiff <= GAP_LIMIT) {
      best.used = true;
      assigned.set(row, best.channel);
      matched += 1;
    } else {
      assigned.set(row, DEFAULT_CHANNEL);
    }
  }
  return { assigned, matched };
}

/**
 * 事务内逐行写回 payload.payment_channel（幂等）。payload 列是 TEXT：
 * (jsonb_set(payload::jsonb, ...))::text；只更新 payload 是 JSON 对象的行（守卫非法 JSON，
 * 避免 ::jsonb 抛错整批回滚）。返回实际更新行数。
 */
async function writeBack(pool: pg.Pool, assigned: Map<DbRow, string>): Promise<number> {
  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query('BEGIN');
    for (const [row, channel] of assigned) {
      const res = await client.query(
        `UPDATE ${row.table}
            SET payload = (jsonb_set(payload::jsonb, '{payment_channel}', to_jsonb($1::text)))::text
          WHERE id = $2
            AND payload ~ '^[[:space:]]*[{]'`,
        [channel, row.id],
      );
      updated += res.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return updated;
}

/** 解析目标小时窗口起点（Unix 秒，对齐整点）。 */
function resolveWinStart(arg: string | undefined): number {
  if (arg) {
    const ms = Date.parse(arg);
    if (Number.isNaN(ms)) {
      throw new TypeError(`无法解析时间参数: ${arg}（应为 2026-07-14T23:00:00Z）`);
    }
    const sec = Math.floor(ms / 1000);
    return sec - (sec % 3600);
  }
  const now = Math.floor(Date.now() / 1000);
  // 上一个完整 UTC 整点小时。
  return Math.floor(now / 3600) * 3600 - 3600;
}

async function main(): Promise<void> {
  const dsn = process.env['AGENTIC_UG_DATABASE_URL'];
  if (!dsn) throw new Error('缺少环境变量 AGENTIC_UG_DATABASE_URL');
  const token = process.env['PAID_ORDERS_API_TOKEN'];
  if (!token) throw new Error('缺少环境变量 PAID_ORDERS_API_TOKEN');

  const winStart = resolveWinStart(process.argv[2]);
  const winEnd = winStart + 3600;
  log(`目标小时窗口 UTC [${isoZ(winStart)}, ${isoZ(winEnd)})`);

  // 1. 拉订单（含 ±BUFFER 缓冲）。
  const orders = await fetchOrders(winStart, winEnd, token);
  log(`订单（含±${BUFFER.toString()}s缓冲）: ${orders.length.toString()}`);

  // 显式 ssl:false（DSN 已带 sslmode=disable，双保险；不复用 packages/db 的连接池）。
  const pool = new pg.Pool({ connectionString: dsn, ssl: false });
  try {
    // 2. 取 db 该小时 ad_purchase 待打标行。
    const tables = monthTablesFor(winStart, winEnd);
    const { rows, usedTables } = await fetchDbRows(pool, tables, winStart, winEnd);
    log(`db ad_purchase 待打标: ${rows.length.toString()}（表 ${usedTables.join(',') || '无'}）`);
    if (rows.length === 0) {
      log('无待打标数据，退出');
      return;
    }

    // 3. 匹配。
    const { assigned, matched } = assignChannels(rows, orders);
    const dist = new Map<string, number>();
    for (const ch of assigned.values()) dist.set(ch, (dist.get(ch) ?? 0) + 1);
    log(
      `匹配上订单渠道: ${matched.toString()}，其余默认 ${DEFAULT_CHANNEL}: ${(rows.length - matched).toString()}`,
    );
    log(`打标渠道分布: ${JSON.stringify(Object.fromEntries(dist))}`);

    // 4. 写回 payload（幂等）。
    const updated = await writeBack(pool, assigned);
    log(`已写入 payment_channel 字段: ${updated.toString()} 行 ✅`);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  log(`❌ 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
