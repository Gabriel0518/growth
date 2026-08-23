'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  Card,
  CardHead,
  EmptyState,
  Eyebrow,
  PageHeader,
  Track,
  usePaStore,
} from '@/components/pa';
import {
  Avatar,
  buttonClasses,
  DataTrust,
  MetricCard,
  PlatformIcon,
  StatusPill,
} from '@/components/ui';
import { campaignLabel, compact, int, roas } from '@/lib/pa/format';

/** 受众构成。真实数据未接入，接后端后由创作者档案提供。 */
const AUDIENCE = [
  {
    title: 'Age',
    rows: [
      ['18–24', 42],
      ['25–34', 35],
      ['35–44', 15],
      ['45+', 8],
    ] as [string, number][],
  },
  {
    title: 'Gender',
    rows: [
      ['Female', 68],
      ['Male', 32],
    ] as [string, number][],
  },
  {
    title: 'Top markets',
    rows: [
      ['United States', 54],
      ['Canada', 12],
      ['United Kingdom', 9],
    ] as [string, number][],
  },
];

export default function CreatorProfilePage(): ReactNode {
  const params = useParams<{ id: string }>();
  const { state } = usePaStore();
  const creator = state.creators.find((c) => c.id === params.id);

  if (!creator) {
    return (
      <Card>
        <EmptyState
          title="That creator isn't in this network"
          description={`No creator with id ${params.id}. They may have left the roster.`}
          action={
            <Link href="/pa/kols" className={buttonClasses()}>
              Back to KOL Network
            </Link>
          }
        />
      </Card>
    );
  }

  const history = state.history.filter((h) => h.creatorId === creator.id);
  const live = state.delivery.filter((d) => d.creatorId === creator.id);

  return (
    <>
      <Eyebrow>Network / Creator</Eyebrow>
      <PageHeader
        title={creator.name}
        badge={
          <StatusPill tone={creator.authorized ? 'positive' : 'neutral'}>
            {creator.authorized ? 'Authorized' : 'Not authorized'}
          </StatusPill>
        }
        lede={`${creator.handle} · ${creator.market} · joined ${creator.joined}`}
        actions={
          <Link href="/pa/kols" className={buttonClasses('secondary')}>
            Back to network
          </Link>
        }
      />

      <Card padded className="mb-pa-4">
        <div className="flex flex-wrap items-center gap-pa-4">
          <Avatar name={creator.name} hue={creator.hue} size="l" />
          <div className="min-w-0 flex-1">
            <b className="text-pa-17">{creator.name}</b>
            <div className="font-pa-mono text-pa-12 text-pa-content-tertiary">{creator.handle}</div>
            <div className="mt-pa-2 flex flex-wrap items-center gap-pa-2">
              {creator.platforms.map((p) => (
                <PlatformIcon key={p} platform={p} />
              ))}
              {creator.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex h-[22px] items-center rounded-pa-full bg-pa-surface-muted px-[10px] text-pa-11 text-pa-content-body"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
          {/* 账号级授权是 KOL 的属性，不进单条广告的状态链（CAMPAIGN-LIVE.md） */}
          <DataTrust state={creator.authorized ? 'fresh' : 'partial'}>
            {creator.authorized ? 'Partnership + Spark authorized' : 'Spark not authorized'}
          </DataTrust>
        </div>
      </Card>

      <div className="mb-pa-4 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-pa-3">
        <MetricCard label="Followers" value={compact(creator.followers)} />
        <MetricCard label="Engagement rate" value={`${creator.eng.toFixed(1)}%`} />
        <MetricCard label="Avg. views" value={compact(creator.avgViews)} />
        <MetricCard label="Cost per engagement" value={`$${creator.cpe.toFixed(2)}`} />
      </div>

      <div className="grid gap-pa-3 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHead title="Campaign history" sub="Work delivered for this workspace" />
          {history.length === 0 && live.length === 0 ? (
            <EmptyState
              title="No campaigns yet"
              description="This creator hasn't delivered for your workspace."
            />
          ) : (
            <div className="p-pa-4">
              {live.map((d) => {
                const campaign = state.campaigns.find((c) => c.id === d.campaignId);
                if (!campaign) return null;
                return (
                  <div
                    key={d.campaignId}
                    className="flex flex-wrap items-center justify-between gap-pa-3 border-b border-pa-border-subtle py-pa-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <Link href={`/pa/campaigns/${campaign.id}`} className="hover:underline">
                        <b className="block truncate text-pa-13">{campaignLabel(campaign)}</b>
                      </Link>
                      <span className="pa-num text-pa-11 text-pa-content-tertiary">
                        {compact(d.impressions)} impressions · {compact(d.clicks)} clicks
                      </span>
                    </div>
                    <div className="flex items-center gap-pa-4">
                      <span className="text-right">
                        <span className="block text-pa-9 text-pa-content-tertiary">ROAS</span>
                        <b className="pa-num block text-pa-13">{roas(d.roas)}</b>
                      </span>
                      <StatusPill
                        tone={
                          d.state === 'live'
                            ? 'positive'
                            : d.state === 'rejected'
                              ? 'negative'
                              : 'neutral'
                        }
                      >
                        {d.state === 'live'
                          ? 'Live'
                          : d.state === 'rejected'
                            ? 'Ad rejected'
                            : 'Preparing'}
                      </StatusPill>
                    </div>
                  </div>
                );
              })}
              {history.map((h) => {
                const campaign = state.campaigns.find((c) => c.id === h.campaignId);
                return (
                  <div
                    key={`${h.campaignId}-${h.when}`}
                    className="flex flex-wrap items-center justify-between gap-pa-3 border-b border-pa-border-subtle py-pa-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <b className="block truncate text-pa-13">
                        {campaign ? campaignLabel(campaign) : h.campaignId}
                      </b>
                      <span className="pa-num text-pa-11 text-pa-content-tertiary">
                        {h.when} · {int(h.installs)} installs
                      </span>
                    </div>
                    <div className="flex items-center gap-pa-4">
                      <span className="text-right">
                        <span className="block text-pa-9 text-pa-content-tertiary">ROAS</span>
                        <b className="pa-num block text-pa-13">{roas(h.roas)}</b>
                      </span>
                      <StatusPill tone={h.live ? 'positive' : 'neutral'}>
                        {h.live ? 'Live' : 'Ended'}
                      </StatusPill>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <CardHead
            title="Audience"
            aside={<DataTrust state="partial">estimate · platform-reported</DataTrust>}
          />
          <div className="grid gap-pa-5 p-pa-4">
            {AUDIENCE.map((block) => (
              <div key={block.title}>
                <div className="font-pa-mono text-pa-9 uppercase tracking-[0.1em] text-pa-content-tertiary">
                  {block.title}
                </div>
                <div className="mt-pa-2">
                  {block.rows.map(([label, pct]) => (
                    <div key={label} className="py-[6px]">
                      <div className="flex items-center justify-between text-pa-12">
                        <span>{label}</span>
                        <b className="pa-num text-pa-11">{pct}%</b>
                      </div>
                      <Track value={pct} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
