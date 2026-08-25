'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import {
  CampaignCard,
  Card,
  CardHead,
  CreatorCard,
  EmptyState,
  Eyebrow,
  PageHeader,
  Sparkline,
  TrendChart,
  usePaStore,
} from '@/components/pa';
import { Button, buttonClasses, Dropdown, MetricCard, Segment } from '@/components/ui';
import { activeCampaigns, totals } from '@/lib/pa/derive';
import { compact, int, money, roas } from '@/lib/pa/format';
import type { CampaignStatus } from '@/lib/pa/types';

type MomentumMetric = 'ROAS' | 'Reach' | 'Impressions' | 'Clicks' | 'Views' | 'Installs' | 'Spend';

const RANGE_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 };

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

function dateLabels(range: string, count: number): string[] {
  const days = RANGE_DAYS[range] ?? 30;
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  return Array.from({ length: count }, (_, index) => {
    const elapsed = Math.round((index / Math.max(count - 1, 1)) * (days - 1));
    const date = new Date(now);
    date.setDate(now.getDate() - (days - 1 - elapsed));
    return formatter.format(date);
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
  const [range, setRange] = useState('30D');
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
  const count = RANGE_DAYS[range] ?? 30;
  const trend = dailySeries(metricValue[metric], metricChange[metric], count);
  const axis = dateLabels(range, count);
  const displayCount = count <= 7 ? 7 : 10;
  const displayTrend = sampleEvenly(trend, displayCount);
  const displayAxis = sampleEvenly(axis, displayCount);
  const headline = formatMetric(metric, metricValue[metric]);
  const headlineChange = `+ ${(metricChange[metric] * 100).toFixed(1)}% vs previous period`;

  const metricCards = [
    {
      label: 'Active campaigns',
      value: int(active.length),
      sub: '+ 4.1% day over day',
      points: dailySeries(active.length, 0.041, 8),
      color: 'var(--color-pa-accent)',
    },
    {
      label: 'KOL partners',
      value: int(1284),
      sub: '+ 12.4% day over day',
      points: dailySeries(1284, 0.124, 8),
      color: 'var(--color-pa-chart-1)',
    },
    {
      label: 'Total reach',
      value: compact(t.audience),
      sub: '+ 18.1% day over day',
      points: dailySeries(t.audience, 0.181, 8),
      color: 'var(--color-pa-chart-2)',
    },
    {
      label: 'Blended ROAS',
      value: roas(t.roas),
      sub: '+ 10.6% day over day',
      points: dailySeries(t.roas, 0.106, 8),
      color: 'var(--color-pa-chart-3)',
    },
    {
      label: 'Impressions',
      value: compact(t.impressions),
      sub: '+ 16.4% day over day',
      points: dailySeries(t.impressions, 0.164, 8),
      color: 'var(--color-pa-chart-1)',
    },
    {
      label: 'Total clicks',
      value: compact(deliveryTotals.clicks),
      sub: '+ 12.4% day over day',
      points: dailySeries(deliveryTotals.clicks, 0.124, 8),
      color: 'var(--color-pa-chart-2)',
    },
    {
      label: 'Video views',
      value: compact(deliveryTotals.views),
      sub: '+ 14.2% day over day',
      points: dailySeries(deliveryTotals.views, 0.142, 8),
      color: 'var(--color-pa-chart-4)',
    },
    {
      label: 'Installs',
      value: compact(t.installs),
      sub: '+ 9.6% day over day',
      points: dailySeries(t.installs, 0.096, 8),
      color: 'var(--color-pa-chart-3)',
    },
    {
      label: 'Ad spend',
      value: money(t.spend),
      sub: '+ 8.2% day over day',
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
            <div className="w-[170px]">
              <Dropdown
                aria-label="Date range"
                value={range}
                onChange={setRange}
                options={[
                  { value: '7D', label: 'Last 7 days' },
                  { value: '30D', label: 'Last 30 days' },
                  { value: '90D', label: 'Last 90 days' },
                ]}
              />
            </div>
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
              sub={card.sub}
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
            sub="Attributed performance across all active channels"
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
                <Segment
                  aria-label="Range"
                  value={range}
                  onChange={setRange}
                  items={[
                    { value: '7D', label: '7D' },
                    { value: '30D', label: '30D' },
                    { value: '90D', label: '90D' },
                  ]}
                />
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
                label={`${metric} trend over ${range}`}
                color={trendColor(metric)}
                valueFormatter={(value) => formatMetric(metric, value)}
              />
            </div>
          </div>
        </Card>

        <Card>
          <CardHead title="Channel mix" sub="Share of attributed reach" />
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
          <h2 className="text-[16px] font-semibold leading-[22px]">Collaborating creators</h2>
          <p className="text-pa-11 text-pa-content-tertiary">
            Live social accounts and their attributed campaign delivery
          </p>
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
      <div className="mb-pa-6 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-pa-3">
        {deliveryCreators.slice(0, 8).map((id) => {
          const creator = state.creators.find((c) => c.id === id);
          const delivery = state.delivery.find((d) => d.creatorId === id);
          if (!creator || !delivery) return null;
          return (
            <CreatorCard
              key={id}
              creator={creator}
              delivery={delivery}
              campaign={state.campaigns.find((c) => c.id === delivery.campaignId)}
            />
          );
        })}
      </div>

      <div className="mb-pa-3 flex flex-wrap items-end justify-between gap-pa-3">
        <div>
          <h2 className="text-[16px] font-semibold leading-[22px]">Active campaigns</h2>
          <p className="text-pa-11 text-pa-content-tertiary">
            {shown.length} priority campaigns · refreshed {state.lastSync}
          </p>
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
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-pa-3">
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
