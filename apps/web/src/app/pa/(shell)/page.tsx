'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import {
  CampaignCard,
  Card,
  CardHead,
  CreatorCard,
  DateRangePicker,
  dateRangeLabels,
  daysBetween,
  defaultDateRange,
  EmptyState,
  Eyebrow,
  formatDateRange,
  PageHeader,
  Sparkline,
  TrendChart,
  usePaStore,
} from '@/components/pa';
import { Button, buttonClasses, Dropdown, MetricCard } from '@/components/ui';
import { activeCampaigns, totals } from '@/lib/pa/derive';
import { compact, int, money, roas } from '@/lib/pa/format';
import type { CampaignStatus, Delivery } from '@/lib/pa/types';

type MomentumMetric = 'ROAS' | 'Reach' | 'Impressions' | 'Clicks' | 'Views' | 'Installs' | 'Spend';

function sampleEvenly<T>(values: T[], count: number): T[] {
  if (values.length <= count) return values;
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round((index / Math.max(count - 1, 1)) * (values.length - 1));
    return values[sourceIndex] as T;
  });
}

function dailySeries(base: number, change: number, count: number): number[] {
  const safeBase = Math.max(base, 1);
  const start = safeBase / (1 + change);
  return Array.from({ length: count }, (_, index) => {
    const progress = count === 1 ? 1 : index / (count - 1);
    const wave = Math.sin(index * 1.7) * 0.035;
    return Math.max(0, start * (1 + (change + wave) * progress));
  });
}

function trendColor(metric: MomentumMetric): string {
  return metric === 'ROAS'
    ? 'var(--color-pa-chart-3)'
    : metric === 'Reach' || metric === 'Impressions'
      ? 'var(--color-pa-chart-1)'
      : metric === 'Spend'
        ? 'var(--color-pa-accent)'
        : 'var(--color-pa-chart-2)';
}

function formatMetric(metric: MomentumMetric, value: number): string {
  return metric === 'ROAS'
    ? `${value.toFixed(2)}×`
    : metric === 'Spend'
      ? money(value)
      : compact(value);
}

/** 渠道构成。⚠️ 槽位 3–5 白底 <3:1，每行必须直接标注，不能只靠颜色图例。 */
const MIX = [
  { label: 'Instagram', value: 16.4, pct: 34, color: 'var(--color-pa-chart-1)' },
  { label: 'TikTok', value: 14, pct: 29, color: 'var(--color-pa-chart-2)' },
  { label: 'YouTube', value: 11.1, pct: 23, color: 'var(--color-pa-chart-3)' },
  { label: 'Other', value: 6.7, pct: 14, color: 'var(--color-pa-chart-4)' },
];

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'running', label: 'Live' },
  { value: 'review', label: 'Needs review' },
  { value: 'draft', label: 'Draft' },
  { value: 'stopped', label: 'Stopped' },
];

export default function OverviewPage(): ReactNode {
  const { state } = usePaStore();
  const [metric, setMetric] = useState<MomentumMetric>('ROAS');
  const [range, setRange] = useState(() => defaultDateRange(30));
  const [status, setStatus] = useState('all');

  const t = totals(state);
  const active = activeCampaigns(state.campaigns);
  const deliveryTotals = state.delivery.reduce(
    (acc, delivery) => ({
      clicks: acc.clicks + delivery.clicks,
      views: acc.views + delivery.views,
    }),
    { clicks: 0, views: 0 },
  );
  const shown = state.campaigns
    .filter((c) => (status === 'all' ? true : c.status === (status as CampaignStatus)))
    .slice(0, 6);

  const deliveryCreators = [...new Set(state.delivery.map((d) => d.creatorId))];
  const metricValue: Record<MomentumMetric, number> = {
    ROAS: t.roas,
    Reach: t.audience,
    Impressions: t.impressions,
    Clicks: deliveryTotals.clicks,
    Views: deliveryTotals.views,
    Installs: t.installs,
    Spend: t.spend,
  };
  const metricChange: Record<MomentumMetric, number> = {
    ROAS: 0.106,
    Reach: 0.181,
    Impressions: 0.164,
    Clicks: 0.124,
    Views: 0.142,
    Installs: 0.096,
    Spend: 0.082,
  };
  const count = daysBetween(range.start, range.end);
  const trend = dailySeries(metricValue[metric], metricChange[metric], count);
  const axis = dateRangeLabels(range);
  const displayCount = count <= 7 ? count : 10;
  const displayTrend = sampleEvenly(trend, displayCount);
  const displayAxis = sampleEvenly(axis, displayCount);
  const headline = formatMetric(metric, metricValue[metric]);
  const headlineChange = `+ ${(metricChange[metric] * 100).toFixed(1)}% vs previous period`;

  const metricCards = [
    {
      label: 'Active campaigns',
      value: int(active.length),
      points: dailySeries(active.length, 0.041, 8),
      color: 'var(--color-pa-accent)',
    },
    {
      label: 'KOL partners',
      value: int(1284),
      points: dailySeries(1284, 0.124, 8),
      color: 'var(--color-pa-chart-1)',
    },
    {
      label: 'Total reach',
      value: compact(t.audience),
      points: dailySeries(t.audience, 0.181, 8),
      color: 'var(--color-pa-chart-2)',
    },
    {
      label: 'Blended ROAS',
      value: roas(t.roas),
      points: dailySeries(t.roas, 0.106, 8),
      color: 'var(--color-pa-chart-3)',
    },
    {
      label: 'Impressions',
      value: compact(t.impressions),
      points: dailySeries(t.impressions, 0.164, 8),
      color: 'var(--color-pa-chart-1)',
    },
    {
      label: 'Total clicks',
      value: compact(deliveryTotals.clicks),
      points: dailySeries(deliveryTotals.clicks, 0.124, 8),
      color: 'var(--color-pa-chart-2)',
    },
    {
      label: 'Video views',
      value: compact(deliveryTotals.views),
      points: dailySeries(deliveryTotals.views, 0.142, 8),
      color: 'var(--color-pa-chart-4)',
    },
    {
      label: 'Installs',
      value: compact(t.installs),
      points: dailySeries(t.installs, 0.096, 8),
      color: 'var(--color-pa-chart-3)',
    },
    {
      label: 'Ad spend',
      value: money(t.spend),
      points: dailySeries(t.spend, 0.082, 8),
      color: 'var(--color-pa-accent)',
    },
  ];

  return (
    <>
      <Eyebrow>Overview / Live</Eyebrow>
      <PageHeader
        title="KOL advertising matrix"
        lede="Cross-platform campaign coverage, creator performance and investment health."
        actions={
          <>
            <DateRangePicker value={range} onChange={setRange} className="w-[292px] max-w-full" />
            <Link href="/pa/campaigns/new" className={buttonClasses()}>
              Create campaign
            </Link>
          </>
        }
      />

      <div
        className="-mx-pa-1 mb-pa-4 overflow-x-auto px-pa-1 pb-pa-2"
        aria-label="Overview metrics"
      >
        <div className="flex min-w-max snap-x gap-pa-3">
          {metricCards.map((card) => (
            <MetricCard
              key={card.label}
              label={card.label}
              value={card.value}
              className="w-[244px] shrink-0 snap-start"
              trust={{ state: 'fresh', text: `fresh · ${state.lastSync}` }}
              aside={<Sparkline points={card.points} color={card.color} width={94} height={28} />}
            />
          ))}
        </div>
      </div>

      <div className="mb-pa-6 grid gap-pa-3 xl:grid-cols-[minmax(0,2.3fr)_minmax(0,1fr)]">
        <Card>
          <CardHead
            title="Cross-platform momentum"
            aside={
              <div className="flex flex-wrap gap-pa-2">
                <div className="w-[150px]">
                  <Dropdown
                    aria-label="Trend metric"
                    value={metric}
                    onChange={(value) => {
                      setMetric(value as MomentumMetric);
                    }}
                    options={[
                      { value: 'ROAS', label: 'ROAS' },
                      { value: 'Reach', label: 'Reach' },
                      { value: 'Impressions', label: 'Impressions' },
                      { value: 'Clicks', label: 'Total clicks' },
                      { value: 'Views', label: 'Video views' },
                      { value: 'Installs', label: 'Installs' },
                      { value: 'Spend', label: 'Ad spend' },
                    ]}
                  />
                </div>
              </div>
            }
          />
          <div className="p-pa-4">
            <div className="flex flex-wrap items-baseline gap-[10px]">
              <b className="pa-num text-[21px] leading-[28px]">{headline}</b>
              <span className="pa-num text-pa-11 text-pa-positive">{headlineChange}</span>
            </div>
            <div className="mt-pa-4">
              <TrendChart
                points={displayTrend}
                labels={displayAxis}
                dailyPoints={trend}
                dailyLabels={axis}
                label={`${metric} trend over ${formatDateRange(range)}`}
                color={trendColor(metric)}
                valueFormatter={(value) => formatMetric(metric, value)}
              />
            </div>
          </div>
        </Card>

        <Card>
          <CardHead title="Channel mix" />
          <div className="p-pa-4">
            <div className="flex items-baseline justify-between">
              <b className="pa-num text-pa-20">{compact(t.audience)}</b>
              <span className="text-pa-11 text-pa-content-tertiary">total audience</span>
            </div>
            <div className="mt-[14px] flex overflow-hidden rounded-pa-full">
              {MIX.map((m) => (
                <i key={m.label} className="h-[9px]" style={{ flex: m.pct, background: m.color }} />
              ))}
            </div>
            <div className="mt-pa-4">
              {MIX.map((m) => (
                <div key={m.label} className="flex items-center justify-between py-[6px]">
                  <span className="flex items-center gap-[9px]">
                    <i className="h-[8px] w-[8px] rounded-full" style={{ background: m.color }} />
                    <span className="text-pa-12">{m.label}</span>
                  </span>
                  <span className="flex items-center gap-[14px]">
                    <span className="pa-num text-pa-11 text-pa-content-tertiary">{m.value}M</span>
                    <b className="pa-num text-pa-11">{m.pct}%</b>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>

      <div className="mb-pa-3 flex flex-wrap items-end justify-between gap-pa-3">
        <div>
          <h2 className="text-pa-18 font-bold leading-[24px] text-pa-content">
            Collaborating creators
          </h2>
        </div>
        <div className="flex items-center gap-pa-3">
          <span className="pa-num text-pa-11 text-pa-content-tertiary">
            {deliveryCreators.length} active creators
          </span>
          <Link href="/pa/kols" className={buttonClasses('secondary', 'sm')}>
            View network
          </Link>
        </div>
      </div>
      <div className="mb-pa-6 grid grid-cols-1 gap-pa-3 sm:grid-cols-2 xl:grid-cols-4">
        {(() => {
          const fallbackCampaign = active[0] ?? state.campaigns[0];
          const creatorIds = [
            ...deliveryCreators,
            ...state.creators.map((creator) => creator.id),
          ].filter((id, index, ids) => ids.indexOf(id) === index);
          return creatorIds.slice(0, 8).map((id, index) => {
            const creator = state.creators.find((item) => item.id === id);
            if (!creator) return null;
            const existing = state.delivery.find((delivery) => delivery.creatorId === id);
            const delivery: Delivery | undefined =
              existing ??
              (fallbackCampaign
                ? {
                    creatorId: creator.id,
                    campaignId: fallbackCampaign.id,
                    impressions: Math.round(creator.avgViews * 1.35),
                    clicks: Math.max(1, Math.round(creator.avgViews * 0.035)),
                    revenue: Math.max(1, Math.round(creator.avgViews * 0.012)),
                    pacing: Math.min(94, 46 + index * 5),
                    roas: Number((1.9 + (index % 5) * 0.42).toFixed(2)),
                    fit: Math.max(68, 94 - index * 3),
                    state: 'live',
                    views: Math.round(creator.avgViews * 0.72),
                    cpi: 2.18,
                  }
                : undefined);
            if (!delivery) return null;
            return <CreatorCard key={id} creator={creator} delivery={delivery} />;
          });
        })()}
      </div>

      <div className="mb-pa-3 flex flex-wrap items-end justify-between gap-pa-3">
        <div>
          <h2 className="text-pa-18 font-bold leading-[24px] text-pa-content">Active campaigns</h2>
        </div>
        <div className="flex items-center gap-pa-3">
          <div className="w-[170px]">
            <Dropdown
              aria-label="Status"
              value={status}
              onChange={setStatus}
              options={STATUS_OPTIONS}
            />
          </div>
          <Link href="/pa/campaigns" className={buttonClasses('secondary', 'sm')}>
            View all
          </Link>
        </div>
      </div>
      {shown.length > 0 ? (
        <div className="grid grid-cols-1 gap-pa-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((campaign) => {
            const product = state.products.find((p) => p.id === campaign.productId);
            if (!product) return null;
            return <CampaignCard key={campaign.id} campaign={campaign} product={product} />;
          })}
        </div>
      ) : (
        <Card>
          <EmptyState
            title="No campaigns match this status"
            description="Nothing in this workspace is currently marked with that status."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setStatus('all');
                }}
              >
                Show all statuses
              </Button>
            }
          />
        </Card>
      )}
    </>
  );
}
