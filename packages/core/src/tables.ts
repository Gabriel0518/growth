/**
 * 月表命名工具 —— 月表按【北京自然月】切分，与看板侧 dashboard/dates.ts 同口径。
 *
 * 历史坑（2026-08-01）：本文件原先用 now.getFullYear()/getMonth() 取【运行环境本地时区】的年月，
 * 而部署镜像未设 TZ（见 deploy/Dockerfile），容器内即 UTC。于是北京已进入 8 月、UTC 仍是 7 月的
 * 那 8 小时里，新数据继续写进了 records_202607；而看板选表走 dates.ts 的北京口径、只查
 * records_202608，两边错位导致 8/1 全天数据显示为 0（表不存在则静默跳过，不报错）。
 *
 * 因此这里改为显式的北京口径：epoch 偏移 +8h 后取 UTC 分量，与系统时区完全解耦
 * （同 dashboard/dates.ts、services/scheduler 的既有写法），不依赖镜像是否设置 TZ。
 */

const BEIJING_OFFSET_MS = 8 * 3_600_000;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/** 北京墙上时间的 Date：其 getUTC* 分量即北京年月日时分秒。 */
function beijingParts(now: Date): Date {
  return new Date(now.getTime() + BEIJING_OFFSET_MS);
}

/** records_YYYYMM，取【北京】当前年月。 */
export function currentTable(now: Date = new Date()): string {
  const b = beijingParts(now);
  return `records_${b.getUTCFullYear().toString()}${pad2(b.getUTCMonth() + 1)}`;
}

/**
 * 根据日期字符串（取前 10 位 YYYY-MM-DD）推断表名；解析失败回退当前月表。
 * 对应 Python：datetime.strptime(dt_str[:10], "%Y-%m-%d")，异常则 current_table()。
 *
 * 表名只由入参的年月决定，与时区无关；中间那次 new Date(y, m-1, d) 仅用于校验日期是否真实存在
 * （如 2026-02-31 会进位而校验失败），构造与读取都在同一本地时区、互相抵消。
 */
export function tableForDate(dtStr: string): string {
  const head = dtStr.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(head);
  if (!match) return currentTable();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
    return currentTable();
  }
  return `records_${year.toString()}${pad2(month)}`;
}

/**
 * YYYY-MM-DD → records_YYYYMM，纯字符串切片、不校验日期真实性。
 *
 * 与上面 tableForDate 的区别：tableForDate 会校验日期存在性并在解析失败时回退当前月表，
 * 供写入侧使用；本函数供【查询侧】按已知合法日期定位月表，缺表由调用方自行处理。
 * 看板侧 apps/web/src/lib/dashboard/dates.ts 直接 re-export 本函数，保证选表口径唯一。
 */
export function tableForMonth(dateStr: string): string {
  return `records_${dateStr.slice(0, 4)}${dateStr.slice(5, 7)}`;
}

export interface BeijingDayBounds {
  /** af_* UTC 字符串下界（含），'YYYY-MM-DD HH:MM:SS'。 */
  strLo: string;
  /** af_* UTC 字符串上界（不含）。 */
  strHi: string;
  /** ad_* unix 秒下界（含）。 */
  epLo: number;
  /** ad_* unix 秒上界（不含）。 */
  epHi: number;
}

/**
 * 某北京自然日 YYYY-MM-DD 的 sargable 边界。
 * 北京一日 [00:00,24:00) 即 UTC [midnight-8h, midnight+16h)。
 * af_* 存 UTC 字符串（字典序==时序，可作精确范围）；ad_* 存 unix 秒。
 */
export function beijingDayBounds(dateStr: string): BeijingDayBounds {
  const loMs = Date.parse(`${dateStr}T00:00:00+08:00`);
  const hiMs = loMs + 86_400_000;
  const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return {
    strLo: fmt(loMs),
    strHi: fmt(hiMs),
    epLo: Math.floor(loMs / 1000),
    epHi: Math.floor(hiMs / 1000),
  };
}

/**
 * created_at 时间戳，格式 "YYYY-MM-DD HH:mm:ss"（【北京】时间）。
 *
 * 注意：2026-08-01 之前写入的历史行，此列是 UTC（旧实现取运行环境本地时区，容器内为 UTC），
 * 之后为北京时间，两段相差 8 小时且不连续。该列仅用于展示「最新数据时间」
 * （apps/web/src/lib/records.ts 取当前月表末行），无业务聚合依赖，故不回填历史。
 * 业务时间一律以 event_time 为准。
 */
export function formatTimestamp(now: Date = new Date()): string {
  const b = beijingParts(now);
  const date = `${b.getUTCFullYear().toString()}-${pad2(b.getUTCMonth() + 1)}-${pad2(b.getUTCDate())}`;
  const time = `${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}:${pad2(b.getUTCSeconds())}`;
  return `${date} ${time}`;
}
