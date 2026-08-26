'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  CellStack,
  Card,
  EmptyState,
  Eyebrow,
  PageHeader,
  Table,
  TableCard,
  TableHead,
  TableScroll,
  Td,
  useToast,
  usePaStore,
  type Column,
} from '@/components/pa';
import {
  Avatar,
  Button,
  Checkbox,
  DataTrust,
  Dropdown,
  PlatformIcon,
  SearchField,
  Segment,
} from '@/components/ui';
import { compact, int } from '@/lib/pa/format';
import type { Creator } from '@/lib/pa/types';

/** 粉丝量分档。用于筛选，不参与任何计费口径。 */
function sizeBucket(followers: number): string {
  if (followers >= 2_000_000) return 'mega';
  if (followers >= 1_000_000) return 'macro';
  if (followers >= 500_000) return 'mid';
  return 'micro';
}

const COLUMNS: Column[] = [
  { key: 'creator', label: 'Creator' },
  { key: 'market', label: 'Market' },
  { key: 'platforms', label: 'Platforms' },
  { key: 'tags', label: 'Categories' },
  { key: 'auth', label: 'Authorization' },
  { key: 'followers', label: 'Followers', num: true },
  { key: 'eng', label: 'Engagement', num: true },
  { key: 'views', label: 'Avg. views', num: true },
];

export default function KolNetworkPage(): ReactNode {
  const { state } = usePaStore();
  const toast = useToast();
  const [view, setView] = useState('grid');
  const [size, setSize] = useState('all');
  const [market, setMarket] = useState('all');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [gridColumns, setGridColumns] = useState(2);
  const [gridVisibleCount, setGridVisibleCount] = useState(6);
  const loadLockRef = useRef(false);

  useEffect(() => {
    const updateColumns = () => {
      // The grid uses a 248px minimum card plus a 12px gap. Keep each batch
      // at exactly three visible rows at the current responsive breakpoint.
      setGridColumns(Math.max(1, Math.floor((window.innerWidth - 260) / 260)));
    };
    updateColumns();
    window.addEventListener('resize', updateColumns);
    return () => window.removeEventListener('resize', updateColumns);
  }, []);

  const markets = [...new Set(state.creators.map((c) => c.market))];

  const rows = state.creators.filter((c) => {
    if (size !== 'all' && sizeBucket(c.followers) !== size) return false;
    if (market !== 'all' && c.market !== market) return false;
    if (
      query &&
      !`${c.name} ${c.handle} ${c.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase())
    )
      return false;
    return true;
  });

  const gridBatchSize = gridColumns * 3;

  useEffect(() => {
    loadLockRef.current = false;
    setGridVisibleCount(gridBatchSize);
  }, [gridBatchSize, size, market, query]);

  useEffect(() => {
    if (view !== 'grid' || gridVisibleCount >= rows.length) return;
    const loadOnScroll = () => {
      const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 140;
      if (!nearBottom || window.scrollY <= 0 || loadLockRef.current) return;
      loadLockRef.current = true;
      setGridVisibleCount((current) => Math.min(rows.length, current + gridBatchSize));
      window.setTimeout(() => {
        loadLockRef.current = false;
      }, 350);
    };
    window.addEventListener('scroll', loadOnScroll, { passive: true });
    return () => window.removeEventListener('scroll', loadOnScroll);
  }, [view, rows.length, gridVisibleCount, gridBatchSize]);

  function toggle(id: string, on: boolean): void {
    setPicked((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));
  }

  return (
    <>
      <Eyebrow>Network / Partners</Eyebrow>
      <PageHeader
        title="KOL Network"
        badge={
          <span className="pa-num inline-flex h-[22px] items-center rounded-pa-full bg-pa-surface-muted px-[10px] text-pa-11 text-pa-content-body">
            {int(1284)} creators
          </span>
        }
        lede="Every authorized creator account available to this workspace."
        actions={
          <Button
            onClick={() => {
              toast('Creator invites are not wired up yet');
            }}
          >
            Invite creators
          </Button>
        }
      />

      <div className="mb-pa-4 flex flex-wrap items-center justify-between gap-pa-3">
        <div className="flex flex-wrap gap-pa-3">
          <Segment
            aria-label="View"
            value={view}
            onChange={setView}
            items={[
              { value: 'grid', label: 'Grid' },
              { value: 'table', label: 'Table' },
            ]}
          />
          <div className="w-[160px]">
            <Dropdown
              aria-label="Audience size"
              value={size}
              onChange={setSize}
              options={[
                { value: 'all', label: 'All sizes' },
                { value: 'mega', label: 'Mega · 2M+' },
                { value: 'macro', label: 'Macro · 1M+' },
                { value: 'mid', label: 'Mid · 500K+' },
                { value: 'micro', label: 'Micro' },
              ]}
            />
          </div>
          <div className="w-[160px]">
            <Dropdown
              aria-label="Market"
              value={market}
              onChange={setMarket}
              options={[
                { value: 'all', label: 'All markets' },
                ...markets.map((m) => ({ value: m, label: m })),
              ]}
            />
          </div>
        </div>
        <div className="w-[240px]">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search name, handle or category"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="No creators match these filters"
            description="Try a wider audience size or a different market."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setSize('all');
                  setMarket('all');
                  setQuery('');
                }}
              >
                Clear all filters
              </Button>
            }
          />
        </Card>
      ) : view === 'grid' ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-pa-3">
            {rows.slice(0, gridVisibleCount).map((creator) => (
            <GridCard
              key={creator.id}
              creator={creator}
              checked={picked.includes(creator.id)}
              onToggle={(on) => {
                toggle(creator.id, on);
              }}
            />
            ))}
          </div>
          {gridVisibleCount < rows.length ? (
            <div className="py-pa-6 text-center text-pa-11 text-pa-content-tertiary">
              Scroll for more creators
            </div>
          ) : null}
        </>
      ) : (
        <TableCard>
          <TableScroll>
            <Table minWidth={980}>
              <TableHead columns={COLUMNS} />
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    className="last:[&>td]:border-b-0 hover:[&>td]:bg-pa-surface-muted"
                  >
                    <Td>
                      <Link href={`/pa/kols/${c.id}`} className="hover:underline">
                        <CellStack
                          media={<Avatar name={c.name} src={c.avatar} hue={c.hue} size="s" />}
                          title={c.name}
                          sub={c.handle}
                        />
                      </Link>
                    </Td>
                    <Td>{c.market}</Td>
                    <Td>
                      <span className="flex gap-pa-1">
                        {c.platforms.map((p) => (
                          <PlatformIcon key={p} platform={p} small />
                        ))}
                      </span>
                    </Td>
                    <Td>{c.tags.join(' · ')}</Td>
                    <Td>
                      {/* 授权状态是 KOL 的属性，不是每条广告的属性 —— 作为徽章挂在这里 */}
                      <DataTrust state={c.authorized ? 'fresh' : 'partial'}>
                        {c.authorized ? 'Authorized' : 'Not authorized'}
                      </DataTrust>
                    </Td>
                    <Td num>{compact(c.followers)}</Td>
                    <Td num>{c.eng.toFixed(1)}%</Td>
                    <Td num>{compact(c.avgViews)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </TableCard>
      )}

      {/* 批量选择底部浮条：选人 → 加进 campaign 的链路闭合 */}
      {picked.length > 0 && (
        <div className="sticky bottom-pa-5 z-30 mt-pa-4 flex flex-wrap items-center justify-between gap-pa-3 rounded-pa-lg border border-pa-border bg-pa-surface px-pa-4 py-pa-3 shadow-pa-2">
          <span className="pa-num text-pa-12">
            {picked.length} creator{picked.length === 1 ? '' : 's'} selected
          </span>
          <div className="flex gap-pa-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPicked([]);
              }}
            >
              Clear
            </Button>
            <Button
              size="sm"
              onClick={() => {
                toast(`Open a campaign to add these ${String(picked.length)} creators`);
              }}
            >
              Add to campaign
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function GridCard({
  creator,
  checked,
  onToggle,
}: {
  creator: Creator;
  checked: boolean;
  onToggle: (on: boolean) => void;
}): ReactNode {
  return (
    <div className="group overflow-hidden rounded-pa-lg border border-pa-border bg-pa-surface hover:border-pa-border-strong hover:shadow-pa-1">
      <div className="flex items-center gap-[10px] p-[14px]">
        <Checkbox checked={checked} onChange={onToggle} className="min-h-0" />
        <Avatar name={creator.name} src={creator.avatar} hue={creator.hue} size="m" />
        <Link href={`/pa/kols/${creator.id}`} className="min-w-0 flex-1 hover:underline">
          <b className="block truncate text-pa-13">{creator.name}</b>
          <span className="block truncate font-pa-mono text-pa-11 text-pa-content-tertiary">
            {creator.handle}
          </span>
        </Link>
        <span className="flex shrink-0 gap-pa-1">
          {creator.platforms.map((p) => (
            <PlatformIcon key={p} platform={p} small />
          ))}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-[2px]">
        {[0, 1, 2].map((i) => {
          const cover = creator.videoCovers?.[i];
          return cover === undefined ? (
            <div key={i} className="aspect-[3/4] bg-pa-surface-muted" />
          ) : (
            <div key={cover} className="aspect-[3/4] overflow-hidden bg-pa-surface-muted">
              <img
                src={cover}
                alt={`${creator.name} video cover ${String(i + 1)}`}
                loading="lazy"
                className="h-full w-full object-cover transition-transform duration-[220ms] ease-out group-hover:scale-[1.04]"
              />
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-pa-2 px-[14px] py-pa-3">
        {[
          ['Followers', compact(creator.followers)],
          ['Engagement', `${creator.eng.toFixed(1)}%`],
          ['Avg. views', compact(creator.avgViews)],
        ].map(([label, value]) => (
          <div key={label}>
            <b className="pa-num text-pa-14 font-bold">{value}</b>
            <span className="mt-[3px] block font-pa-mono text-pa-8 uppercase tracking-[0.1em] text-pa-content-tertiary">
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
