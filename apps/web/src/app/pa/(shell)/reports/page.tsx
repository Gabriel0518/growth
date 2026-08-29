'use client';

import { useState, type ReactNode } from 'react';

import {
  Card,
  CardHead,
  DateRangePicker,
  Dialog,
  Eyebrow,
  dateRangeLabels,
  daysBetween,
  defaultDateRange,
  formatDateRange,
  PageHeader,
  ProductIcon,
  Sparkline,
  Table,
  TableCard,
  TableHead,
  TableScroll,
  Td,
  useToast,
  usePaStore,
  TrendChart,
  type Column,
} from '@/components/pa';
import { Button, DataTrust, Dropdown, MetricCard, Segment } from '@/components/ui';
import { totals } from '@/lib/pa/derive';
import { campaignLabel, compact, cpi, int, money, roas } from '@/lib/pa/format';
import type { Product } from '@/lib/pa/types';

type ReportMetric =
  | 'Active campaigns'
  | 'KOL partners'
  | 'Total reach'
  | 'Blended ROAS'
  | 'Impressions'
  | 'Total clicks'
  | 'Video views'
  | 'Installs'
  | 'Ad spend';

const TREND_CHANGES: Record<ReportMetric, number> = {
  'Active campaigns': 0.041,
  'KOL partners': 0.124,
  'Total reach': 0.181,
  'Blended ROAS': 0.106,
  Impressions: 0.164,
  'Total clicks': 0.124,
  'Video views': 0.142,
  Installs: 0.096,
  'Ad spend': 0.082,
};

function dailySeries(base: number, change: number, count: number): number[] {
  const safeBase = Math.max(base, 1);
  const start = safeBase / (1 + change);
  return Array.from({ length: count }, (_, index) => {
    const progress = count === 1 ? 1 : index / (count - 1);
    const wave = Math.sin(index * 1.7) * 0.035;
    return Math.max(0, start * (1 + (change + wave) * progress));
  });
}

function sampleEvenly<T>(values: T[], count: number): T[] {
  if (values.length <= count) return values;
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round((index / Math.max(count - 1, 1)) * (values.length - 1));
    return values[sourceIndex] as T;
  });
}

function trendColor(metric: ReportMetric): string {
  return metric === 'Blended ROAS'
    ? 'var(--color-pa-chart-3)'
    : metric === 'Total reach' || metric === 'Impressions'
      ? 'var(--color-pa-chart-1)'
      : metric === 'Ad spend'
        ? 'var(--color-pa-accent)'
        : 'var(--color-pa-chart-2)';
}

function formatMetric(metric: ReportMetric, value: number): string {
  return metric === 'Blended ROAS'
    ? `${value.toFixed(2)}×`
    : metric === 'Ad spend'
      ? money(value)
      : metric === 'Active campaigns' || metric === 'KOL partners'
        ? int(value)
        : compact(value);
}

interface ReportRow {
  id: string;
  name: string;
  subtitle: string;
  market: string;
  kols: number;
  spend: number;
  impressions: number;
  installs: number;
  cpi: number;
  roas: number;
  product: Product | undefined;
}

const CAMPAIGN_COLUMNS: Column[] = [
  { key: 'name', label: 'Campaign / Product' },
  { key: 'market', label: 'Market' },
  { key: 'kols', label: 'KOLs', num: true },
  { key: 'spend', label: 'Spend', num: true },
  { key: 'impressions', label: 'Impressions', num: true },
  { key: 'installs', label: 'Installs', num: true },
  { key: 'cpi', label: 'CPI', num: true },
  { key: 'roas', label: 'ROAS', num: true },
];

const PRODUCT_COLUMNS: Column[] = [
  { key: 'name', label: 'Product' },
  { key: 'market', label: 'Market' },
  { key: 'kols', label: 'KOLs', num: true },
  { key: 'spend', label: 'Spend', num: true },
  { key: 'impressions', label: 'Impressions', num: true },
  { key: 'installs', label: 'Installs', num: true },
  { key: 'cpi', label: 'CPI', num: true },
  { key: 'roas', label: 'ROAS', num: true },
];

export default function ReportsPage(): ReactNode {
  const { state } = usePaStore();
  const toast = useToast();
  const [range, setRange] = useState(() => defaultDateRange(30));
  const [group, setGroup] = useState('campaign');
  const [trendMetric, setTrendMetric] = useState<ReportMetric>('Ad spend');
  const [exportOpen, setExportOpen] = useState(false);

  const t = totals(state);
  const activeCount = state.campaigns.filter(
    (campaign) => campaign.status !== 'stopped' && campaign.status !== 'draft',
  ).length;
  const deliveryTotals = state.delivery.reduce(
    (acc, delivery) => ({
      clicks: acc.clicks + delivery.clicks,
      views: acc.views + delivery.views,
    }),
    { clicks: 0, views: 0 },
  );
  const metricValues: Record<ReportMetric, number> = {
    'Active campaigns': activeCount,
    'KOL partners': 1284,
    'Total reach': t.audience,
    'Blended ROAS': t.roas,
    Impressions: t.impressions,
    'Total clicks': deliveryTotals.clicks,
    'Video views': deliveryTotals.views,
    Installs: t.installs,
    'Ad spend': t.spend,
  };
  const reportMetrics: Array<{
    label: ReportMetric;
    value: string;
    points: number[];
    color: string;
    sub?: string;
  }> = [
    {
      label: 'Active campaigns',
      value: int(activeCount),
      points: dailySeries(activeCount, TREND_CHANGES['Active campaigns'], 8),
      color: 'var(--color-pa-accent)',
    },
    {
      label: 'KOL partners',
      value: int(1284),
      points: dailySeries(1284, TREND_CHANGES['KOL partners'], 8),
      color: 'var(--color-pa-chart-1)',
    },
    {
      label: 'Total reach',
      value: compact(t.audience),
      points: dailySeries(t.audience, TREND_CHANGES['Total reach'], 8),
      color: 'var(--color-pa-chart-2)',
    },
    {
      label: 'Blended ROAS',
      value: roas(t.roas),
      points: dailySeries(t.roas, TREND_CHANGES['Blended ROAS'], 8),
      color: 'var(--color-pa-chart-3)',
      sub: 'weighted, not averaged',
    },
    {
      label: 'Impressions',
      value: compact(t.impressions),
      points: dailySeries(t.impressions, TREND_CHANGES.Impressions, 8),
      color: 'var(--color-pa-chart-1)',
    },
    {
      label: 'Total clicks',
      value: compact(deliveryTotals.clicks),
      points: dailySeries(deliveryTotals.clicks, TREND_CHANGES['Total clicks'], 8),
      color: 'var(--color-pa-chart-2)',
    },
    {
      label: 'Video views',
      value: compact(deliveryTotals.views),
      points: dailySeries(deliveryTotals.views, TREND_CHANGES['Video views'], 8),
      color: 'var(--color-pa-chart-4)',
    },
    {
      label: 'Installs',
      value: int(t.installs),
      points: dailySeries(t.installs, TREND_CHANGES.Installs, 8),
      color: 'var(--color-pa-chart-3)',
    },
    {
      label: 'Ad spend',
      value: money(t.spend),
      points: dailySeries(t.spend, TREND_CHANGES['Ad spend'], 8),
      color: 'var(--color-pa-accent)',
    },
  ];
  const days = daysBetween(range.start, range.end);
  const trendValue = metricValues[trendMetric];
  const dailyTrend = dailySeries(trendValue, TREND_CHANGES[trendMetric], days);
  const trendLabels = dateRangeLabels(range);
  const displayCount = days <= 7 ? days : 10;
  const displayTrend = sampleEvenly(dailyTrend, displayCount);
  const displayLabels = sampleEvenly(trendLabels, displayCount);

  const campaignRows: ReportRow[] = state.campaigns.map((campaign) => {
    const product = state.products.find((item) => item.id === campaign.productId);
    return {
      id: campaign.id,
      name: campaignLabel(campaign),
      subtitle: product?.name ?? 'Unassigned',
      market: campaign.market,
      kols: campaign.kols,
      spend: campaign.spend,
      impressions: campaign.impressions,
      installs: campaign.installs,
      cpi: campaign.cpi,
      roas: campaign.roas,
      product,
    };
  });
  const productRows = state.products
    .map<ReportRow | null>((product) => {
      const campaigns = state.campaigns.filter((campaign) => campaign.productId === product.id);
      if (campaigns.length === 0) return null;
      const spend = campaigns.reduce((sum, campaign) => sum + campaign.spend, 0);
      const installs = campaigns.reduce((sum, campaign) => sum + campaign.installs, 0);
      const impressions = campaigns.reduce((sum, campaign) => sum + campaign.impressions, 0);
      const revenue = campaigns.reduce((sum, campaign) => sum + campaign.spend * campaign.roas, 0);
      return {
        id: product.id,
        name: product.name,
        subtitle: product.category,
        market: 'US',
        kols: campaigns.reduce((sum, campaign) => sum + campaign.kols, 0),
        spend,
        impressions,
        installs,
        cpi: installs ? spend / installs : 0,
        roas: spend ? revenue / spend : 0,
        product,
      };
    })
    .filter((row): row is ReportRow => row !== null);
  const rows = group === 'product' ? productRows : campaignRows;
  const columns = group === 'product' ? PRODUCT_COLUMNS : CAMPAIGN_COLUMNS;

  return (
    <>
      <Eyebrow>Reports / Performance</Eyebrow>
      <PageHeader
        title="Reports"
        lede="Spend, delivery and return across every campaign in this workspace."
        actions={
          <>
            <DateRangePicker value={range} onChange={setRange} className="w-[292px] max-w-full" />
            <Button
              onClick={() => {
                setExportOpen(true);
              }}
            >
              Export
            </Button>
          </>
        }
      />

      <div
        className="-mx-pa-1 mb-pa-6 overflow-x-auto px-pa-1 pb-pa-2"
        aria-label="Reports metrics"
      >
        <div className="flex min-w-max snap-x gap-pa-3">
          {reportMetrics.map((metric) => (
            <MetricCard
              key={metric.label}
              label={metric.label}
              value={metric.value}
              sub={metric.sub}
              className="w-[244px] shrink-0 snap-start"
              trust={{ state: 'fresh', text: `fresh · ${state.lastSync}` }}
              aside={
                <Sparkline points={metric.points} color={metric.color} width={94} height={28} />
              }
            />
          ))}
        </div>
      </div>

      {/*
        ⚠️ 一次只画一个可选指标，避免把不同量纲叠在同一张双 Y 轴图上。
        数据源由 metricValues + TREND_CHANGES 配置提供，接入后端日快照时无需改图表组件。
      */}
      <Card className="mb-pa-6">
        <CardHead
          title={`${trendMetric} trend`}
          sub={`${formatDateRange(range)} · one metric at a time · hover the chart to inspect each day`}
          aside={
            <div className="flex flex-wrap items-center justify-end gap-pa-2">
              <div className="w-[154px]">
                <Dropdown
                  aria-label="Chart metric"
                  value={trendMetric}
                  onChange={(value) => setTrendMetric(value as ReportMetric)}
                  options={Object.keys(metricValues).map((metric) => ({
                    value: metric,
                    label: metric,
                  }))}
                />
              </div>
              <DataTrust state="fresh">{`fresh · ${state.lastSync}`}</DataTrust>
            </div>
          }
        />
        <div className="p-pa-4">
          <div className="flex flex-wrap items-baseline gap-[10px]">
            <b className="pa-num text-[21px] leading-[28px]">
              {formatMetric(trendMetric, trendValue)}
            </b>
            <span className="pa-num text-pa-11 text-pa-positive">
              +{(TREND_CHANGES[trendMetric] * 100).toFixed(1)}% vs previous period
            </span>
          </div>
          <div className="mt-pa-4">
            <TrendChart
              points={displayTrend}
              labels={displayLabels}
              dailyPoints={dailyTrend}
              dailyLabels={trendLabels}
              label={`${trendMetric} over ${formatDateRange(range)}`}
              color={trendColor(trendMetric)}
              valueFormatter={(value) => formatMetric(trendMetric, value)}
            />
          </div>
        </div>
      </Card>

      <div className="mb-pa-3 flex flex-wrap items-center justify-between gap-pa-3">
        <Segment
          aria-label="Group by"
          value={group}
          onChange={setGroup}
          items={[
            { value: 'campaign', label: 'By campaign' },
            { value: 'product', label: 'By product' },
          ]}
        />
        <span className="pa-num text-pa-11 text-pa-content-tertiary">
          {rows.length} {group === 'product' ? 'products' : 'campaigns'} · updated {state.lastSync}
        </span>
      </div>

      <TableCard>
        <TableScroll>
          <Table minWidth={940}>
            <TableHead columns={columns} />
            <tbody>
              {rows.map((row) => {
                return (
                  <tr key={row.id} className="hover:[&>td]:bg-pa-surface-muted">
                    <Td>
                      <span className="flex items-center gap-[10px]">
                        {row.product ? <ProductIcon product={row.product} size={26} /> : null}
                        <span className="min-w-0">
                          <b className="block truncate text-pa-15 font-bold text-pa-content">
                            {row.name}
                          </b>
                          <span className="block truncate text-pa-10 text-pa-content-tertiary">
                            {row.subtitle}
                          </span>
                        </span>
                      </span>
                    </Td>
                    <Td>{row.market}</Td>
                    <Td num>{int(row.kols)}</Td>
                    <Td num>{money(row.spend)}</Td>
                    <Td num>{compact(row.impressions)}</Td>
                    <Td num>{int(row.installs)}</Td>
                    <Td num>{cpi(row.cpi)}</Td>
                    <Td num>{roas(row.roas)}</Td>
                  </tr>
                );
              })}
            </tbody>
            {/* 合计行的 CPI 与 ROAS 是**加权混合**，不是各行取平均 */}
            <tfoot>
              <tr>
                <td className="border-t border-pa-border bg-pa-surface-muted px-pa-3 py-[14px] text-pa-12 font-bold text-pa-content">
                  Total
                </td>
                <td className="border-t border-pa-border bg-pa-surface-muted px-pa-3 py-[14px]" />
                {[
                  int(t.kols),
                  money(t.spend),
                  compact(t.impressions),
                  int(t.installs),
                  cpi(t.cpi),
                  roas(t.roas),
                ].map((value, i) => (
                  <td
                    key={i}
                    className="pa-num border-t border-pa-border bg-pa-surface-muted px-pa-3 py-[14px] text-right text-pa-12 font-bold text-pa-content"
                  >
                    {value}
                  </td>
                ))}
              </tr>
            </tfoot>
          </Table>
        </TableScroll>
      </TableCard>

      {exportOpen && (
        <Dialog
          title="Export this report"
          lede="The export matches the filters currently applied on this page."
          onClose={() => {
            setExportOpen(false);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setExportOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setExportOpen(false);
                  toast('Export is not wired up yet');
                }}
              >
                Export CSV
              </Button>
            </>
          }
        >
          <p className="text-pa-12 text-pa-content-body">
            {state.campaigns.length} campaigns · {formatDateRange(range)} · grouped by {group}.
            Dates are ISO (2026-08-23) and all times are Asia/Shanghai.
          </p>
        </Dialog>
      )}
    </>
  );
}
