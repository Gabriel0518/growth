'use client';

import { Chart } from 'chart.js/auto';
import { useEffect, useRef, useState } from 'react';

import { getJson } from '@/lib/client/api';
import { fmt } from '@/lib/client/format';
import { OPERATOR_LABELS } from '@/lib/client/pb-personal';

export interface RbiTarget {
  level: 'operator' | 'product' | 'channel' | 'campaign';
  operator?: string;
  product?: string;
  channel?: string;
  campaign?: string;
  date: string;
}

interface RbiPoint {
  date: string;
  revenue?: number;
}

interface RbiResponse {
  date: string;
  series?: RbiPoint[];
  earlierRevenue?: number;
  error?: string;
}

const LEVEL_LABEL: Record<RbiTarget['level'], string> = {
  campaign: 'Campaign',
  channel: '渠道',
  product: '产品',
  operator: '投手',
};

const BUCKETS = [
  { label: '更早', min: 99, max: Number.POSITIVE_INFINITY },
  { label: '85-98天前', min: 85, max: 98 },
  { label: '71-84天前', min: 71, max: 84 },
  { label: '57-70天前', min: 57, max: 70 },
  { label: '43-56天前', min: 43, max: 56 },
  { label: '29-42天前', min: 29, max: 42 },
  { label: '15-28天前', min: 15, max: 28 },
  { label: '8-14天前', min: 8, max: 14 },
  { label: '4-7天前', min: 4, max: 7 },
  { label: '过去3天', min: 1, max: 3 },
  { label: '当天', min: 0, max: 0 },
];

function titleFor(t: RbiTarget): string {
  if (t.level === 'campaign') return t.campaign ?? '';
  if (t.level === 'channel') return `${t.product ?? ''} · ${t.channel ?? ''}`;
  if (t.level === 'product') return t.product ?? '';
  return OPERATOR_LABELS[t.operator ?? ''] ?? t.operator ?? '';
}

/** 收入来源图弹窗：拉 /api/revenue-by-install，按安装时段聚合为 11 桶折线图。 */
export function RbiModal({ target, onClose }: { target: RbiTarget; onClose: () => void }): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'done'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [total, setTotal] = useState('-');

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ level: target.level, days: '99' });
    if (target.date) params.set('date', target.date);
    if (target.campaign != null) params.set('campaign', target.campaign);
    if (target.product != null) params.set('product', target.product);
    if (target.channel != null) params.set('channel', target.channel);
    if (target.operator != null) params.set('operator', target.operator);

    getJson<RbiResponse>(`/api/revenue-by-install?${params.toString()}`, controller.signal)
      .then((data) => {
        if (data.error != null) throw new Error(data.error);
        drawChart(data);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setStatus('error');
        setErrMsg(error instanceof Error ? error.message : String(error));
      });

    function drawChart(data: RbiResponse): void {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const series = data.series ?? [];
      const refDate = data.date;
      const daysAgo = (ds: string): number =>
        Math.round((Date.parse(`${refDate}T00:00:00Z`) - Date.parse(`${ds}T00:00:00Z`)) / 86_400_000);
      const bucketVals = BUCKETS.map(() => 0);
      for (const p of series) {
        const da = daysAgo(p.date);
        for (const [i, b] of BUCKETS.entries()) {
          if (da >= b.min && da <= b.max) {
            bucketVals[i] = (bucketVals[i] ?? 0) + (p.revenue ?? 0);
            break;
          }
        }
      }
      bucketVals[0] = (bucketVals[0] ?? 0) + (data.earlierRevenue ?? 0);

      const labels = BUCKETS.map((b) => b.label);
      const values = bucketVals.map((v) => Math.round(v * 100) / 100);
      const sum = values.reduce((s, v) => s + v, 0);
      setTotal(`区间总修正付费 ${fmt(sum)}`);
      setStatus('done');

      chartRef.current?.destroy();
      chartRef.current = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '当日修正付费（按安装时段）',
              data: values,
              borderColor: '#00d4ff',
              backgroundColor: 'rgba(0,212,255,0.12)',
              borderWidth: 2,
              tension: 0.15,
              fill: true,
              pointRadius: 3,
              pointHoverRadius: 6,
              pointBackgroundColor: '#00d4ff',
              spanGaps: true,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: '#8888aa', font: { size: 12 } } },
            tooltip: {
              callbacks: {
                title: (items) => (items.length > 0 ? `安装时段: ${labels[items[0]?.dataIndex ?? 0] ?? ''}` : ''),
                label: (c) => `修正付费: ${fmt(c.raw as number)}`,
              },
            },
          },
          scales: {
            x: {
              ticks: { color: '#555577', font: { size: 10 }, maxRotation: 0, autoSkip: false },
              grid: { color: 'rgba(255,255,255,0.04)' },
              title: { display: true, text: '← 老用户(早安装)        安装时段        新用户(近安装) →', color: '#555577' },
            },
            y: {
              beginAtZero: true,
              ticks: {
                color: '#555577',
                font: { size: 11 },
                callback: (value) => {
                  const v = typeof value === 'number' ? value : Number(value);
                  return `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`;
                },
              },
              grid: { color: 'rgba(255,255,255,0.06)' },
            },
          },
        },
      });
    }

    return () => {
      controller.abort();
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [target]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-[720px] max-w-[95vw] flex-col rounded-xl border border-border bg-bg-card p-6 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <div className="mb-1 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-text">{titleFor(target)}</h3>
            <p className="mt-0.5 text-xs text-text-muted">
              {LEVEL_LABEL[target.level]} · {target.date} 当日修正付费 × 按安装时段
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text">
            ✕
          </button>
        </div>
        <div className="mb-2 text-sm font-semibold text-accent">{total}</div>
        {status === 'loading' ? (
          <div className="flex items-center gap-2 py-8 text-sm text-text-dim">正在加载收入来源数据...</div>
        ) : null}
        {status === 'error' ? <div className="py-8 text-sm text-red">加载失败：{errMsg}</div> : null}
        <div className="relative h-[360px]" style={{ display: status === 'done' ? 'block' : 'none' }}>
          <canvas ref={canvasRef} />
        </div>
      </div>
    </div>
  );
}
