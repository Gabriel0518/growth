'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { getJson } from '@/lib/client/api';

/** 日报单行（汇总/渠道聚合行） */
interface ReportRow {
  date: string;
  channel: string;
  cost: number;
  rawRevenue: number;
  totalRevenue: number;
  deductedRevenue: number;
  totalProfit: number;
  rebate: number;
  pwaCost: number;
  netProfit: number;
  pureProfit: number;
  pureRate: number;
  reasoningCost: number;
  roas: number;
}

/** 产品×渠道明细行。投放利润/返点/PWA成本/推理成本由后端在这一层算好，前端不再自行计算。 */
interface DetailRow {
  date: string;
  product: string;
  channel: string;
  cost: number;
  count: number;
  rawRevenue: number;
  revenue: number;
  deductedRevenue: number;
  totalProfit: number;
  rebate: number;
  pwaCost: number;
  /** 推理成本：费率随数据日分段（2026-08-01 起 5%，此前 7%），故由后端按行算好 */
  reasoningCost: number;
}

interface OperatorInfo {
  code: string;
  name: string;
}

/** API 返回 */
interface ReportResponse {
  availableDates?: string[];
  operators?: OperatorInfo[];
  operator?: { code: string; name: string };
  columns?: string[];
  summaryRows?: ReportRow[];
  detailSheets?: Record<string, DetailRow[]>;
  sheetNames?: string[];
  error?: string;
}

const COLUMN_LABELS = [
  '日期',
  '渠道',
  '消耗',
  '原始收入',
  '总收入',
  '修正后扣费收入',
  '投放利润',
  '返点',
  'PWA成本',
  '运营净利润',
  '纯利润',
  '纯利率',
  '推理成本',
  '总ROAS',
];

/** 汇总表列：原始收入与修正后扣费收入只在产品分表看，汇总表不展示。 */
const SUMMARY_COLUMN_LABELS = COLUMN_LABELS.filter(
  (c) => c !== '原始收入' && c !== '修正后扣费收入',
);

function cellVal(v: number): string {
  if (Number.isNaN(v)) return '--';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function cellPct(v: number): string {
  if (Number.isNaN(v)) return '--';
  return `${(v * 100).toFixed(2)}%`;
}

function pickerBtnClass(active: boolean): string {
  const base =
    'rounded-md border px-3 py-1.5 text-[0.85rem] font-semibold whitespace-nowrap transition-colors cursor-pointer';
  return active
    ? `${base} border-accent bg-accent/10 text-accent`
    : `${base} border-border bg-bg text-text-dim hover:border-accent hover:text-accent`;
}

/**
 * 计算某个自然月的「平均行」。金额类（消耗/各类收入利润/成本）取算术平均（∑/天数），
 * 比值类（纯利率、总ROAS）按分子分母各自加总后再算——绝不对逐日比值再取算术平均。
 * label 即展示在「日期」列的文案（如「本月平均」「2026-07 平均」）。
 */
function computeMonthAvg(rows: ReportRow[], label: string): ReportRow {
  const n = rows.length;
  const sum = (pick: (r: ReportRow) => number): number => rows.reduce((s, r) => s + pick(r), 0);
  const mean = (pick: (r: ReportRow) => number): number => (n > 0 ? sum(pick) / n : 0);
  const totalRevenue = sum((r) => r.totalRevenue);
  const cost = sum((r) => r.cost);
  const pureProfit = sum((r) => r.pureProfit);
  return {
    date: label,
    channel: '',
    cost: mean((r) => r.cost),
    rawRevenue: mean((r) => r.rawRevenue),
    totalRevenue: mean((r) => r.totalRevenue),
    deductedRevenue: mean((r) => r.deductedRevenue),
    totalProfit: mean((r) => r.totalProfit),
    rebate: mean((r) => r.rebate),
    pwaCost: mean((r) => r.pwaCost),
    netProfit: mean((r) => r.netProfit),
    pureProfit: mean((r) => r.pureProfit),
    // 比值：分子分母加总再算（= 均值之比，与逐日比值均值不同，避免小分母日拉偏）。
    pureRate: totalRevenue > 0 ? pureProfit / totalRevenue : 0,
    reasoningCost: mean((r) => r.reasoningCost),
    roas: cost > 0 ? Math.round((totalRevenue / cost) * 1000) / 1000 : 0,
  };
}

/** 客户端当前自然月（YYYY-MM），用于把最新月的平均行标注为「本月平均」。 */
function currentYearMonth(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function DailyReportPanel(): React.ReactElement {
  const [operators, setOperators] = useState<OperatorInfo[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedOperator, setSelectedOperator] = useState('');
  const [summaryRows, setSummaryRows] = useState<ReportRow[]>([]);
  const [detailSheets, setDetailSheets] = useState<Record<string, DetailRow[]>>({});
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState('汇总');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 初始加载
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getJson<ReportResponse>('/api/daily-report')
      .then((data) => {
        if (cancelled) return;
        setAvailableDates(data.availableDates ?? []);
        setOperators(data.operators ?? []);
        setLoading(false);
      })
      .catch((error_: unknown) => {
        if (cancelled) return;
        setError(`加载失败：${error_ instanceof Error ? error_.message : String(error_)}`);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 加载投手数据
  useEffect(() => {
    if (!selectedOperator) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSummaryRows([]);
    setDetailSheets({});
    setSheetNames([]);

    getJson<ReportResponse>(`/api/daily-report?operator=${selectedOperator}`)
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
        } else {
          setSummaryRows(data.summaryRows ?? []);
          setDetailSheets(data.detailSheets ?? {});
          setSheetNames(data.sheetNames ?? ['汇总']);
        }
        setLoading(false);
      })
      .catch((error_: unknown) => {
        if (cancelled) return;
        setError(`加载失败：${error_ instanceof Error ? error_.message : String(error_)}`);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedOperator]);

  // 当前显示的行
  const displayRows = useMemo(() => {
    if (selectedSheet === '汇总') return summaryRows;
    const rows = detailSheets[selectedSheet];
    if (!rows || rows.length === 0) return [];
    // 明细行的投放利润/返点/PWA成本/推理成本已由后端算好，这里只补派生字段（比值类）。
    return rows.map((r) => {
      const netProfit = r.totalProfit - r.pwaCost + r.rebate;
      const { reasoningCost } = r;
      const pureProfit = netProfit - reasoningCost;
      return {
        date: r.date,
        channel: r.product,
        cost: r.cost,
        rawRevenue: r.rawRevenue,
        totalRevenue: r.revenue,
        deductedRevenue: r.deductedRevenue,
        totalProfit: r.totalProfit,
        rebate: r.rebate,
        pwaCost: r.pwaCost,
        netProfit,
        pureProfit,
        pureRate: r.revenue > 0 ? pureProfit / r.revenue : 0,
        reasoningCost,
        roas: r.cost > 0 ? Math.round((r.revenue / r.cost) * 1000) / 1000 : 0,
      };
    });
  }, [selectedSheet, summaryRows, detailSheets]);

  /** 当前 sheet 的列：汇总表隐去原始收入与修正后扣费收入。 */
  const columns = useMemo(
    () => (selectedSheet === '汇总' ? SUMMARY_COLUMN_LABELS : COLUMN_LABELS),
    [selectedSheet],
  );

  // 总计行
  const totalRow = useMemo((): ReportRow | null => {
    if (displayRows.length === 0) return null;
    const cost = displayRows.reduce((s, r) => s + r.cost, 0);
    const rawRevenue = displayRows.reduce((s, r) => s + r.rawRevenue, 0);
    const totalRevenue = displayRows.reduce((s, r) => s + r.totalRevenue, 0);
    const deductedRevenue = displayRows.reduce((s, r) => s + r.deductedRevenue, 0);
    const totalProfit = displayRows.reduce((s, r) => s + r.totalProfit, 0);
    const rebate = displayRows.reduce((s, r) => s + r.rebate, 0);
    const pwaCost = displayRows.reduce((s, r) => s + r.pwaCost, 0);
    const pureProfit = displayRows.reduce((s, r) => s + r.pureProfit, 0);
    const netProfit = displayRows.reduce((s, r) => s + r.netProfit, 0);
    const reasoningCost = displayRows.reduce((s, r) => s + r.reasoningCost, 0);
    return {
      date: '合计',
      channel: '',
      cost,
      rawRevenue,
      totalRevenue,
      deductedRevenue,
      totalProfit,
      rebate,
      pwaCost,
      netProfit,
      pureProfit,
      pureRate: totalRevenue > 0 ? pureProfit / totalRevenue : 0,
      reasoningCost,
      roas: cost > 0 ? Math.round((totalRevenue / cost) * 1000) / 1000 : 0,
    };
  }, [displayRows]);

  // 渲染列表：仅「汇总」表在每个自然月的日行块前插入该月平均行（displayRows 已按日期倒序，
  // 故同月连续）。最新月（=当前自然月）标「本月平均」，其余标「YYYY-MM 平均」，
  // 即需求所说「第一行本月平均 + 两月交界处前一月平均」。合计行不变、仍在表底。
  const renderItems = useMemo((): { row: ReportRow; isAvg: boolean }[] => {
    const items: { row: ReportRow; isAvg: boolean }[] = [];
    if (displayRows.length === 0) return items;
    if (selectedSheet !== '汇总') {
      for (const r of displayRows) items.push({ row: r, isAvg: false });
      return items;
    }
    const curYm = currentYearMonth();
    let group: ReportRow[] = [];
    let groupYm = '';
    const flush = (): void => {
      if (group.length === 0) return;
      const label = groupYm === curYm ? '本月平均' : `${groupYm} 平均`;
      items.push({ row: computeMonthAvg(group, label), isAvg: true });
      for (const r of group) items.push({ row: r, isAvg: false });
      group = [];
    };
    for (const r of displayRows) {
      const ym = r.date.slice(0, 7);
      if (ym !== groupYm) {
        flush();
        groupYm = ym;
      }
      group.push(r);
    }
    flush();
    return items;
  }, [displayRows, selectedSheet]);

  /** 渲染单元格 */
  function renderCell(col: string, row: ReportRow): string {
    switch (col) {
      case '日期': {
        return row.date;
      }
      case '渠道': {
        return row.channel;
      }
      case '纯利率': {
        return cellPct(row.pureRate);
      }
      case '总ROAS': {
        return cellVal(row.roas);
      }
      default: {
        return cellVal(
          col === '消耗'
            ? row.cost
            : col === '原始收入'
              ? row.rawRevenue
              : col === '总收入'
                ? row.totalRevenue
                : col === '修正后扣费收入'
                  ? row.deductedRevenue
                  : col === '投放利润'
                    ? row.totalProfit
                    : col === '返点'
                      ? row.rebate
                      : col === 'PWA成本'
                        ? row.pwaCost
                        : col === '推理成本'
                          ? row.reasoningCost
                          : col === '运营净利润'
                            ? row.netProfit
                            : col === '纯利润'
                              ? row.pureProfit
                              : 0,
        );
      }
    }
  }

  /** 下载 CSV：与表格所见完全一致——月平均行 + 逐日行 + 表底合计行，一并导出。 */
  const downloadCsv = useCallback(() => {
    const header = columns.join(',');
    // renderItems 已含月平均行（汇总表）或纯日行（明细表）；末尾再补合计行，和页面顺序一致。
    const lines = renderItems.map(({ row }) =>
      columns.map((col) => renderCell(col, row).replaceAll(',', '')).join(','),
    );
    if (totalRow) {
      lines.push(
        columns
          .map((col) => (col === '日期' ? '合计' : renderCell(col, totalRow).replaceAll(',', '')))
          .join(','),
      );
    }
    const csv = `\uFEFF${header}\n${lines.join('\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dateRange =
      availableDates.length > 0 ? `${availableDates.at(-1) ?? ''}~${availableDates[0] ?? ''}` : '';
    a.download = `日报-${selectedOperator}-${selectedSheet}-${dateRange}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [columns, renderItems, totalRow, selectedOperator, selectedSheet, availableDates]);

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      {/* 顶部栏：投手 / Sheet 选择 */}
      <div className="mb-4 rounded-lg border border-border bg-bg-card p-4">
        <div className="mb-2 flex items-center gap-2">
          <label className="text-[0.85rem] font-medium text-text-dim">👤 投手</label>
          {availableDates.length > 0 && selectedOperator && (
            <span className="text-[0.8rem] text-text-dim">
              📅 {availableDates.at(-1)} ~ {availableDates[0]}（{availableDates.length}天）
            </span>
          )}
          {displayRows.length > 0 && (
            <button
              type="button"
              onClick={downloadCsv}
              className="ml-auto rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-[0.85rem] font-semibold text-accent transition-colors hover:bg-accent/20"
            >
              ⬇ 下载 CSV
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {operators.map((op) => (
            <button
              key={op.code}
              type="button"
              onClick={() => {
                setSelectedOperator(op.code);
                setSelectedSheet('汇总');
              }}
              className={pickerBtnClass(selectedOperator === op.code)}
            >
              {op.name}
            </button>
          ))}
        </div>

        {sheetNames.length > 0 && (
          <>
            <div className="mt-3 mb-2 flex items-center gap-2">
              <label className="text-[0.85rem] font-medium text-text-dim">📄 Sheet</label>
            </div>
            <div className="flex flex-wrap gap-2">
              {sheetNames.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    setSelectedSheet(name);
                  }}
                  className={pickerBtnClass(selectedSheet === name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 状态 */}
      {!selectedOperator && !loading && (
        <div className="py-12 text-center text-text-dim">请先选择投手</div>
      )}
      {loading && <div className="py-8 text-center text-text-muted">加载中...</div>}
      {error && <div className="py-8 text-center text-red">{error}</div>}

      {/* 表格 */}
      {displayRows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-[0.82rem]">
            <thead>
              <tr className="bg-bg-card">
                {columns.map((label) => (
                  <th
                    key={label}
                    className={`border-b border-border px-3 py-2.5 font-semibold text-text ${
                      label === '日期' || label === '渠道' ? 'text-left' : 'text-right'
                    }`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {renderItems.map(({ row, isAvg }, idx) => (
                <tr
                  key={isAvg ? `avg-${row.date}` : `${row.date}-${row.channel}-${String(idx)}`}
                  className={
                    isAvg
                      ? 'border-y border-accent/30 bg-accent/5 font-semibold text-accent'
                      : 'border-b border-border/50 transition-colors hover:bg-bg-card/50'
                  }
                >
                  {columns.map((col) => (
                    <td
                      key={col}
                      className={`px-3 py-2 ${
                        col === '日期' || col === '渠道' ? 'text-left' : 'text-right'
                      }`}
                    >
                      {renderCell(col, row)}
                    </td>
                  ))}
                </tr>
              ))}
              {totalRow && (
                <tr className="border-t-2 border-accent/30 bg-accent/10 font-bold">
                  {columns.map((col) => (
                    <td
                      key={col}
                      className={`px-3 py-2.5 ${
                        col === '日期' || col === '渠道' ? 'text-left' : 'text-right'
                      }`}
                    >
                      {col === '日期' && '合计'}
                      {col !== '日期' && renderCell(col, totalRow)}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
