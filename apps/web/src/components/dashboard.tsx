'use client';

import { useEffect, useState } from 'react';

import { DateRangePicker } from './date-range-picker';
import { AdManagerPanel } from './panels/ad-manager-panel';
import { CreativePanel } from './panels/creative-panel';
import { DailyReportPanel } from './panels/daily-report-panel';
import { PersonalPanel } from './panels/personal-panel';
import { SummaryPanel } from './panels/summary-panel';

import { todayStr } from '@/lib/client/format';
import { panelFromPath, pathForPanel, PANELS, type PanelName } from '@/lib/panels';

function navClass(active: boolean): string {
  const base =
    'rounded-md border px-3 py-1.5 text-[1.1rem] font-semibold whitespace-nowrap transition-colors cursor-pointer';
  return active
    ? `${base} border-accent bg-[rgba(99,102,241,0.08)] text-accent`
    : `${base} border-border bg-bg-card text-text-muted hover:border-accent hover:text-accent`;
}

export function Dashboard({
  initialPanel = 'summary',
}: {
  initialPanel?: PanelName;
}): React.ReactElement {
  const initial = todayStr();
  const [panel, setPanel] = useState<PanelName>(initialPanel);
  const [startDate, setStartDate] = useState(initial);
  const [endDate, setEndDate] = useState(initial);
  const [correctionMode, setCorrectionMode] = useState(false);
  const [lastUpdate, setLastUpdate] = useState('最后更新：--');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  // 初始主题：从 <html data-theme>（layout.tsx 内联脚本已按 localStorage 设置）同步，SSR 安全。
  useEffect(() => {
    const current = globalThis.document.documentElement.dataset['theme'];
    setTheme(current === 'light' ? 'light' : 'dark');
  }, []);

  function toggleTheme(): void {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      globalThis.document.documentElement.dataset['theme'] = next;
      globalThis.localStorage.setItem('ug-theme', next);
      return next;
    });
  }

  // 前进/后退时按 URL 路径同步面板（点击面板用 history.pushState 改路径，见 selectPanel）。
  useEffect(() => {
    function onPop(): void {
      setPanel(panelFromPath(globalThis.location.pathname));
    }
    globalThis.addEventListener('popstate', onPop);
    return () => {
      globalThis.removeEventListener('popstate', onPop);
    };
  }, []);

  /** 切换面板：更新状态并用 history.pushState 写入对应路径，刷新可直达、支持前进后退。 */
  function selectPanel(key: PanelName): void {
    setPanel(key);
    globalThis.history.pushState(null, '', pathForPanel(key));
  }

  function applyDateRange(lo: string, hi: string): void {
    setStartDate(lo);
    setEndDate(hi);
  }

  function goToday(): void {
    const t = todayStr();
    setStartDate(t);
    setEndDate(t);
  }

  return (
    <>
      <header className="sticky top-0 z-[200] flex flex-wrap items-center justify-between gap-3 border-b border-border bg-bg-header px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-[1.3rem] font-bold whitespace-nowrap text-accent">📊</h1>
          <div className="flex items-center gap-2">
            {PANELS.map((n) => (
              <button
                key={n.key}
                type="button"
                className={navClass(panel === n.key)}
                onClick={() => {
                  selectPanel(n.key);
                }}
              >
                {n.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {panel === 'pb-personal' ? (
            <label
              className="flex cursor-pointer items-center gap-1.5 select-none"
              title="切换修正收入"
            >
              <input
                type="checkbox"
                className="peer sr-only"
                checked={correctionMode}
                onChange={(e) => {
                  setCorrectionMode(e.target.checked);
                }}
              />
              <span className="relative h-[18px] w-8 rounded-full bg-white/15 transition-colors after:absolute after:top-[3px] after:left-[3px] after:h-3 after:w-3 after:rounded-full after:bg-[#aaa] after:transition-all peer-checked:bg-accent peer-checked:after:left-[17px] peer-checked:after:bg-white" />
              <span className="text-[0.72rem] whitespace-nowrap text-text-muted">
                {correctionMode ? '修正' : '原始'}
              </span>
            </label>
          ) : null}
          <div className="flex items-center gap-2">
            <DateRangePicker startDate={startDate} endDate={endDate} onChange={applyDateRange} />
            <button
              type="button"
              onClick={goToday}
              title="跳转到今天"
              className="rounded-md border border-border bg-bg-card px-3 py-1.5 text-[0.8rem] font-semibold text-text-dim transition-colors hover:border-accent hover:text-accent"
            >
              今天
            </button>
          </div>
          <div className="text-[0.85rem] text-text-dim">{lastUpdate}</div>
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}
            aria-label="切换主题"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-bg-card text-base leading-none text-text-dim transition-colors hover:border-accent hover:text-accent"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      {panel === 'summary' ? (
        <SummaryPanel startDate={startDate} endDate={endDate} onLastUpdate={setLastUpdate} />
      ) : null}
      {panel === 'pb-personal' ? (
        <PersonalPanel
          startDate={startDate}
          endDate={endDate}
          correctionMode={correctionMode}
          onLastUpdate={setLastUpdate}
        />
      ) : null}
      {panel === 'creative' ? <CreativePanel /> : null}
      {panel === 'daily-report' ? <DailyReportPanel /> : null}
      {panel === 'ad-manager' ? <AdManagerPanel /> : null}
    </>
  );
}
