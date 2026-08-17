/**
 * 前端格式化助手 —— 逐字复刻旧 dashboard/public/app.js 的 fmt/fmtPct/fmtDelta/fmtTime 等。
 * 保持零行为差异：货币两位小数、百分比一位、时间用 Asia/Shanghai。
 */

/** $1,234.56，无值/NaN → '--'。 */
export function fmt(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val)) return '--';
  return `$${val.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 12.3%，无值/NaN → '--'。 */
export function fmtPct(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val)) return '--';
  return `${val.toFixed(1)}%`;
}

/** +$12.34 / -$12.34，0/无值 → ''。 */
export function fmtDelta(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val) || val === 0) return '';
  const sign = val > 0 ? '+' : '-';
  return `${sign}$${Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** +1.2% / -1.2%，0/无值 → ''。 */
export function fmtDeltaPct(val: number | null | undefined): string {
  if (val == null || Number.isNaN(val) || val === 0) return '';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(1)}%`;
}

/** ISO → 'YYYY/MM/DD HH:MM:SS'（Asia/Shanghai）。 */
export function fmtTime(isoStr: string | null | undefined): string {
  if (!isoStr) return '--';
  return new Date(isoStr).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

/** ISO → 'HH:MM'（Asia/Shanghai）。 */
export function fmtShortTime(isoStr: string | null | undefined): string {
  if (!isoStr) return '--';
  return new Date(isoStr).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 本地今日 'YYYY-MM-DD'。 */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear().toString()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 前一天 'YYYY-MM-DD'。 */
export function prevDateStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear().toString()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 上周同一天 'YYYY-MM-DD'（7 天前）。 */
export function weekAgoDateStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - 7);
  return `${d.getFullYear().toString()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 两个 'YYYY-MM-DD' 之间的天数（含两端）。 */
export function daySpan(lo: string, hi: string): number {
  return Math.round((new Date(hi).getTime() - new Date(lo).getTime()) / 86_400_000) + 1;
}
