'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  AIGC_CREATIVES,
  AIGC_FORMS,
  AIGC_NUM_METRICS,
  AIGC_NUM_OPS,
  AIGC_OWNERS,
  AIGC_TYPES,
  applyFilters,
  computeMetrics,
  downloadCsv,
  fetchCorrectionFactors,
  parseAigcName,
  replaceProduct,
  sortRows,
} from '@/lib/client/aigc';
import type {
  AigcCorrectionFactors,
  CreativeDataResponse,
  NameFilters,
  NumFilter,
  NumMetric,
  NumOp,
  SortField,
  SortObj,
} from '@/lib/client/aigc';
import { getJson } from '@/lib/client/api';

const PAGE_SIZE = 20;
const WINDOWS = [3, 7, 14];
const EMPTY_FILTERS: NameFilters = { owner: '', product: '', form: '', type: '', creative: '', date: '' };
const DEFAULT_NUM: NumFilter = { metric: 'newUserRevenue', op: 'gte', value: null };

const SELECT_CLS =
  'rounded-md border border-border bg-bg-dark px-2 py-1 text-[0.78rem] text-text focus:border-accent focus:outline-none';
const NUM_CLS = 'px-2 py-1.5 text-right whitespace-nowrap';

export interface MaterialPanelProps {
  /** 数据接口基路径，如 /api/creative/data；会附加 ?days=。 */
  apiPath: string;
  /** 产品筛选下拉 + 跨产品复用目标集。 */
  products: string[];
  /** 标题前缀，如 '素材排名' / 'AIGC 素材排名'。 */
  rankPrefix: string;
  /** 状态栏标签，如 '素材数据' / 'AIGC 数据'。 */
  statusLabel: string;
  /** CSV 文件名后缀，如 '素材' / 'AIGC素材'。 */
  csvSuffix: string;
  /** 是否显示顶部 FB/TT 汇总卡片（素材面板有，AIGC 面板无）。默认 true。 */
  showCards?: boolean;
}

/** 素材/AIGC 面板共用实现：自带时间窗(3/7/14)、修正开关、筛选、排序、分页、跨产品复用、CSV 下载。 */
export function MaterialPanel({
  apiPath,
  products,
  rankPrefix,
  statusLabel,
  csvSuffix,
  showCards = true,
}: MaterialPanelProps): React.ReactElement {
  const [data, setData] = useState<CreativeDataResponse | null>(null);
  const [factors, setFactors] = useState<AigcCorrectionFactors>({});
  const [status, setStatus] = useState<'busy' | 'ok' | 'error'>('busy');
  const [errMsg, setErrMsg] = useState('');
  const [windowDays, setWindowDays] = useState(3);
  const [correctionMode, setCorrectionMode] = useState(false);
  const [filters, setFilters] = useState<NameFilters>(EMPTY_FILTERS);
  const [numFilter, setNumFilter] = useState<NumFilter>(DEFAULT_NUM);
  const [numValueStr, setNumValueStr] = useState('');
  const [fbSort, setFbSort] = useState<SortObj>({ field: 'newUserRevenue', dir: 'desc' });
  const [ttSort, setTtSort] = useState<SortObj>({ field: 'newUserRevenue', dir: 'desc' });
  const [fbPage, setFbPage] = useState(1);
  const [ttPage, setTtPage] = useState(1);
  // 表级「跨产品复用」目标产品：选一次，本表所有行统一改成该产品，逐行各自复制。
  const defaultReuseTarget = products[0] ?? '';
  const [fbReuseTarget, setFbReuseTarget] = useState(defaultReuseTarget);
  const [ttReuseTarget, setTtReuseTarget] = useState(defaultReuseTarget);
  const liveRef = useRef(true);

  useEffect(() => {
    liveRef.current = true;
    setStatus('busy');
    setFbPage(1);
    setTtPage(1);
    void (async (): Promise<void> => {
      try {
        const d = await getJson<CreativeDataResponse>(`${apiPath}?days=${windowDays.toString()}`);
        if (!liveRef.current) return;
        setData(d);
        setStatus('ok');
        const f = await fetchCorrectionFactors();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 卸载后可能已置 false，避免对已卸载组件 setState
        if (liveRef.current) setFactors(f);
      } catch (error) {
        if (!liveRef.current) return;
        setStatus('error');
        setErrMsg(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      liveRef.current = false;
    };
  }, [apiPath, windowDays]);

  const dateOptions = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const c of [...(data.fb ?? []), ...(data.tt ?? [])]) {
      for (const dd of parseAigcName(c.name).dates) set.add(dd);
    }
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [data]);

  const fbRows = data?.fb ?? [];
  const ttRows = data?.tt ?? [];
  const fbCost = fbRows.reduce((s, c) => s + c.cost, 0);
  const fbRev = fbRows.reduce((s, c) => s + c.newUserRevenue, 0);
  const ttCost = ttRows.reduce((s, c) => s + c.cost, 0);
  const ttRev = ttRows.reduce((s, c) => s + c.newUserRevenue, 0);

  const missing = data?.missingDates?.length ?? 0;
  const rangeText = data?.dateRange ?? `近 ${windowDays.toString()} 天`;
  const title = `${rankPrefix}（${rangeText}）${missing > 0 ? ` ⚠️ 缺 ${missing.toString()} 天` : ''}`;

  function setFilter(key: keyof NameFilters, value: string): void {
    setFilters((f) => ({ ...f, [key]: value }));
    setFbPage(1);
    setTtPage(1);
  }

  function onNumValue(v: string): void {
    const trimmed = v.trim();
    setNumValueStr(v);
    setNumFilter((n) => ({ ...n, value: trimmed === '' ? null : Number.parseFloat(trimmed) }));
    setFbPage(1);
    setTtPage(1);
  }

  function resetFilters(): void {
    setFilters(EMPTY_FILTERS);
    setNumFilter(DEFAULT_NUM);
    setNumValueStr('');
    setFbPage(1);
    setTtPage(1);
  }

  function toggleSort(channel: 'fb' | 'tt', field: SortField): void {
    const cur = channel === 'fb' ? fbSort : ttSort;
    const setSort = channel === 'fb' ? setFbSort : setTtSort;
    if (cur.field === field) {
      setSort({ field, dir: cur.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      setSort({ field, dir: field === 'name' || field === 'product' ? 'asc' : 'desc' });
    }
    if (channel === 'fb') setFbPage(1);
    else setTtPage(1);
  }

  function renderTable(channel: 'fb' | 'tt'): React.ReactElement {
    const rows = channel === 'fb' ? fbRows : ttRows;
    const sortObj = channel === 'fb' ? fbSort : ttSort;
    const page = channel === 'fb' ? fbPage : ttPage;
    const setPage = channel === 'fb' ? setFbPage : setTtPage;
    const reuseTarget = channel === 'fb' ? fbReuseTarget : ttReuseTarget;
    const setReuseTarget = channel === 'fb' ? setFbReuseTarget : setTtReuseTarget;

    const filtered = applyFilters(rows, filters, numFilter, correctionMode, factors);
    const sorted = sortRows(filtered, sortObj, correctionMode, factors);
    const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
    const start = (page - 1) * PAGE_SIZE;
    const pageData = sorted.slice(start, start + PAGE_SIZE);

    return (
      <div>
        <div className="my-3 flex items-center gap-3">
          <h3 className="m-0 text-[0.95rem] text-text-muted">{channel === 'fb' ? 'Facebook' : 'TikTok'}</h3>
          <button
            type="button"
            onClick={() => {
              const label = channel === 'fb' ? 'FB' : 'TT';
              const range = (data?.dateRange ?? 'unknown').replaceAll(/\s/g, '');
              downloadCsv(sorted, correctionMode, factors, `${label}${csvSuffix}_${range}.csv`);
            }}
            title="下载 CSV"
            className="rounded-md border border-border bg-bg-card px-2 py-1 text-[0.75rem] text-text-dim hover:border-accent hover:text-accent"
          >
            ⬇ CSV
          </button>
          <ReuseTargetSelect target={reuseTarget} products={products} onChange={setReuseTarget} />
        </div>
        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="w-full text-[0.8rem]">
            <thead>
              <tr className="border-b border-border text-text-dim">
                <SortTh label="#" field="name" channel={channel} sortObj={sortObj} onClick={toggleSort} align="left" />
                <SortTh label="素材名称" field="name" channel={channel} sortObj={sortObj} onClick={toggleSort} align="left" />
                <th className="px-2 py-1.5 text-left font-semibold whitespace-nowrap" title="在表头选一次目标产品，本表所有行统一改成该产品；逐行各自点复制，一次复制一个">
                  跨产品复用
                </th>
                <SortTh label="产品" field="product" channel={channel} sortObj={sortObj} onClick={toggleSort} align="left" />
                <SortTh label="新用户收入" field="newUserRevenue" channel={channel} sortObj={sortObj} onClick={toggleSort} align="right" />
                <SortTh label="消耗" field="cost" channel={channel} sortObj={sortObj} onClick={toggleSort} align="right" />
                <SortTh label="ROAS" field="roas" channel={channel} sortObj={sortObj} onClick={toggleSort} align="right" />
                <SortTh label="CPM" field="cpm" channel={channel} sortObj={sortObj} onClick={toggleSort} align="right" />
                <SortTh label="CPC" field="cpc" channel={channel} sortObj={sortObj} onClick={toggleSort} align="right" />
                <SortTh label="CTR" field="ctr" channel={channel} sortObj={sortObj} onClick={toggleSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {pageData.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-2 py-6 text-center text-text-muted">
                    暂无数据
                  </td>
                </tr>
              ) : (
                pageData.map((c, i) => {
                  const m = computeMetrics(c, correctionMode, factors);
                  const roasCls = m.roas >= 1 ? 'text-green' : m.roas > 0 ? 'text-red' : '';
                  return (
                    <tr key={`${c.name}\u241F${(start + i).toString()}`} className="border-b border-border/30 text-text">
                      <td className="px-2 py-1.5 text-text-muted">{start + i + 1}</td>
                      <td className="max-w-[280px] truncate px-2 py-1.5" title={c.name}>
                        {c.name}
                      </td>
                      <td className="px-2 py-1.5">
                        <ReuseCell name={c.name} target={reuseTarget} products={products} />
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{c.product === '' ? '—' : c.product}</td>
                      <td className={NUM_CLS}>{`$${m.newUserRevenue.toFixed(2)}`}</td>
                      <td className={`${NUM_CLS} text-yellow`}>{`$${m.cost.toFixed(2)}`}</td>
                      <td className={`${NUM_CLS} ${roasCls}`}>{m.roas.toFixed(2)}</td>
                      <td className={NUM_CLS}>{`$${m.cpm.toFixed(2)}`}</td>
                      <td className={NUM_CLS}>{`$${m.cpc.toFixed(2)}`}</td>
                      <td className={NUM_CLS}>{`${m.ctr.toFixed(2)}%`}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-2 flex items-center gap-3 text-[0.78rem] text-text-dim">
          {totalPages <= 1 ? (
            <span>共 {sorted.length} 条</span>
          ) : (
            <>
              <span>
                第 {page}/{totalPages} 页（共 {sorted.length} 条）
              </span>
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => {
                  setPage(page - 1);
                }}
                className="rounded border border-border px-2 py-0.5 hover:border-accent disabled:opacity-40"
              >
                上一页
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => {
                  setPage(page + 1);
                }}
                className="rounded border border-border px-2 py-0.5 hover:border-accent disabled:opacity-40"
              >
                下一页
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {showCards ? (
        <section className="grid grid-cols-2 gap-4 p-6 md:grid-cols-3 xl:grid-cols-6">
          <Card label="FB 素材数" value={data ? fbRows.length.toString() : '--'} />
          <Card label="FB 总消耗" value={data ? `$${fbCost.toFixed(0)}` : '--'} valueCls="text-yellow" />
          <Card label="FB 新用户收入" value={data ? `$${fbRev.toFixed(0)}` : '--'} />
          <Card label="TT 素材数" value={data ? ttRows.length.toString() : '--'} />
          <Card label="TT 总消耗" value={data ? `$${ttCost.toFixed(0)}` : '--'} valueCls="text-yellow" />
          <Card label="TT 新用户收入" value={data ? `$${ttRev.toFixed(0)}` : '--'} />
        </section>
      ) : null}

      <section className={showCards ? 'px-6 pb-6' : 'p-6'}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-text">{title}</h2>
          <div className="flex items-center gap-4">
            <label className="flex cursor-pointer items-center gap-1.5 select-none" title="切换修正收入（按产品渠道乘最新修正系数）">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={correctionMode}
                onChange={(e) => {
                  setCorrectionMode(e.target.checked);
                }}
              />
              <span className="relative h-[18px] w-8 rounded-full bg-white/15 transition-colors after:absolute after:top-[3px] after:left-[3px] after:h-3 after:w-3 after:rounded-full after:bg-[#aaa] after:transition-all peer-checked:bg-accent peer-checked:after:left-[17px] peer-checked:after:bg-white" />
              <span className="text-[0.72rem] whitespace-nowrap text-text-muted">{correctionMode ? '修正' : '原始'}</span>
            </label>
            <div className="flex items-center gap-1">
              {WINDOWS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => {
                    setWindowDays(d);
                  }}
                  className={`rounded-md border px-2 py-1 text-[0.75rem] transition-colors ${
                    windowDays === d
                      ? 'border-accent bg-accent-dim text-accent'
                      : 'border-border bg-bg-card text-text-dim hover:border-accent'
                  }`}
                >
                  {d} 天
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-border/60 bg-bg-card/40 p-3">
          <FilterSelect label="日期" value={filters.date} options={dateOptions} onChange={(v) => { setFilter('date', v); }} />
          <FilterSelect label="负责人" value={filters.owner} options={AIGC_OWNERS} onChange={(v) => { setFilter('owner', v); }} />
          <FilterSelect label="产品" value={filters.product} options={products} onChange={(v) => { setFilter('product', v); }} />
          <FilterSelect label="素材形式" value={filters.form} options={AIGC_FORMS} onChange={(v) => { setFilter('form', v); }} />
          <FilterSelect label="素材类型" value={filters.type} options={AIGC_TYPES} onChange={(v) => { setFilter('type', v); }} />
          <FilterSelect label="创意方向" value={filters.creative} options={AIGC_CREATIVES} onChange={(v) => { setFilter('creative', v); }} />
          <label className="flex flex-col gap-1 text-[0.72rem] text-text-muted">
            数值筛选
            <span className="flex items-center gap-1">
              <select
                value={numFilter.metric}
                onChange={(e) => {
                  setNumFilter((n) => ({ ...n, metric: e.target.value as NumMetric }));
                  setFbPage(1);
                  setTtPage(1);
                }}
                className={SELECT_CLS}
              >
                {AIGC_NUM_METRICS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select
                value={numFilter.op}
                onChange={(e) => {
                  setNumFilter((n) => ({ ...n, op: e.target.value as NumOp }));
                  setFbPage(1);
                  setTtPage(1);
                }}
                className={SELECT_CLS}
              >
                {AIGC_NUM_OPS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                step="any"
                placeholder="数值"
                value={numValueStr}
                onChange={(e) => {
                  onNumValue(e.target.value);
                }}
                className={`w-20 ${SELECT_CLS}`}
              />
            </span>
          </label>
          <button
            type="button"
            onClick={resetFilters}
            className="rounded-md border border-border bg-bg-card px-3 py-1 text-[0.78rem] text-text-dim hover:border-accent hover:text-accent"
          >
            重置
          </button>
        </div>

        {status === 'error' ? (
          <div className="rounded-md border border-border bg-bg-card p-4 text-sm text-red">
            {statusLabel}加载失败：{errMsg}
          </div>
        ) : null}

        {renderTable('fb')}
        <div className="h-6" />
        {renderTable('tt')}
      </section>
    </div>
  );
}

function SortTh({
  label,
  field,
  channel,
  sortObj,
  onClick,
  align,
}: {
  label: string;
  field: SortField;
  channel: 'fb' | 'tt';
  sortObj: SortObj;
  onClick: (channel: 'fb' | 'tt', field: SortField) => void;
  align: 'left' | 'right';
}): React.ReactElement {
  const active = sortObj.field === field;
  return (
    <th
      onClick={() => {
        onClick(channel, field);
      }}
      className={`cursor-pointer px-2 py-1.5 font-semibold whitespace-nowrap select-none hover:text-accent ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${active ? 'text-accent' : ''}`}
    >
      {label}
      {active ? <span className="ml-0.5">{sortObj.dir === 'asc' ? '▲' : '▼'}</span> : null}
    </th>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1 text-[0.72rem] text-text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className={SELECT_CLS}
      >
        <option value="">全部</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * 表头统一「跨产品复用」目标产品选择器：选一次，本表所有行的复制都改成该目标产品。
 */
function ReuseTargetSelect({
  target,
  products,
  onChange,
}: {
  target: string;
  products: string[];
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <label
      className="ml-auto flex items-center gap-1.5 text-[0.72rem] text-text-muted"
      title="选一次目标产品，本表所有素材的「复制」都改成该产品（逐行各自复制）"
    >
      <span className="whitespace-nowrap">跨产品复用→目标产品</span>
      <select
        value={target}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className={SELECT_CLS}
      >
        {products.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 行内复用按钮：目标产品由表头统一控制（受控），点一下只复制本行改成目标产品后的完整素材名。 */
function ReuseCell({
  name,
  target,
  products,
}: {
  name: string;
  target: string;
  products: string[];
}): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const flash = (): void => {
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1400);
  };

  function doCopy(): void {
    if (!target) return;
    const newName = replaceProduct(name, target, products);
    void navigator.clipboard.writeText(newName).then(flash, () => {
      fallbackCopy(newName);
      flash();
    });
  }

  return (
    <button
      type="button"
      onClick={doCopy}
      title={`复制改成 ${target} 后的完整素材名`}
      className={`rounded border px-1.5 py-0.5 text-[0.72rem] whitespace-nowrap ${
        copied ? 'border-green text-green' : 'border-border text-text-dim hover:border-accent'
      }`}
    >
      {copied ? '✓ 已复制' : `复制为 ${target}`}
    </button>
  );
}

function fallbackCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- 剪贴板 API 不可用时的老浏览器兜底
    document.execCommand('copy');
  } catch {
    /* ignore */
  }
  ta.remove();
}

function Card({ label, value, valueCls }: { label: string; value: string; valueCls?: string }): React.ReactElement {
  return (
    <div className="rounded-card border border-border bg-bg-card p-4 shadow-card">
      <div className="text-[0.8rem] text-text-dim">{label}</div>
      <div className={`mt-1 text-xl font-bold ${valueCls ?? 'text-text'}`}>{value}</div>
    </div>
  );
}
