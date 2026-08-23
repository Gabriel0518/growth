'use client';

import { useState, type ReactNode } from 'react';

import {
  AreaChart,
  Card,
  CardHead,
  Dialog,
  Eyebrow,
  PageHeader,
  ProductIcon,
  Table,
  TableCard,
  TableHead,
  TableScroll,
  Td,
  useToast,
  usePaStore,
  type Column,
} from '@/components/pa';
import { Button, DataTrust, Dropdown, MetricCard, Segment } from '@/components/ui';
import { totals } from '@/lib/pa/derive';
import { campaignLabel, compact, cpi, int, money, roas } from '@/lib/pa/format';

/** 每日消耗序列。接后端后由 DemoOverview.trend 提供。 */
const DAILY_SPEND = [
  18_400, 19_100, 21_600, 20_300, 22_800, 24_100, 23_400, 25_900, 27_200, 26_400, 28_800, 30_100,
  29_500, 31_200,
];

const COLUMNS: Column[] = [
  { key: 'name', label: 'Campaign / Product' },
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
  const [range, setRange] = useState('30D');
  const [group, setGroup] = useState('campaign');
  const [exportOpen, setExportOpen] = useState(false);

  const t = totals(state);

  return (
    <>
      <Eyebrow>Reports / Performance</Eyebrow>
      <PageHeader
        title="Reports"
        lede="Spend, delivery and return across every campaign in this workspace."
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

      <div className="mb-pa-4 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-pa-3">
        <MetricCard
          label="Spend"
          value={money(t.spend)}
          trust={{ state: 'fresh', text: `fresh · ${state.lastSync}` }}
        />
        <MetricCard
          label="Impressions"
          value={compact(t.impressions)}
          trust={{ state: 'fresh', text: `fresh · ${state.lastSync}` }}
        />
        <MetricCard
          label="Installs"
          value={int(t.installs)}
          trust={{ state: 'fresh', text: `fresh · ${state.lastSync}` }}
        />
        <MetricCard label="Blended CPI" value={cpi(t.cpi)} sub="weighted, not averaged" />
        <MetricCard label="Blended ROAS" value={roas(t.roas)} sub="weighted, not averaged" />
      </div>

      {/*
        ⚠️ 只画消耗一条线，ROAS 放进下面的表格。
        双 Y 轴是明令禁止的：消耗和 ROAS 量纲不同，叠在一张图上会制造并不存在的相关性
        （DESIGN-SPEC / CLAUDE.md B4.4）。
      */}
      <Card className="mb-pa-4">
        <CardHead
          title="Daily spend"
          sub="One axis only — ROAS is reported in the table below, not on this chart"
          aside={<DataTrust state="fresh">{`fresh · ${state.lastSync}`}</DataTrust>}
        />
        <div className="p-pa-4">
          <AreaChart points={DAILY_SPEND} label="Daily spend" color="var(--color-pa-chart-1)" />
          <div className="mt-pa-2 flex justify-between font-pa-mono text-pa-11 text-pa-content-tertiary">
            {['Aug 05', 'Aug 09', 'Aug 13', 'Aug 17'].map((d) => (
              <span key={d}>{d}</span>
            ))}
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
          {state.campaigns.length} campaigns · updated {state.lastSync}
        </span>
      </div>

      <TableCard>
        <TableScroll>
          <Table minWidth={940}>
            <TableHead columns={COLUMNS} />
            <tbody>
              {state.campaigns.map((c) => {
                const product = state.products.find((p) => p.id === c.productId);
                return (
                  <tr key={c.id} className="hover:[&>td]:bg-pa-surface-muted">
                    <Td>
                      <span className="flex items-center gap-[10px]">
                        {product ? <ProductIcon product={product} size={26} /> : null}
                        <span className="min-w-0">
                          <b className="block truncate text-pa-12 text-pa-content">
                            {campaignLabel(c)}
                          </b>
                          <span className="block truncate text-pa-10 text-pa-content-tertiary">
                            {product?.name}
                          </span>
                        </span>
                      </span>
                    </Td>
                    <Td>{c.market}</Td>
                    <Td num>{int(c.kols)}</Td>
                    <Td num>{money(c.spend)}</Td>
                    <Td num>{compact(c.impressions)}</Td>
                    <Td num>{int(c.installs)}</Td>
                    <Td num>{cpi(c.cpi)}</Td>
                    <Td num>{roas(c.roas)}</Td>
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
            {state.campaigns.length} campaigns · {range} · grouped by {group}. Dates are ISO
            (2026-08-23) and all times are Asia/Shanghai.
          </p>
        </Dialog>
      )}
    </>
  );
}
