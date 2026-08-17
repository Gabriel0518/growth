'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { SummaryTrendChart } from './summary-trend-chart';
import type { PanelProps } from './types';
import { XmpBackfillModal } from './xmp-backfill-modal';

import { getJson, getJsonSoft } from '@/lib/client/api';
import {
  fmt,
  fmtDelta,
  fmtDeltaPct,
  fmtPct,
  fmtShortTime,
  fmtTime,
  prevDateStr,
  todayStr,
  weekAgoDateStr,
} from '@/lib/client/format';
import {
  buildHourlyPairs,
  buildProductRow,
  CHANNEL_LABELS,
  CHANNEL_ORDER,
  deltaClass,
  EXPAND_CARD_CONFIG,
  fmtDeltaMoney,
  findSameTimeSnapshot,
  PRODUCTS,
  sortRows,
} from '@/lib/client/summary';
import type {
  AfSummaryResponse,
  CardKey,
  ChannelBucket,
  ChannelSummaryResponse,
  DayData,
  ProductRow,
  SortField,
} from '@/lib/client/summary';

interface DataBundle {
  dayData: DayData;
  prevDayData: DayData | null;
  weekAgoData: DayData | null;
  afSummary: AfSummaryResponse | null;
  prevAfSummary: AfSummaryResponse | null;
  weekAgoAfSummary: AfSummaryResponse | null;
}

const SIGN_CLASS = {
  positive: 'text-green',
  negative: 'text-red',
  neutral: 'text-text-muted',
} as const;

function deltaTextClass(val: number | null, type: 'money' | 'pct'): { text: string; cls: string } {
  if (val == null || Number.isNaN(val)) return { text: '', cls: SIGN_CLASS.neutral };
  if (Math.abs(val) < 0.005) return { text: '无变化', cls: SIGN_CLASS.neutral };
  const text = type === 'pct' ? fmtDeltaPct(val) : fmtDelta(val);
  return { text, cls: val > 0 ? SIGN_CLASS.positive : SIGN_CLASS.negative };
}

function naCell(): React.ReactElement {
  return <span className="text-text-muted">--</span>;
}

interface Totals {
  totalAthena: number;
  totalAthenaNew: number;
  totalAF: number;
  totalAFLTV: number;
  totalXMP: number;
  totalROI: number | null;
}

/** 用同一时间的对比快照（昨日 / 上周）算出各卡片的差距文案。 */
function computeCompareDeltas(
  totals: Totals,
  compareData: DayData | null,
  compareAfSummary: AfSummaryResponse | null,
  afSummary: AfSummaryResponse | null,
  latestTime: string | null | undefined,
  hintPrefix: string,
): { deltas: Record<CardKey | 'roi', { text: string; cls: string }>; hint: string } | null {
  if (latestTime == null) return null;
  const match = findSameTimeSnapshot(compareData, latestTime);
  if (!match) return null;
  const rows = PRODUCTS.map((p) => buildProductRow(p, match, afSummary));
  const pAthena = rows.reduce((s, r) => s + (r.athenaTotal ?? 0), 0);
  const pAthenaNew = rows.reduce((s, r) => s + (r.athenaNew ?? 0), 0);
  const pXMP = rows.reduce((s, r) => s + (r.xmpCost ?? 0), 0);
  let pAF = 0;
  let pAFLTV = 0;
  if (compareAfSummary) {
    for (const p of Object.values(compareAfSummary.products)) {
      pAF += p.revenueActual;
      pAFLTV += p.revenueLTV;
    }
  }
  const pROI = pXMP > 0 ? (pAthenaNew / pXMP) * 100 : null;
  const deltas: Record<CardKey | 'roi', { text: string; cls: string }> = {
    athena: deltaTextClass(totals.totalAthena - pAthena, 'money'),
    'athena-new': deltaTextClass(totals.totalAthenaNew - pAthenaNew, 'money'),
    af: deltaTextClass(totals.totalAF - pAF, 'money'),
    'af-ltv': deltaTextClass(totals.totalAFLTV - pAFLTV, 'money'),
    xmp: deltaTextClass(totals.totalXMP - pXMP, 'money'),
    roi: deltaTextClass(
      totals.totalROI != null && pROI != null ? totals.totalROI - pROI : null,
      'pct',
    ),
  };
  return { deltas, hint: `${hintPrefix} ${fmtShortTime(match.time)}` };
}

function fetchData(sDate: string, eDate: string): Promise<DayData> {
  return getJson<DayData>(`/api/data?startDate=${sDate}&endDate=${eDate}`);
}

function fetchAfSummary(sDate: string, eDate: string): Promise<AfSummaryResponse | null> {
  return getJsonSoft<AfSummaryResponse>(`/api/af-summary?startDate=${sDate}&endDate=${eDate}`);
}

function fetchChannelSummary(sDate: string, eDate: string): Promise<ChannelSummaryResponse | null> {
  return getJsonSoft<ChannelSummaryResponse>(
    `/api/channel-summary?startDate=${sDate}&endDate=${eDate}`,
    60_000,
  );
}

/** 汇总面板：卡片 / 产品明细 / 渠道明细 / 当日趋势，逐行复刻旧 app.js。 */
export function SummaryPanel({ startDate, endDate, onLastUpdate }: PanelProps): React.ReactElement {
  const [bundle, setBundle] = useState<DataBundle | null>(null);
  const [channelSummary, setChannelSummary] = useState<ChannelSummaryResponse | null>(null);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [openCards, setOpenCards] = useState<Set<CardKey>>(new Set());
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());
  const [xmpModalOpen, setXmpModalOpen] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    const sDate = startDate;
    const eDate = endDate;
    const isRange = sDate !== eDate;
    const channelPromise = fetchChannelSummary(sDate, eDate);
    setChannelSummary(null);

    const [current, afData] = await Promise.all([
      fetchData(sDate, eDate),
      fetchAfSummary(sDate, eDate),
    ]);

    if (isRange) {
      setBundle({
        dayData: current,
        prevDayData: null,
        weekAgoData: null,
        afSummary: afData,
        prevAfSummary: null,
        weekAgoAfSummary: null,
      });
    } else {
      const prevDate = prevDateStr(sDate);
      const weekDate = weekAgoDateStr(sDate);
      const [prev, prevAfData, weekAgo, weekAgoAfData] = await Promise.all([
        fetchData(prevDate, prevDate),
        fetchAfSummary(prevDate, prevDate),
        fetchData(weekDate, weekDate),
        fetchAfSummary(weekDate, weekDate),
      ]);
      setBundle({
        dayData: current,
        prevDayData: prev,
        weekAgoData: weekAgo,
        afSummary: afData,
        prevAfSummary: prevAfData,
        weekAgoAfSummary: weekAgoAfData,
      });
    }

    void channelPromise.then((chData) => {
      setChannelSummary(chData);
    });
  }, [startDate, endDate]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const t = setInterval(
      () => {
        if (startDate === todayStr() && endDate === todayStr()) void reload();
      },
      5 * 60 * 1000,
    );
    return () => {
      clearInterval(t);
    };
  }, [reload, startDate, endDate]);

  // 报告顶栏「最后更新」文案。
  useEffect(() => {
    if (!bundle || bundle.dayData.snapshots.length === 0) return;
    const latest = bundle.dayData.snapshots.at(-1);
    if (bundle.dayData.isRange) {
      onLastUpdate(`日期范围：${bundle.dayData.startDate ?? ''} → ${bundle.dayData.endDate ?? ''}`);
    } else {
      onLastUpdate(`最后更新：${fmtTime(latest?.time)}`);
    }
  }, [bundle, onLastUpdate]);

  function handleSort(field: SortField): void {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'product' ? 'asc' : 'desc');
    }
  }

  function toggleCard(key: CardKey): void {
    setOpenCards((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleChannel(ch: string): void {
    setExpandedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(ch)) next.delete(ch);
      else next.add(ch);
      return next;
    });
  }

  const view = useMemo(() => {
    if (!bundle || bundle.dayData.snapshots.length === 0) return null;
    const { dayData, prevDayData, weekAgoData, afSummary, prevAfSummary, weekAgoAfSummary } =
      bundle;
    const latest = dayData.snapshots.at(-1);
    if (!latest) return null;
    const isRange = dayData.isRange === true;

    const rows = PRODUCTS.map((p) => buildProductRow(p, latest, afSummary));
    const totalAthena = rows.reduce((s, r) => s + (r.athenaTotal ?? 0), 0);
    const totalAthenaNew = rows.reduce((s, r) => s + (r.athenaNew ?? 0), 0);
    const totalAF = rows.reduce((s, r) => s + (r.afActual ?? 0), 0);
    const totalAFLTV = rows.reduce((s, r) => s + (r.afLTV ?? 0), 0);
    const totalXMP = rows.reduce((s, r) => s + (r.xmpCost ?? 0), 0);
    const totalROI = totalXMP > 0 ? (totalAthenaNew / totalXMP) * 100 : null;

    const currentTotals = { totalAthena, totalAthenaNew, totalAF, totalAFLTV, totalXMP, totalROI };
    let deltas: Record<CardKey | 'roi', { text: string; cls: string }> | null = null;
    let hint = '';
    let weekDeltas: Record<CardKey | 'roi', { text: string; cls: string }> | null = null;
    let weekHint = '';
    if (!isRange) {
      const day = computeCompareDeltas(
        currentTotals,
        prevDayData,
        prevAfSummary,
        afSummary,
        latest.time,
        'vs 昨日',
      );
      if (day) {
        deltas = day.deltas;
        hint = day.hint;
      }
      const week = computeCompareDeltas(
        currentTotals,
        weekAgoData,
        weekAgoAfSummary,
        afSummary,
        latest.time,
        'vs 上周',
      );
      if (week) {
        weekDeltas = week.deltas;
        weekHint = week.hint;
      }
    }

    const athenaWarn = (dayData.missingDates?.length ?? 0) > 0 ? dayData.missingDates : null;
    const afWarn = (afSummary?.missingDates?.length ?? 0) > 0 ? afSummary?.missingDates : null;

    const sortedRows = sortRows(rows, sortField, sortDir);

    return {
      isRange,
      totals: { totalAthena, totalAthenaNew, totalAF, totalAFLTV, totalXMP, totalROI },
      deltas,
      hint,
      weekDeltas,
      weekHint,
      athenaWarn,
      afWarn,
      sortedRows,
      dayData,
      prevDayData,
    };
  }, [bundle, sortField, sortDir]);

  return (
    <div>
      <section className="grid grid-cols-2 gap-4 p-6 md:grid-cols-3 xl:grid-cols-6">
        {view
          ? renderCards(
              view.totals,
              view.deltas,
              view.hint,
              view.weekDeltas,
              view.weekHint,
              view.isRange,
              view.athenaWarn,
              view.afWarn,
              openCards,
              toggleCard,
              view.dayData,
              view.prevDayData,
            )
          : renderEmptyCards()}
      </section>

      <section className="px-6 pb-6">
        <h2 className="mb-3 text-lg font-bold text-text">产品明细</h2>
        <div className="overflow-x-auto rounded-card border border-border bg-bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-text-dim">
                {PRODUCT_COLUMNS.map((c) => (
                  <th
                    key={c.field}
                    onClick={() => {
                      handleSort(c.field);
                    }}
                    className="cursor-pointer px-3 py-2 text-left font-semibold whitespace-nowrap hover:text-accent"
                  >
                    {c.label}
                    {sortField === c.field ? (
                      <span className="ml-1 text-accent">{sortDir === 'asc' ? '▲' : '▼'}</span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view ? (
                view.sortedRows.map((r) => renderProductRow(r))
              ) : (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-text-muted">
                    暂无数据，等待首次抓取...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <h2 className="mt-6 mb-3 text-lg font-bold text-text">渠道明细</h2>
        <div className="overflow-x-auto rounded-card border border-border bg-bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-text-dim">
                {['渠道', '消耗', '收入', 'CPI', '新用户 ROAS', 'D7 ROAS'].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {renderChannelRows(channelSummary, expandedChannels, toggleChannel, () => {
                setXmpModalOpen(true);
              })}
            </tbody>
          </table>
        </div>
      </section>

      {view && !view.isRange ? (
        <section className="px-6 pb-6">
          <h2 className="mb-3 text-lg font-bold text-text">当日趋势</h2>
          <div className="rounded-card border border-border bg-bg-card p-4">
            <SummaryTrendChart dayData={view.dayData} />
          </div>
        </section>
      ) : null}

      {xmpModalOpen && channelSummary?.xmpMissingDates.length ? (
        <XmpBackfillModal
          dates={channelSummary.xmpMissingDates}
          onClose={() => {
            setXmpModalOpen(false);
          }}
          onComplete={() => {
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

const PRODUCT_COLUMNS: { field: SortField; label: string }[] = [
  { field: 'product', label: '产品' },
  { field: 'athenaTotal', label: '雅典娜总收入' },
  { field: 'athenaNew', label: '雅典娜新用户' },
  { field: 'afActual', label: 'AF Actual' },
  { field: 'afLTV', label: 'AF LTV' },
  { field: 'afInstalls', label: 'AF 激活' },
  { field: 'xmpCost', label: 'XMP 消耗' },
  { field: 'cpi', label: 'CPI' },
  { field: 'roi', label: '新用户 ROI' },
];

function missingWarn(dates: string[] | null | undefined): React.ReactElement | null {
  if (!dates || dates.length === 0) return null;
  return (
    <span title={`缺失 ${dates.length.toString()} 天数据：${dates.join(', ')}`} className="ml-1">
      ⚠️
    </span>
  );
}

interface CardMeta {
  key: CardKey;
  label: string;
}

const EXPANDABLE_CARDS: CardMeta[] = [
  { key: 'athena', label: '雅典娜总收入' },
  { key: 'athena-new', label: '雅典娜新用户收入' },
  { key: 'af', label: 'AF 总收入 (Actual)' },
  { key: 'af-ltv', label: 'AF 总收入 (LTV)' },
  { key: 'xmp', label: 'XMP 总消耗' },
];

/** 一列对比差距（差距文案 + 时间提示），昨日 / 上周各一列。 */
function renderCompareCol(
  delta: { text: string; cls: string } | undefined,
  hint: string,
): React.ReactElement | null {
  if (!delta?.text) return null;
  return (
    <div>
      <div className={`text-[0.8rem] ${delta.cls}`}>{delta.text}</div>
      {hint ? <div className="text-[0.7rem] text-text-muted">{hint}</div> : null}
    </div>
  );
}

function renderEmptyCards(): React.ReactElement[] {
  const labels = [...EXPANDABLE_CARDS.map((c) => c.label), '新用户 ROI'];
  return labels.map((label) => (
    <div key={label} className="rounded-card border border-border bg-bg-card p-4 shadow-card">
      <div className="text-[0.8rem] text-text-dim">{label}</div>
      <div className="mt-1 text-xl font-bold text-text">--</div>
    </div>
  ));
}

function renderCards(
  totals: {
    totalAthena: number;
    totalAthenaNew: number;
    totalAF: number;
    totalAFLTV: number;
    totalXMP: number;
    totalROI: number | null;
  },
  deltas: Record<CardKey | 'roi', { text: string; cls: string }> | null,
  hint: string,
  weekDeltas: Record<CardKey | 'roi', { text: string; cls: string }> | null,
  weekHint: string,
  isRange: boolean,
  athenaWarn: string[] | null | undefined,
  afWarn: string[] | null | undefined,
  openCards: Set<CardKey>,
  toggleCard: (k: CardKey) => void,
  dayData: DayData,
  prevDayData: DayData | null,
): React.ReactElement[] {
  const valueOf: Record<CardKey, number> = {
    athena: totals.totalAthena,
    'athena-new': totals.totalAthenaNew,
    af: totals.totalAF,
    'af-ltv': totals.totalAFLTV,
    xmp: totals.totalXMP,
  };
  const warnOf: Record<CardKey, string[] | null | undefined> = {
    athena: athenaWarn,
    'athena-new': athenaWarn,
    af: afWarn,
    'af-ltv': afWarn,
    xmp: athenaWarn,
  };

  const cards = EXPANDABLE_CARDS.map((meta) => {
    const open = openCards.has(meta.key);
    const delta = deltas?.[meta.key];
    const weekDelta = weekDeltas?.[meta.key];
    const cfg = EXPAND_CARD_CONFIG[meta.key];
    const pairs = open ? buildHourlyPairs(dayData, prevDayData, cfg.source, cfg.field) : [];
    return (
      <div key={meta.key} className="rounded-card border border-border bg-bg-card p-4 shadow-card">
        <div className="text-[0.8rem] text-text-dim">{meta.label}</div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-xl font-bold text-text">
            {fmt(valueOf[meta.key])}
            {missingWarn(warnOf[meta.key])}
          </span>
          {isRange ? null : (
            <button
              type="button"
              onClick={() => {
                toggleCard(meta.key);
              }}
              title="查看每小时增量"
              className={`text-text-muted transition-transform hover:text-accent ${open ? 'rotate-180' : ''}`}
            >
              ▾
            </button>
          )}
        </div>
        {!isRange && (delta?.text || weekDelta?.text) ? (
          <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
            {renderCompareCol(delta, hint)}
            {renderCompareCol(weekDelta, weekHint)}
          </div>
        ) : null}
        {open ? (
          <div className="mt-2 border-t border-border pt-2 text-[0.75rem]">
            {pairs.length === 0 ? (
              <div className="text-text-muted">暂无足够数据</div>
            ) : (
              pairs.map((p, i) => {
                const todayCls =
                  p.yoy == null
                    ? deltaClass(p.delta)
                    : p.delta >= p.yoy.delta - 0.005
                      ? 'positive'
                      : 'negative';
                return (
                  <div key={i}>
                    <div className="flex justify-between">
                      <span className="text-text-muted">
                        {fmtShortTime(p.from)} → {fmtShortTime(p.to)}
                      </span>
                      <span className={SIGN_CLASS[todayCls]}>{fmtDeltaMoney(p.delta)}</span>
                    </div>
                    <div className="flex justify-between opacity-70">
                      <span className="text-text-muted">
                        {p.yoy
                          ? `昨日 ${fmtShortTime(p.yoy.from)} → ${fmtShortTime(p.yoy.to)}`
                          : '昨日 --'}
                      </span>
                      <span className="text-text-muted">
                        {p.yoy ? fmtDeltaMoney(p.yoy.delta) : '--'}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : null}
      </div>
    );
  });

  const roiDelta = deltas?.roi;
  const weekRoiDelta = weekDeltas?.roi;
  cards.push(
    <div key="roi" className="rounded-card border border-border bg-bg-card p-4 shadow-card">
      <div className="text-[0.8rem] text-text-dim">新用户 ROI</div>
      <div className="mt-1 text-xl font-bold text-text">
        {totals.totalROI == null ? '--' : fmtPct(totals.totalROI)}
      </div>
      {!isRange && (roiDelta?.text || weekRoiDelta?.text) ? (
        <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
          {renderCompareCol(roiDelta, hint)}
          {renderCompareCol(weekRoiDelta, weekHint)}
        </div>
      ) : null}
    </div>,
  );
  return cards;
}

function renderProductRow(r: ProductRow): React.ReactElement {
  const roiCls = r.roi == null ? 'text-text-muted' : r.roi >= 100 ? 'text-green' : 'text-red';
  return (
    <tr key={r.product} className="border-b border-border/50 text-text">
      <td className="px-3 py-2 whitespace-nowrap">{r.product}</td>
      <td className="px-3 py-2">{r.athenaTotal == null ? naCell() : fmt(r.athenaTotal)}</td>
      <td className="px-3 py-2">{r.athenaNew == null ? naCell() : fmt(r.athenaNew)}</td>
      <td className="px-3 py-2">{r.afActual == null ? naCell() : fmt(r.afActual)}</td>
      <td className="px-3 py-2">{r.afLTV == null ? naCell() : fmt(r.afLTV)}</td>
      <td className="px-3 py-2">
        {r.afInstalls == null ? naCell() : Math.round(r.afInstalls).toLocaleString()}
      </td>
      <td className="px-3 py-2">{r.xmpCost == null ? naCell() : fmt(r.xmpCost)}</td>
      <td className="px-3 py-2">{r.cpi == null ? naCell() : fmt(r.cpi)}</td>
      <td className={`px-3 py-2 ${roiCls}`}>{r.roi == null ? naCell() : fmtPct(r.roi)}</td>
    </tr>
  );
}

function renderChannelRows(
  data: ChannelSummaryResponse | null,
  expanded: Set<string>,
  toggle: (ch: string) => void,
  openXmpModal: () => void,
): React.ReactElement {
  if (data === null) {
    return (
      <tr>
        <td colSpan={6} className="px-3 py-6 text-center text-text-muted">
          加载中...
        </td>
      </tr>
    );
  }
  const chs = data.channels;
  const hasD7Warning = data.d7Incomplete.length > 0;
  const hasXmpWarning = data.xmpMissingDates.length > 0;

  const out: React.ReactElement[] = [];
  let totalCost = 0;
  let totalRevenue = 0;
  let totalInstalls = 0;
  let totalNewUserRevenue = 0;
  let totalD7Revenue = 0;
  for (const ch of CHANNEL_ORDER) {
    const d = chs[ch];
    if (!d) continue;
    totalCost += d.cost;
    totalRevenue += d.revenue;
    totalInstalls += d.installs;
    totalNewUserRevenue += d.newUserRevenue;
    totalD7Revenue += d.d7Revenue;
  }

  for (const ch of CHANNEL_ORDER) {
    const d = chs[ch];
    if (!d) {
      out.push(
        <tr key={ch} className="border-b border-border/50">
          <td className="px-3 py-2 text-text">{CHANNEL_LABELS[ch] ?? ch}</td>
          <td colSpan={5} className="px-3 py-2 text-text-muted">
            --
          </td>
        </tr>,
      );
      continue;
    }
    const hasProducts = Object.keys(d.products).length > 0;
    const isExpanded = expanded.has(ch);
    out.push(
      <tr
        key={ch}
        onClick={
          hasProducts
            ? () => {
                toggle(ch);
              }
            : undefined
        }
        className={`border-b border-border/50 text-text ${hasProducts ? 'cursor-pointer hover:bg-bg-card-hover' : ''}`}
      >
        <td className="px-3 py-2 whitespace-nowrap">
          {hasProducts ? (
            <span className="mr-1 text-text-muted">{isExpanded ? '▼' : '▶'}</span>
          ) : null}
          {CHANNEL_LABELS[ch] ?? ch}
        </td>
        {renderBucketCells(d, hasD7Warning)}
      </tr>,
    );
    if (hasProducts && isExpanded) {
      const sorted = Object.entries(d.products).sort((a, b) => b[1].cost - a[1].cost);
      for (const [prod, pd] of sorted) {
        out.push(
          <tr
            key={`${ch}-${prod}`}
            className="border-b border-border/30 bg-bg-dark/40 text-text-dim"
          >
            <td className="px-3 py-1.5 pl-8 whitespace-nowrap">{prod}</td>
            {renderBucketCells(pd, hasD7Warning)}
          </tr>,
        );
      }
    }
  }

  const totalCPI = totalInstalls > 0 ? totalCost / totalInstalls : null;
  const totalNewRoas = totalCost > 0 ? (totalNewUserRevenue / totalCost) * 100 : null;
  const totalD7Roas = totalCost > 0 ? (totalD7Revenue / totalCost) * 100 : null;

  out.push(
    <tr key="__total" className="border-t-2 border-border font-semibold text-text">
      <td className="px-3 py-2">合计</td>
      <td className="px-3 py-2">
        {fmt(totalCost)}
        {hasXmpWarning ? (
          <button
            type="button"
            onClick={openXmpModal}
            title={`缺少${data.xmpMissingDates.length.toString()}天XMP缓存`}
            className="ml-2 rounded border border-yellow/50 px-1.5 text-xs text-yellow hover:bg-yellow/10"
          >
            ⚠️ {data.xmpMissingDates.length}天
          </button>
        ) : null}
      </td>
      <td className="px-3 py-2">{fmt(totalRevenue)}</td>
      <td className="px-3 py-2">{totalCPI == null ? naCell() : fmt(totalCPI)}</td>
      {renderRoasCell(totalNewRoas, 30, false)}
      {renderRoasCell(totalD7Roas, 100, hasD7Warning)}
    </tr>,
  );

  return <>{out}</>;
}

function renderBucketCells(d: ChannelBucket, hasD7Warning: boolean): React.ReactElement {
  return (
    <>
      <td className="px-3 py-2">{fmt(d.cost)}</td>
      <td className="px-3 py-2">{fmt(d.revenue)}</td>
      <td className="px-3 py-2">{d.cpi == null ? naCell() : fmt(d.cpi)}</td>
      {renderRoasCell(d.newUserRoas, 30, false)}
      {renderRoasCell(d.d7Roas, 100, hasD7Warning)}
    </>
  );
}

function renderRoasCell(
  val: number | null,
  threshold: number,
  d7Warn: boolean,
): React.ReactElement {
  const cls = val == null ? 'text-text-muted' : val >= threshold ? 'text-green' : 'text-red';
  return (
    <td className={`px-3 py-2 ${cls}`}>
      {val == null ? '--' : fmtPct(val)}
      {val != null && d7Warn ? <span title="部分日期未满7天"> *</span> : null}
    </td>
  );
}
