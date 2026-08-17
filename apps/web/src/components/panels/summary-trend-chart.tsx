'use client';

import { Chart, type ChartDataset } from 'chart.js/auto';
import { useEffect, useRef } from 'react';

import { fmt } from '@/lib/client/format';
import type { DayData } from '@/lib/client/summary';

interface Point {
  x: number;
  y: number;
}

/** ISO → 当日北京时区小时数（跨天记 24），复刻旧 getLocalHour。 */
function getLocalHour(isoStr: string, dayDate: string | undefined): number {
  const d = new Date(isoStr);
  const localDate = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const parts = d
    .toLocaleString('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    })
    .split(':');
  const h = Number.parseInt(parts[0] ?? '0', 10);
  const m = Number.parseInt(parts[1] ?? '0', 10);
  if (dayDate != null && localDate > dayDate) return 24;
  return h + m / 60;
}

/** 汇总面板当日趋势图（Chart.js line，5 条数据集，颜色/坐标轴逐字复刻旧 renderTrendChart）。 */
export function SummaryTrendChart({ dayData }: { dayData: DayData }): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (dayData.snapshots.length === 0) {
      chartRef.current?.destroy();
      chartRef.current = null;
      return;
    }

    const athenaPoints: Point[] = [];
    const athenaNewPoints: Point[] = [];
    const afPoints: Point[] = [];
    const afLtvPoints: Point[] = [];
    const xmpPoints: Point[] = [];

    for (const s of dayData.snapshots) {
      if (s.time == null) continue;
      const hour = getLocalHour(s.time, dayData.date);
      if (s.athena) {
        athenaPoints.push({ x: hour, y: s.athena.reduce((sum, a) => sum + (a.totalRevenue ?? 0), 0) });
        athenaNewPoints.push({
          x: hour,
          y: s.athena.reduce((sum, a) => sum + (a.newUserRevenue ?? 0), 0),
        });
      }
      if (s.af) {
        afPoints.push({ x: hour, y: s.af.reduce((sum, a) => sum + (a.revenueActual ?? 0), 0) });
        afLtvPoints.push({ x: hour, y: s.af.reduce((sum, a) => sum + (a.revenueLTV ?? 0), 0) });
      }
      if (s.xmp) xmpPoints.push({ x: hour, y: s.xmp.reduce((sum, x) => sum + (x.cost ?? 0), 0) });
    }

    chartRef.current?.destroy();
    chartRef.current = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          mkDataset('雅典娜总收入', athenaPoints, '#00d4ff', 'rgba(0,212,255,0.1)', 5, 7),
          mkDataset('雅典娜新用户收入', athenaNewPoints, '#66e3ff', 'rgba(102,227,255,0.1)', 4, 6),
          mkDataset('AF Actual', afPoints, '#00ff88', 'rgba(0,255,136,0.1)', 5, 7),
          mkDataset('AF LTV', afLtvPoints, '#7dffb9', 'rgba(125,255,185,0.1)', 4, 6),
          mkDataset('XMP 消耗', xmpPoints, '#ff4444', 'rgba(255,68,68,0.1)', 5, 7),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false },
        plugins: {
          legend: { labels: { color: '#8888aa', font: { size: 12 } } },
          tooltip: {
            callbacks: {
              title: (items) => {
                const first = items[0];
                if (!first) return '';
                const h = (first.raw as Point).x;
                const hh = Math.floor(h);
                const mm = Math.round((h - hh) * 60);
                return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
              },
              label: (ctx) => `${ctx.dataset.label ?? ''}: ${fmt((ctx.raw as Point).y)}`,
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: 24,
            ticks: {
              color: '#555577',
              font: { size: 11 },
              stepSize: 1,
              callback: (value) => {
                const v = typeof value === 'number' ? value : Number(value);
                return v % 2 === 0 ? `${String(v).padStart(2, '0')}:00` : '';
              },
            },
            grid: { color: 'rgba(255,255,255,0.04)' },
            title: { display: true, text: '时间', color: '#555577' },
          },
          y: {
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

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [dayData]);

  return (
    <div className="relative h-[360px]">
      <canvas ref={canvasRef} />
    </div>
  );
}

function mkDataset(
  label: string,
  data: Point[],
  color: string,
  bg: string,
  pointRadius: number,
  pointHoverRadius: number,
): ChartDataset<'line', Point[]> {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: bg,
    borderWidth: 2,
    tension: 0,
    fill: false,
    pointRadius,
    pointHoverRadius,
    pointBackgroundColor: color,
    pointBorderColor: color,
    showLine: true,
    spanGaps: true,
  };
}
