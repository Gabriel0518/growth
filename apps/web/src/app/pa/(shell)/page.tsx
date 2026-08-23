'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import {
  AreaChart,
  CampaignCard,
  Card,
  CardHead,
  CreatorCard,
  EmptyState,
  Eyebrow,
  PageHeader,
  Sparkline,
  usePaStore,
} from '@/components/pa';
import { Button, buttonClasses, Dropdown, MetricCard, Segment } from '@/components/ui';
import { activeCampaigns, totals } from '@/lib/pa/derive';
import { compact, int, money, roas } from '@/lib/pa/format';
import type { CampaignStatus } from '@/lib/pa/types';

/** 演示用的走势序列。接后端后由 DemoOverview.trend 提供。 */
const SPARKS = {
  active: [8, 11, 9, 14, 13, 18, 17, 22],
  partners: [30, 34, 33, 41, 47, 52, 58, 64],
  reach: [12, 18, 22, 19, 28, 34, 41, 48],
  roas: [3.1, 3.4, 3.3, 3.9, 4.2, 4.5, 4.6, 4.8],
};
const TREND: Record<string, number[]> = {
  '7D': [4.31, 4.28, 4.42, 4.51, 4.6, 4.72, 4.82],
  '30D': [3.55, 3.62, 3.71, 3.8, 3.95, 4.02, 4.18, 4.3, 4.41, 4.52, 4.63, 4.7, 4.76, 4.82],
  '90D': [2.6, 2.9, 3.05, 3.2, 3.35, 3.5, 3.62, 3.8, 3.98, 4.15, 4.3, 4.48, 4.62, 4.82],
};
const AXES: Record<string, string[]> = {
  '7D': ['Aug 12', 'Aug 14', 'Aug 16', 'Aug 18'],
  '30D': ['Jul 20', 'Jul 27', 'Aug 03', 'Aug 10', 'Aug 18'],
  '90D': ['May 20', 'Jun 15', 'Jul 10', 'Aug 18'],
};

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
  const [metric, setMetric] = useState('ROAS');
  const [range, setRange] = useState('30D');
  const [status, setStatus] = useState('all');

  const t = totals(state);
  const active = activeCampaigns(state.campaigns);
  const shown = state.campaigns
    .filter((c) => (status === 'all' ? true : c.status === (status as CampaignStatus)))
    .slice(0, 6);

  const trend = TREND[range] ?? [];
  const axis = AXES[range] ?? [];
  const deliveryCreators = [...new Set(state.delivery.map((d) => d.creatorId))];
  const headline =
    metric === 'ROAS' ? roas(t.roas) : metric === 'Reach' ? compact(t.audience) : money(t.spend);

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

      <div className="mb-pa-4 grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-pa-3">
        <MetricCard
          label="Active campaigns"
          value={int(active.length)}
          sub="+ 4 this month"
          trust={{ state: 'fresh', text: `fresh · ${state.lastSync}` }}
          aside={<Sparkline points={SPARKS.active} color="var(--color-pa-accent)" />}
        />
        <MetricCard
          label="KOL partners"
          value={int(1284)}
          sub="+ 12.4%"
          trust={{ state: 'fresh', text: `fresh · ${state.lastSync}` }}
          aside={<Sparkline points={SPARKS.partners} color="var(--color-pa-chart-1)" />}
        />
        <MetricCard
          label="Total reach"
          value={compact(t.audience)}
          sub="+ 18.1%"
          trust={{ state: 'fresh', text: `fresh · ${state.lastSync}` }}
          aside={<Sparkline points={SPARKS.reach} color="var(--color-pa-chart-2)" />}
        />
        <MetricCard
          label="Blended ROAS"
          value={roas(t.roas)}
          sub="+ 0.46 vs prior"
          trust={{ state: 'fresh', text: `fresh · ${state.lastSync}` }}
          aside={<Sparkline points={SPARKS.roas} color="var(--color-pa-chart-3)" />}
        />
      </div>

      <div className="mb-pa-6 grid gap-pa-3 xl:grid-cols-[minmax(0,2.3fr)_minmax(0,1fr)]">
        <Card>
          <CardHead
            title="Cross-platform momentum"
            sub="Attributed performance across all active channels"
            aside={
              <div className="flex flex-wrap gap-pa-2">
                <Segment
                  aria-label="Metric"
                  value={metric}
                  onChange={setMetric}
                  items={[
                    { value: 'ROAS', label: 'ROAS' },
                    { value: 'Reach', label: 'Reach' },
                    { value: 'Spend', label: 'Spend' },
                  ]}
                />
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
              <span className="pa-num text-pa-11 text-pa-positive">+ 10.6% vs previous period</span>
            </div>
            <div className="mt-pa-4">
              <AreaChart points={trend} label={`${metric} trend`} />
            </div>
            <div className="mt-pa-2 flex justify-between font-pa-mono text-pa-11 text-pa-content-tertiary">
              {axis.map((a) => (
                <span key={a}>{a}</span>
              ))}
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
            {deliveryCreators.length} active partners
          </span>
          <Link href="/pa/kols" className={buttonClasses('secondary', 'sm')}>
            View network
          </Link>
        </div>
      </div>
      <div className="mb-pa-6 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-pa-3">
        {deliveryCreators.slice(0, 4).map((id) => {
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
