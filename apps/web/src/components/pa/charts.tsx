import type { ReactNode } from 'react';

/**
 * 手写 SVG 图表，移植自原型 `js/ui.js`。
 *
 * 不用 Chart.js（仓库里虽有）的三个理由：
 *   1. doc 03 §17 已把「Chart.js + 手写 SVG 两套实现」列为技术债，不再扩大
 *   2. 这两个图只有几十行，纯 SVG 可服务端渲染，不需要 client-only wrapper
 *   3. 与 Figma 稿逐像素一致；Chart.js 的默认渲染对不上
 *
 * ⚠️ 绝不用双 Y 轴。消耗和 ROAS 量纲不同，要么拆两张图，要么共同基期指数化
 * （DESIGN-SPEC / CLAUDE.md B4.4）。
 */

interface SparklineProps {
  points: number[];
  /** CSS 颜色。传 pa 令牌的 var() 形式，如 var(--color-pa-accent)。 */
  color: string;
  width?: number;
  height?: number;
}

export function Sparkline({ points, color, width = 76, height = 22 }: SparklineProps): ReactNode {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - ((p - min) / span) * (height - 3) - 1.5;
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={d} stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface AreaChartProps {
  points: number[];
  label: string;
  color?: string;
  height?: number;
  /**
   * 显式共用刻度。
   * ⚠️ 两条用于对比的序列**必须共用一个刻度** —— 各自按自己的 min/max 归一化会让
   * 小序列填满同样的高度，把对比悄悄毁掉。
   */
  scale?: [number, number];
  dots?: boolean;
}

export function AreaChart({
  points,
  label,
  color = 'var(--color-pa-accent)',
  height = 190,
  scale,
  dots = true,
}: AreaChartProps): ReactNode {
  if (points.length < 2) return null;
  const width = 660;
  const pad = 4;
  const min = scale ? scale[0] : Math.min(...points);
  const max = scale ? scale[1] : Math.max(...points);
  const span = max - min || 1;
  const xy = points.map(
    (p, i) =>
      [
        (i / (points.length - 1)) * width,
        height - ((p - min) / span) * (height - pad * 2) - pad,
      ] as const,
  );
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${String(width)} ${String(height)} L0 ${String(height)} Z`;
  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path d={area} fill={color} opacity="0.13" />
      <path d={line} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" />
      {dots
        ? xy.map(([x, y]) => (
            <circle
              key={`${x.toFixed(1)}-${y.toFixed(1)}`}
              cx={x.toFixed(1)}
              cy={y.toFixed(1)}
              r="4"
              fill="var(--color-pa-surface)"
              stroke={color}
              strokeWidth="2"
            />
          ))
        : null}
    </svg>
  );
}
