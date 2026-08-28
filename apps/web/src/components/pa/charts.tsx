'use client';

import { useEffect, useRef, useState } from 'react';
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

interface TrendChartProps {
  points: number[];
  labels: string[];
  /** Full daily series used only for hover/focus readouts. */
  dailyPoints?: number[];
  dailyLabels?: string[];
  label: string;
  color?: string;
  height?: number;
  valueFormatter?: (value: number) => string;
}

function smoothPath(coords: readonly (readonly [number, number])[]): string {
  if (coords.length < 3) {
    return coords
      .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
      .join(' ');
  }
  return coords.reduce((path, [x, y], index) => {
    if (index === 0) return `M${x.toFixed(1)} ${y.toFixed(1)}`;
    const previous = coords[index - 1] as readonly [number, number];
    const beforePrevious = (coords[index - 2] ?? previous) as readonly [number, number];
    const next = (coords[index + 1] ?? [x, y]) as readonly [number, number];
    const cp1x = previous[0] + (x - beforePrevious[0]) / 6;
    const cp1y = previous[1] + (y - beforePrevious[1]) / 6;
    const cp2x = x - (next[0] - previous[0]) / 6;
    const cp2y = y - (next[1] - previous[1]) / 6;
    return `${path} C${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }, '');
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

/**
 * Dashboard trend chart with shared axis, grid and native point tooltips.
 * The caller supplies the current metric series; no date or business value is
 * embedded in the chart itself, so it can be replaced by API daily snapshots.
 */
export function TrendChart({
  points,
  labels,
  dailyPoints,
  dailyLabels,
  label,
  color = 'var(--color-pa-accent)',
  height = 250,
  valueFormatter = (value) => value.toLocaleString('en-US'),
}: TrendChartProps): ReactNode {
  const [hoveredDailyIndex, setHoveredDailyIndex] = useState<number | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(760);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const nextWidth = Math.round(frame.getBoundingClientRect().width);
      if (nextWidth > 0) setFrameWidth(nextWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  if (points.length < 2) return null;

  // Use the rendered card width as the SVG coordinate space. This keeps the
  // plot, labels, hover rail and tooltip aligned at every responsive width.
  const width = Math.max(320, frameWidth);
  // Reserve enough room for formatted values such as "$620,825" so the
  // y-axis labels remain fully visible instead of being clipped by the SVG.
  const padLeft = width < 480 ? 58 : width < 720 ? 68 : 78;
  const padRight = width < 480 ? 6 : 10;
  const padTop = 16;
  const padBottom = 34;
  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padTop - padBottom;
  const hoverPoints = dailyPoints && dailyPoints.length > 1 ? dailyPoints : points;
  const hoverLabels = dailyLabels?.length === hoverPoints.length ? dailyLabels : labels;
  const min = Math.min(...points, ...hoverPoints);
  const max = Math.max(...points, ...hoverPoints);
  const span = max - min || Math.max(Math.abs(max) * 0.12, 1);
  const domainMin = min - span * 0.12;
  const domainMax = max + span * 0.12;
  const domainSpan = domainMax - domainMin;
  const xFor = (index: number): number => padLeft + (index / (points.length - 1)) * chartWidth;
  const yFor = (value: number): number =>
    padTop + (1 - (value - domainMin) / domainSpan) * chartHeight;
  const coords = points.map((value, index) => [xFor(index), yFor(value)] as const);
  const line = smoothPath(coords);
  const area = `${line} L${xFor(points.length - 1).toFixed(1)} ${String(
    padTop + chartHeight,
  )} L${xFor(0).toFixed(1)} ${String(padTop + chartHeight)} Z`;
  const tickValues = Array.from({ length: 4 }, (_, index) => domainMax - (index / 3) * domainSpan);
  const labelStride =
    width < 480
      ? Math.max(1, Math.ceil(points.length / 4))
      : width < 720
        ? Math.max(1, Math.ceil(points.length / 6))
        : 1;
  const visibleLabels =
    labels.length === points.length
      ? labels.map((value, index) =>
          index === 0 || index === labels.length - 1 || index % labelStride === 0 ? value : '',
        )
      : points.map(() => '');
  const dailyCount = hoverPoints.length;
  const hoveredValue = hoveredDailyIndex === null ? null : (hoverPoints[hoveredDailyIndex] ?? null);
  const hoveredLabel = hoveredDailyIndex === null ? null : (hoverLabels[hoveredDailyIndex] ?? null);
  const previousValue =
    hoveredDailyIndex === null || hoveredDailyIndex === 0
      ? null
      : (hoverPoints[hoveredDailyIndex - 1] ?? null);
  const dailyChange =
    hoveredValue !== null && previousValue !== null && previousValue !== 0
      ? ((hoveredValue - previousValue) / Math.abs(previousValue)) * 100
      : null;
  const hoveredRatio =
    hoveredDailyIndex === null ? null : hoveredDailyIndex / Math.max(dailyCount - 1, 1);
  const hoveredX = hoveredRatio === null ? null : padLeft + hoveredRatio * chartWidth;
  const displayPosition =
    hoveredRatio === null ? null : hoveredRatio * Math.max(points.length - 1, 1);
  const displayStart = displayPosition === null ? null : Math.floor(displayPosition);
  const displayEnd = displayPosition === null ? null : Math.ceil(displayPosition);
  const displayFraction =
    displayPosition === null || displayStart === null ? 0 : displayPosition - displayStart;
  const lineValue =
    displayStart === null || displayEnd === null
      ? null
      : (points[displayStart] ?? points[0] ?? 0) * (1 - displayFraction) +
        (points[displayEnd] ?? points[points.length - 1] ?? 0) * displayFraction;
  const hoveredPoint =
    hoveredX === null || lineValue === null ? null : ([hoveredX, yFor(lineValue)] as const);
  const tooltipLeft = hoveredPoint ? `${(hoveredPoint[0] / width) * 100}%` : '0%';
  const tooltipTop = hoveredPoint ? `${(hoveredPoint[1] / height) * 100}%` : '0%';
  const tooltipTransform =
    hoveredDailyIndex === 0
      ? 'translate(0, calc(-100% - 16px))'
      : hoveredDailyIndex === dailyCount - 1
        ? 'translate(-100%, calc(-100% - 16px))'
        : hoveredPoint && hoveredPoint[1] < padTop + 74
          ? 'translate(-50%, 16px)'
          : 'translate(-50%, calc(-100% - 16px))';

  return (
    <div ref={frameRef} className="relative" onMouseLeave={() => setHoveredDailyIndex(null)}>
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const normalizedX = ((event.clientX - rect.left) / rect.width) * width;
          const clampedX = Math.min(width - padRight, Math.max(padLeft, normalizedX));
          const index = Math.round(((clampedX - padLeft) / chartWidth) * (dailyCount - 1));
          setHoveredDailyIndex(index);
        }}
        onMouseLeave={() => setHoveredDailyIndex(null)}
      >
        {tickValues.map((value, index) => {
          const y = yFor(value);
          return (
            <g key={`tick-${index}`}>
              <line
                x1={padLeft}
                y1={y}
                x2={width - padRight}
                y2={y}
                stroke="var(--color-pa-border-subtle)"
                strokeDasharray="3 5"
              />
              <text
                x={padLeft - 10}
                y={y + 4}
                fill="var(--color-pa-content-tertiary)"
                fontSize="11"
                textAnchor="end"
              >
                {valueFormatter(value)}
              </text>
            </g>
          );
        })}
        <path d={area} fill={color} opacity="0.1" />
        <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        {coords.map(([x, y], index) => {
          const markerDailyIndex = Math.round(
            (index / Math.max(points.length - 1, 1)) * (dailyCount - 1),
          );
          const isHovered = hoveredDailyIndex === markerDailyIndex;
          return (
            <g key={`point-${index}`}>
              <circle
                cx={x}
                cy={y}
                r="11"
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${labels[index] ?? 'Day'}: ${valueFormatter(points[index] ?? 0)}`}
                onMouseEnter={() => setHoveredDailyIndex(markerDailyIndex)}
                onFocus={() => setHoveredDailyIndex(markerDailyIndex)}
                onBlur={() => setHoveredDailyIndex(null)}
                style={{ cursor: 'pointer', outline: 'none' }}
              >
                <title>
                  {labels[index] ?? ''}: {valueFormatter(points[index] ?? 0)}
                </title>
              </circle>
              <circle
                cx={x}
                cy={y}
                r={isHovered ? 5 : 4}
                fill="var(--color-pa-surface)"
                stroke={color}
                strokeWidth={isHovered ? 2.5 : 2}
                pointerEvents="none"
              />
              {visibleLabels[index] ? (
                <text
                  x={x}
                  y={height - 10}
                  fill="var(--color-pa-content-tertiary)"
                  fontSize="11"
                  textAnchor={
                    index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'
                  }
                  pointerEvents="none"
                >
                  {visibleLabels[index]}
                </text>
              ) : null}
            </g>
          );
        })}
        {hoveredPoint ? (
          <line
            x1={hoveredPoint[0]}
            y1={padTop}
            x2={hoveredPoint[0]}
            y2={padTop + chartHeight}
            stroke={color}
            strokeOpacity="0.22"
            strokeDasharray="3 5"
            pointerEvents="none"
          />
        ) : null}
      </svg>
      {hoveredPoint && hoveredValue !== null ? (
        <div
          className="pointer-events-none absolute z-10 min-w-[172px] rounded-[10px] border px-3 py-2.5 text-left"
          style={{
            left: tooltipLeft,
            top: tooltipTop,
            transform: tooltipTransform,
            background: 'color-mix(in srgb, var(--color-pa-surface) 82%, transparent)',
            borderColor: 'color-mix(in srgb, var(--color-pa-border) 86%, transparent)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            boxShadow: '0 12px 30px rgba(15, 23, 42, 0.16)',
          }}
        >
          <div className="text-pa-11 font-medium text-pa-content-tertiary">
            {hoveredLabel ?? 'Daily snapshot'}
          </div>
          <div className="mt-1 flex items-baseline justify-between gap-4">
            <span className="text-pa-11 text-pa-content-secondary">{label.split(' trend')[0]}</span>
            <b className="pa-num text-[17px] leading-[22px] text-pa-content">
              {valueFormatter(hoveredValue)}
            </b>
          </div>
          <div className="mt-1 text-pa-11">
            {dailyChange === null ? (
              <span className="text-pa-content-tertiary">Starting point</span>
            ) : (
              <span className={dailyChange >= 0 ? 'text-pa-positive' : 'text-pa-negative'}>
                {dailyChange >= 0 ? '+' : ''}
                {dailyChange.toFixed(1)}% vs previous day
              </span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
