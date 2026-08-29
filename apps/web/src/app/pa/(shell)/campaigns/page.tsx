'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';

import {
  CellStack,
  EmptyState,
  Eyebrow,
  PageHeader,
  ProductIcon,
  Table,
  TableCard,
  TableHead,
  TableScroll,
  Td,
  usePaStore,
  type Column,
} from '@/components/pa';
import {
  Button,
  buttonClasses,
  Dropdown,
  MetricCard,
  PlatformIcon,
  SearchField,
  StatusPill,
} from '@/components/ui';
import { activeCampaigns, totals } from '@/lib/pa/derive';
import { campaignLabel, compact, dash, int, money, moneyK, pacing, roas } from '@/lib/pa/format';
import { STATUS_LABEL, STATUS_TONE_OF } from '@/lib/pa/status';
import type { CampaignStatus } from '@/lib/pa/types';

const PAGE_SIZE = 8;

/** 状态列 130px：`Needs review` 比中文的「审核中」宽得多，按最长英文串定宽（CLAUDE.md C2.6）。 */
const COLUMNS: Column[] = [
  { key: 'campaign', label: 'Campaign / Product' },
  { key: 'channels', label: 'Channels' },
  { key: 'owner', label: 'Owner / Market' },
  { key: 'status', label: 'Status' },
  { key: 'kols', label: 'KOLs', num: true },
  { key: 'impressions', label: 'Impressions', num: true },
  { key: 'spend', label: 'Spend', num: true },
  { key: 'roas', label: 'ROAS', num: true },
];

export default function CampaignsPage(): ReactNode {
  const { state } = usePaStore();
  const router = useRouter();
  const [status, setStatus] = useState('all');
  const [owner, setOwner] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const owners = useMemo(
    () => [...new Set(state.campaigns.map((c) => c.owner))],
    [state.campaigns],
  );

  const rows = state.campaigns.filter((c) => {
    if (status !== 'all' && c.status !== (status as CampaignStatus)) return false;
    if (owner !== 'all' && c.owner !== owner) return false;
    if (query) {
      const product = state.products.find((p) => p.id === c.productId);
      const hay = `${c.name} ${c.market} ${c.id} ${c.owner} ${product?.name ?? ''}`.toLowerCase();
      if (!hay.includes(query.toLowerCase())) return false;
    }
    return true;
  });

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);

  const t = totals(state);
  const active = activeCampaigns(state.campaigns).length;
  const review = state.campaigns.filter((c) => c.status === 'review').length;

  function clearFilters(): void {
    setStatus('all');
    setOwner('all');
    setQuery('');
    setPage(0);
  }

  return (
    <>
      <Eyebrow>Campaigns / Workspace</Eyebrow>
      <PageHeader
        title="Campaigns"
        lede="Plan, monitor and review every cross-platform activation."
        actions={
          <Link href="/pa/campaigns/new" className={buttonClasses()}>
            Create campaign
          </Link>
        }
      />

      <div className="mb-pa-4 grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-pa-3">
        <MetricCard label="Active campaigns" value={int(active)} sub="+4 this month" />
        <MetricCard label="Total spend" value={moneyK(t.spend)} sub="+18.2%" />
        <MetricCard label="Avg. ROAS" value={roas(t.roas)} sub="+0.46 vs prior" />
        <MetricCard label="Needs review" value={int(review)} sub="2 due today" />
      </div>

      <div className="mb-[10px] flex flex-wrap items-center justify-between gap-pa-3">
        <div className="flex flex-wrap gap-pa-3">
          <div className="w-[176px]">
            <Dropdown
              aria-label="Status"
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(0);
              }}
              options={[
                { value: 'all', label: 'All statuses' },
                { value: 'running', label: 'Live' },
                { value: 'review', label: 'Needs review' },
                { value: 'draft', label: 'Draft' },
                { value: 'automating', label: 'Automating' },
                { value: 'stopped', label: 'Stopped' },
              ]}
            />
          </div>
          <div className="w-[176px]">
            <Dropdown
              aria-label="Owner"
              value={owner}
              onChange={(v) => {
                setOwner(v);
                setPage(0);
              }}
              options={[
                { value: 'all', label: 'All owners' },
                ...owners.map((o) => ({ value: o, label: o })),
              ]}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-pa-3">
          <span className="pa-num text-pa-11 text-pa-content-tertiary">
            Updated {state.lastSync}
          </span>
          <div className="w-[240px]">
            <SearchField
              value={query}
              onChange={(v) => {
                setQuery(v);
                setPage(0);
              }}
              placeholder="Filter by owner, product or tag"
            />
          </div>
        </div>
      </div>

      <TableCard>
        {visible.length > 0 ? (
          <TableScroll>
            <Table>
              <TableHead columns={COLUMNS} />
              <tbody>
                {visible.map((c) => {
                  const product = state.products.find((p) => p.id === c.productId);
                  const go = (): void => {
                    router.push(`/pa/campaigns/${c.id}`);
                  };
                  return (
                    <tr
                      key={c.id}
                      tabIndex={0}
                      onClick={go}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          go();
                        }
                      }}
                      className="cursor-pointer last:[&>td]:border-b-0 hover:[&>td]:bg-pa-surface-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-pa-ring"
                    >
                      <Td>
                        <CellStack
                          media={product ? <ProductIcon product={product} size={26} /> : undefined}
                          title={campaignLabel(c)}
                          sub={product ? `${product.name} · ${product.objective}` : undefined}
                        />
                      </Td>
                      <Td>
                        <span className="flex gap-pa-1">
                          {c.channels.map((ch) => (
                            <PlatformIcon key={ch} platform={ch} small />
                          ))}
                        </span>
                      </Td>
                      <Td>
                        {c.owner} / {c.market}
                      </Td>
                      <Td className="w-[130px]">
                        <StatusPill tone={STATUS_TONE_OF(c.status)}>
                          {STATUS_LABEL[c.status]}
                        </StatusPill>
                      </Td>
                      <Td num>{int(c.kols)}</Td>
                      <Td num>{dash(c.impressions || null, compact)}</Td>
                      <Td num>
                        {money(c.spend)}
                        <span className="mt-px block font-pa-mono text-pa-9 text-pa-content-tertiary">
                          {pacing(c)}% of {money(c.cap)}
                        </span>
                      </Td>
                      <Td num>{dash(c.roas || null, roas)}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableScroll>
        ) : (
          <EmptyState
            title="No campaigns match these filters"
            description="Try a different status or owner, or clear the search term."
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear all filters
              </Button>
            }
          />
        )}
      </TableCard>

      <div className="flex items-center justify-between px-pa-1 pt-pa-4 text-pa-12 text-pa-content-tertiary">
        <span>
          Showing {visible.length} of {rows.length} campaigns
        </span>
        <div className="flex items-center gap-[10px]">
          <span className="pa-num">
            {current + 1} / {pageCount}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={current === 0}
            onClick={() => {
              setPage(current - 1);
            }}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={current >= pageCount - 1}
            onClick={() => {
              setPage(current + 1);
            }}
          >
            Next
          </Button>
        </div>
      </div>
    </>
  );
}
