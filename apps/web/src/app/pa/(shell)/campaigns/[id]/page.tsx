'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  Banner,
  Card,
  CardHead,
  DeltaList,
  Dialog,
  Drawer,
  EmptyState,
  Eyebrow,
  LogRow,
  PageHeader,
  ProductIcon,
  Track,
  useToast,
  usePaStore,
  WorkRow,
} from '@/components/pa';
import {
  Avatar,
  Button,
  buttonClasses,
  Checkbox,
  DataTrust,
  PlatformIcon,
  StatusPill,
} from '@/components/ui';
import { campaignLabel, compact, cpi, int, money, moneyK, pacing, roas } from '@/lib/pa/format';
import { STATUS_LABEL, STATUS_TONE_OF } from '@/lib/pa/status';
import type { CampaignStatus } from '@/lib/pa/types';

/** 每个状态的眉标与导语。用户是**监督者**不是操作者，导语要回答「现在该关心什么」。 */
const COPY: Record<CampaignStatus, { eyebrow: string; lede: string }> = {
  running: {
    eyebrow: 'Campaign · Running',
    lede: 'Ads are delivering from creator accounts. Spend is billed to your ad account.',
  },
  automating: {
    eyebrow: 'Campaign · Automating',
    lede: 'Matching, creative and ad build run on their own. Step in only when something fails.',
  },
  ready: {
    eyebrow: 'Campaign · Ready to publish',
    lede: 'Everything is prepared. Publishing starts delivery and begins spending.',
  },
  stopped: {
    eyebrow: 'Campaign · Stopped',
    lede: 'Delivery has ended. Creator posts stay on their accounts unless you remove them.',
  },
  review: {
    eyebrow: 'Campaign · Needs review',
    lede: 'Something needs a decision before this campaign can keep delivering.',
  },
  draft: {
    eyebrow: 'Campaign · Draft',
    lede: 'This campaign has not been published. Nothing is spending yet.',
  },
};

export default function CampaignDetailPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const { state, dispatch } = usePaStore();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'pause' | 'resume' | 'publish' | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [workPage, setWorkPage] = useState(0);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const WORK_PAGE_SIZE = 20;

  const campaign = state.campaigns.find((c) => c.id === params.id);
  const product = state.products.find((p) => p.id === campaign?.productId);

  useEffect(() => {
    if (!campaign || campaign.status !== 'running') return;

    const run = () => {
      dispatch({ type: 'advanceAutomation', campaignId: campaign.id });
    };
    const initial = window.setTimeout(run, 650);
    const timer = window.setInterval(run, 2200);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [campaign?.id, campaign?.status, dispatch]);

  const work = useMemo(() => {
    if (!campaign) return [];
    return state.delivery
      .filter((d) => d.campaignId === campaign.id)
      .sort((a, b) => (b.matchedAt ?? -1) - (a.matchedAt ?? -1));
  }, [state.delivery, campaign]);

  const pageCount = Math.max(1, Math.ceil(work.length / WORK_PAGE_SIZE));
  const visibleWork = work.slice(workPage * WORK_PAGE_SIZE, (workPage + 1) * WORK_PAGE_SIZE);

  useEffect(() => {
    setWorkPage((page) => Math.min(page, pageCount - 1));
  }, [pageCount]);

  if (!campaign || !product) {
    return (
      <Card>
        <EmptyState
          title="That campaign isn't in this workspace"
          description={`No campaign with id ${params.id}. It may have been removed.`}
          action={
            <Link href="/pa/campaigns" className={buttonClasses()}>
              Back to Campaigns
            </Link>
          }
        />
      </Card>
    );
  }

  const copy = COPY[campaign.status];
  const pace = pacing(campaign);
  const rejected = work.filter((w) => w.state === 'rejected');
  const live = campaign.status === 'running';
  const building = campaign.status === 'automating' || campaign.status === 'ready';
  const campaignAssets = state.assets.filter((asset) => asset.campaignId === campaign.id);
  const generatingAssets = campaignAssets.filter((asset) => asset.status === 'generating');
  const clearedAssets = campaignAssets.filter(
    (asset) => asset.status === 'ready' && asset.origin === 'ai',
  );
  const log = state.automationLog.filter(
    (l) => l.campaignId === undefined || l.campaignId === campaign.id,
  );

  /**
   * 顶部状态带：前两个状态显示**构建进度**，后两个显示**投放结果** ——
   * 不同阶段问的问题不一样，不套同一个模板（CAMPAIGN-LIVE.md）。
   */
  const stages = campaign.isNew
    ? [
        {
          label: 'Matched',
          value: int(campaign.kols),
          sub: `${int(campaign.targetKols ?? campaign.kols)} target creators`,
          pct: Math.min(
            100,
            (campaign.kols / Math.max(1, campaign.targetKols ?? campaign.kols)) * 100,
          ),
        },
        {
          label: 'Creative',
          value: int(campaignAssets.length),
          sub: `${generatingAssets.length} rendering automatically`,
          pct: Math.min(100, (campaignAssets.length / Math.max(1, campaign.kols)) * 100),
        },
        {
          label: 'Approved',
          value: int(clearedAssets.length),
          sub: 'videos auto-cleared',
          pct: Math.min(100, (clearedAssets.length / Math.max(1, campaign.kols)) * 100),
        },
        {
          label: 'Live',
          value: int(campaign.delivering),
          sub: 'creator posts delivering',
          pct: Math.min(100, (campaign.delivering / Math.max(1, campaign.kols)) * 100),
        },
      ]
    : building
      ? [
          { label: 'Matched', value: int(campaign.kols), sub: 'creators accepted', pct: 100 },
          {
            label: 'Creative',
            value: int(Math.round(campaign.kols * 0.7)),
            sub: 'variants rendered',
            pct: campaign.status === 'ready' ? 100 : 62,
          },
          {
            label: 'Ads built',
            value: int(Math.round(campaign.kols * 0.5)),
            sub: `on ${state.adAccounts[0]?.id ?? ''}`,
            pct: campaign.status === 'ready' ? 100 : 34,
          },
          {
            label: 'Live',
            value: campaign.status === 'ready' ? '0' : '—',
            sub: campaign.status === 'ready' ? 'waiting to publish' : 'not started',
            pct: 0,
          },
        ]
      : [
          {
            label: 'Spend',
            value: money(campaign.spend),
            sub: `${String(pace)}% of ${money(campaign.cap)}`,
            pct: pace,
          },
          {
            label: 'Impressions',
            value: compact(campaign.impressions),
            sub: 'of 15.0M target',
            pct: Math.min(100, (campaign.impressions / 15_000_000) * 100),
          },
          {
            label: 'Installs',
            value: int(campaign.installs),
            sub: `${cpi(campaign.cpi)} blended CPI`,
            pct: 72,
          },
          {
            label: 'ROAS',
            value: roas(campaign.roas),
            sub: 'target 4.80×',
            pct: Math.min(100, (campaign.roas / 4.8) * 100),
          },
        ];

  const pool = state.creators.filter((c) => !work.some((w) => w.creatorId === c.id));
  const selectedDelivery =
    selectedCreatorId === null
      ? undefined
      : work.find((item) => item.creatorId === selectedCreatorId);
  const selectedCreator =
    selectedCreatorId === null
      ? undefined
      : state.creators.find((item) => item.id === selectedCreatorId);
  const selectedAsset =
    selectedCreatorId === null
      ? undefined
      : campaignAssets.find(
          (asset) => asset.creatorId === selectedCreatorId && asset.origin === 'ai',
        );

  return (
    <>
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <PageHeader
        title={campaignLabel(campaign)}
        lede={copy.lede}
        badge={
          <StatusPill
            tone={STATUS_TONE_OF(campaign.status)}
            {...(live ? { className: 'pa-live-pulse' } : {})}
          >
            {STATUS_LABEL[campaign.status]}
          </StatusPill>
        }
        actions={
          live ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirm('pause');
                }}
              >
                Pause campaign
              </Button>
              <Button
                onClick={() => {
                  setAddOpen(true);
                }}
              >
                Add creators
              </Button>
            </>
          ) : campaign.status === 'stopped' ? (
            <>
              <Link href="/pa/reports" className={buttonClasses('secondary')}>
                View report
              </Link>
              <Button
                onClick={() => {
                  setConfirm('resume');
                }}
              >
                Resume campaign
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" disabled={campaign.status === 'automating'}>
                Pause
              </Button>
              {/* Publish 是最终人工确认 —— 不可逆的花钱动作必须有人点，
                  这也是这个按钮存在的唯一理由（CAMPAIGN-LIVE.md）。 */}
              <Button
                disabled={campaign.status === 'automating'}
                onClick={() => {
                  setConfirm('publish');
                }}
              >
                Publish
              </Button>
            </>
          )
        }
      />

      <Card padded className="mb-pa-4">
        <div className="grid gap-pa-6 xl:grid-cols-[minmax(280px,1.05fr)_minmax(0,1.95fr)]">
          <div className="min-w-0">
            <Eyebrow className="font-semibold text-pa-accent">Product</Eyebrow>
            <div className="mt-pa-3 flex min-w-0 items-center gap-pa-4">
              <ProductIcon product={product} size={64} className="shadow-pa-1" />
              <div className="min-w-0">
                <h2 className="text-pa-20 font-semibold leading-tight text-pa-content">
                  {product.name}
                </h2>
                <p className="mt-pa-1 text-pa-12 leading-4 text-pa-content-secondary">
                  {product.category} <span className="text-pa-content-placeholder">·</span>{' '}
                  {product.platforms}
                </p>
                <p className="pa-num mt-pa-1 truncate text-pa-11 text-pa-accent">{product.store}</p>
              </div>
            </div>
          </div>

          <div className="border-t border-pa-border-subtle pt-pa-5 xl:border-l xl:border-t-0 xl:pl-pa-6 xl:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-pa-3 gap-y-pa-1">
              <h2 className="text-pa-17 font-bold text-pa-content">Campaign setup</h2>
              <span className="text-pa-11 text-pa-content-tertiary">Live configuration</span>
            </div>
            <div className="mt-pa-4 grid grid-cols-2 gap-x-pa-6 gap-y-pa-5 lg:grid-cols-4">
              <div className="min-w-0">
                <div className="font-pa-mono text-pa-10 font-semibold uppercase tracking-[0.12em] text-pa-content-secondary">
                  Objective
                </div>
                <div className="mt-pa-2 text-pa-15 font-semibold text-pa-content">
                  {product.objective}
                </div>
              </div>
              <div className="min-w-0">
                <div className="font-pa-mono text-pa-10 font-semibold uppercase tracking-[0.12em] text-pa-content-secondary">
                  Market
                </div>
                <div className="mt-pa-2 text-pa-15 font-semibold text-pa-content">
                  {campaign.market}
                </div>
              </div>
              <div className="min-w-0">
                <div className="font-pa-mono text-pa-10 font-semibold uppercase tracking-[0.12em] text-pa-content-secondary">
                  Spent / cap
                </div>
                <div className="pa-num mt-pa-2 whitespace-nowrap text-pa-15 font-semibold text-pa-content">
                  {moneyK(campaign.spend)} / {moneyK(campaign.cap)}
                </div>
              </div>
              <div className="min-w-0">
                <div className="font-pa-mono text-pa-10 font-semibold uppercase tracking-[0.12em] text-pa-content-secondary">
                  Schedule
                </div>
                <div className="pa-num mt-pa-2 whitespace-nowrap text-pa-15 font-semibold text-pa-content">
                  {campaign.schedule}
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card padded className="mb-pa-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-pa-5">
          {stages.map((s) => (
            <div key={s.label}>
              <div className="font-pa-mono text-pa-9 uppercase tracking-[0.1em] text-pa-content-tertiary">
                {s.label}
              </div>
              <div
                key={String(s.value)}
                className="pa-num pa-metric-update mt-pa-2 text-pa-20 font-bold"
              >
                {s.value}
              </div>
              <div className="mt-pa-1 text-pa-10 text-pa-content-tertiary">{s.sub}</div>
              {s.pct > 0 && <Track value={s.pct} className="pa-progress-track" />}
            </div>
          ))}
        </div>
      </Card>

      {rejected.length > 0 && (
        <Banner
          tone="error"
          className="mb-pa-4"
          action={
            <span className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setReasonOpen(true);
                }}
              >
                See reason
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  dispatch({ type: 'retryRejectedAds', campaignId: campaign.id });
                  toast(
                    `Rebuilding ${String(rejected.length)} rejected ad${rejected.length === 1 ? '' : 's'}`,
                    'ok',
                  );
                }}
              >
                Recreate & upload
              </Button>
            </span>
          }
        >
          <b>
            {rejected.length} ad{rejected.length === 1 ? '' : 's'}{' '}
            {rejected.length === 1 ? 'was' : 'were'} rejected by the platform
          </b>
          <span className="ml-pa-2">
            {state.creators.find((c) => c.id === rejected[0]?.creatorId)?.name} — the ad is closed.
            Other creators are unaffected.
          </span>
        </Banner>
      )}

      <div className="grid gap-pa-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="flex h-[860px] max-h-[860px] flex-col overflow-hidden">
          <CardHead
            title="Creator work"
            aside={
              <span className="pa-num text-pa-11 text-pa-content-tertiary">
                {campaign.delivering} delivering · {campaign.closed} closed
              </span>
            }
          />
          {work.length > 0 ? (
            <>
              <div className="flex min-h-0 flex-1 overflow-x-auto p-pa-2">
                <div className="min-h-0 min-w-[600px] flex-1 overflow-y-auto">
                  {visibleWork.map((w, index) => {
                    const creator = state.creators.find((c) => c.id === w.creatorId);
                    if (!creator) return null;
                    return (
                      <WorkRow
                        key={w.creatorId}
                        creator={creator}
                        delivery={w}
                        enterDelay={Math.min(index, 6) * 80}
                        onOpen={() => {
                          setSelectedCreatorId(creator.id);
                        }}
                        onStop={() => {
                          dispatch({
                            type: 'stopDelivery',
                            campaignId: campaign.id,
                            creatorId: creator.id,
                          });
                          toast(`${creator.name} video stopped`, 'ok');
                        }}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-pa-border-subtle px-pa-4 py-pa-3 text-pa-11 text-pa-content-tertiary">
                <span>
                  Showing {workPage * WORK_PAGE_SIZE + 1}–
                  {Math.min((workPage + 1) * WORK_PAGE_SIZE, work.length)} of {work.length}
                </span>
                {pageCount > 1 ? (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={workPage === 0}
                      onClick={() => setWorkPage((page) => Math.max(0, page - 1))}
                      className="pa-hit rounded-pa-md px-2 py-1 font-semibold text-pa-content-body hover:bg-pa-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Previous
                    </button>
                    <span className="pa-num">
                      {workPage + 1} / {pageCount}
                    </span>
                    <button
                      type="button"
                      disabled={workPage >= pageCount - 1}
                      onClick={() => setWorkPage((page) => Math.min(pageCount - 1, page + 1))}
                      className="pa-hit rounded-pa-md px-2 py-1 font-semibold text-pa-content-body hover:bg-pa-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Next
                    </button>
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <EmptyState
              title="No creators on this campaign yet"
              description="Matching runs automatically after publishing, or you can invite creators by hand."
              action={
                <Button
                  onClick={() => {
                    setAddOpen(true);
                  }}
                >
                  Add creators
                </Button>
              }
            />
          )}
          <div className="px-pa-4 pb-pa-4">
            <Banner tone="info">
              <b>{live ? 'Live campaign' : 'Creator posts persist'}</b> — creator posts stay on
              their accounts. Pausing stops delivery but leaves the posts up.
            </Banner>
          </div>
        </Card>

        {/* 双 agent 栏已收敛成一条自动化日志：42 个创作者并行工作，
            右栏只显示其中一个是武断的（CAMPAIGN-LIVE.md）。 */}
        <Card className="flex h-[860px] max-h-[860px] flex-col overflow-hidden">
          <CardHead
            title="Automation log"
            aside={
              <DataTrust state={live ? 'fresh' : 'partial'}>{live ? 'live' : 'idle'}</DataTrust>
            }
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-pa-4 pb-pa-4 pt-pa-1">
            {log.map((entry, index) => (
              <LogRow
                key={`${entry.t}-${entry.title}-${entry.sub}`}
                entry={entry}
                fresh={index === 0}
              />
            ))}
          </div>
        </Card>
      </div>

      {confirm !== null && (
        <Dialog
          title={
            confirm === 'pause'
              ? `Pause ${campaignLabel(campaign)}?`
              : confirm === 'resume'
                ? `Resume ${campaignLabel(campaign)}?`
                : `Publish ${campaignLabel(campaign)}?`
          }
          onClose={() => {
            setConfirm(null);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirm(null);
                }}
              >
                Keep as is
              </Button>
              <Button
                // danger 填充只在破坏性操作的二次确认里出现
                variant={confirm === 'pause' ? 'danger' : 'primary'}
                onClick={() => {
                  const status = confirm === 'pause' ? 'stopped' : 'running';
                  dispatch({ type: 'setStatus', id: campaign.id, status });
                  setConfirm(null);
                  toast(
                    `${confirm === 'pause' ? 'Paused' : confirm === 'resume' ? 'Resumed' : 'Published'} ${campaignLabel(campaign)}`,
                    'ok',
                  );
                }}
              >
                {confirm === 'pause'
                  ? 'Pause campaign'
                  : confirm === 'resume'
                    ? 'Resume campaign'
                    : 'Publish campaign'}
              </Button>
            </>
          }
        >
          <DeltaList
            rows={
              confirm === 'pause'
                ? [
                    { label: 'Status', from: STATUS_LABEL[campaign.status], to: 'Stopped' },
                    { label: 'Creators delivering', from: String(campaign.delivering), to: '0' },
                    {
                      label: 'Days remaining',
                      from: campaign.days === null ? '—' : String(campaign.days),
                      to: '—',
                    },
                  ]
                : confirm === 'resume'
                  ? [
                      { label: 'Status', from: 'Stopped', to: 'Live' },
                      {
                        label: 'Remaining cap',
                        from: money(campaign.cap - campaign.spend),
                        to: 'Available to spend',
                      },
                    ]
                  : [
                      { label: 'Status', from: STATUS_LABEL[campaign.status], to: 'Live' },
                      { label: 'Spend', from: '$0', to: `up to ${money(campaign.cap)}` },
                    ]
            }
          />
          <p className="text-pa-12 text-pa-content-body">
            {confirm === 'pause'
              ? 'This stops delivery immediately. Creator posts stay up. You can resume it later.'
              : confirm === 'resume'
                ? 'Delivery restarts from the existing creator set.'
                : 'Publishing starts delivery and begins spending against the cap.'}
          </p>
        </Dialog>
      )}

      {reasonOpen && (
        <Dialog
          title="Why this ad was rejected"
          lede={`${state.creators.find((c) => c.id === rejected[0]?.creatorId)?.name ?? ''} · platform review`}
          onClose={() => {
            setReasonOpen(false);
          }}
          footer={
            <Button
              variant="secondary"
              onClick={() => {
                setReasonOpen(false);
              }}
            >
              Close
            </Button>
          }
        >
          {/* 平台拒审理由是中文用户数据 —— UI 外壳保持英文，载荷原样呈现。
              这正是 --font-pa-ui 必须保留 PingFang SC / Noto Sans SC 的原因。 */}
          <div className="rounded-pa-md bg-pa-surface-muted p-pa-4">
            <p className="text-pa-12 leading-[20px]">
              素材中出现未经授权的第三方品牌标识，且结尾号召性用语与落地页内容不一致。请移除品牌标识后重新提交。
            </p>
            <p className="pa-num mt-pa-2 text-pa-11 text-pa-content-tertiary">
              Reported by the platform · not editable here
            </p>
          </div>
          <p className="text-pa-12 text-pa-content-body">
            Other creators on this campaign are unaffected and keep delivering.
          </p>
        </Dialog>
      )}

      {selectedCreator && selectedDelivery && (
        <Dialog
          wide
          title={`${selectedCreator.name} · campaign video`}
          lede={`${selectedCreator.handle} · ${selectedCreator.platforms.join(' / ').toUpperCase()} · ${campaignLabel(campaign)}`}
          onClose={() => {
            setSelectedCreatorId(null);
          }}
          footer={
            <>
              {selectedCreator.profileUrl ? (
                <a
                  href={selectedCreator.profileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonClasses('secondary')}
                >
                  Open creator account
                </a>
              ) : null}
              <Button
                variant="secondary"
                onClick={() => {
                  setSelectedCreatorId(null);
                }}
              >
                Close
              </Button>
            </>
          }
        >
          <div className="grid gap-pa-4 md:grid-cols-[180px_minmax(0,1fr)]">
            <div
              className="relative aspect-[9/16] overflow-hidden rounded-pa-md bg-pa-surface-muted"
              style={{
                background:
                  selectedAsset?.previewUrl === undefined &&
                  (selectedAsset?.cover ?? selectedCreator.faceAvatar ?? selectedCreator.avatar)
                    ? `linear-gradient(155deg, rgba(15,23,42,.12), rgba(15,23,42,.7)), url(${selectedAsset?.cover ?? selectedCreator.faceAvatar ?? selectedCreator.avatar}) center / cover`
                    : selectedAsset?.previewUrl === undefined
                      ? `linear-gradient(145deg, hsl(${String(selectedCreator.hue)} 46% 60%), hsl(${String((selectedCreator.hue + 38) % 360)} 42% 36%))`
                      : undefined,
              }}
            >
              {selectedAsset?.previewUrl ? (
                <video
                  src={selectedAsset.previewUrl}
                  poster={
                    selectedAsset.cover ?? selectedCreator.faceAvatar ?? selectedCreator.avatar
                  }
                  controls
                  playsInline
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : null}
              <span className="absolute left-pa-2 top-pa-2">
                <StatusPill
                  tone={
                    selectedDelivery.state === 'rejected'
                      ? 'negative'
                      : selectedDelivery.state === 'paused'
                        ? 'neutral'
                        : selectedDelivery.state === 'live'
                          ? 'positive'
                          : 'warning'
                  }
                >
                  {selectedDelivery.state === 'rejected'
                    ? 'Ad rejected'
                    : selectedDelivery.state === 'paused'
                      ? 'Video stopped'
                      : selectedDelivery.state === 'live'
                        ? 'Live video'
                        : 'Preparing'}
                </StatusPill>
              </span>
              <span className="absolute bottom-pa-2 left-pa-2 font-pa-mono text-pa-9 text-white [text-shadow:0_1px_3px_rgba(0,0,0,.7)]">
                {selectedAsset?.origin === 'ai' ? 'AI VIDEO' : 'VIDEO'} ·{' '}
                {selectedAsset?.ratio ?? '9:16'}
                {selectedAsset?.len ? ` · ${selectedAsset.len}` : ''}
              </span>
            </div>
            <div className="grid content-start gap-pa-3">
              <div>
                <Eyebrow>Video work</Eyebrow>
                <b className="mt-1 block text-pa-17">{selectedAsset?.file ?? 'AI creator cut'}</b>
                <span className="text-pa-11 text-pa-content-tertiary">
                  {selectedAsset?.status === 'ready'
                    ? 'Auto-cleared and connected to the creator account'
                    : selectedAsset?.status === 'generating'
                      ? 'AI creative rendering'
                      : 'Platform delivery state'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 rounded-pa-md border border-pa-border-subtle bg-pa-surface-muted p-pa-3">
                <div>
                  <Eyebrow>Status</Eyebrow>
                  <b className="text-pa-13">
                    {selectedDelivery.state === 'live'
                      ? 'Live'
                      : selectedDelivery.state === 'rejected'
                        ? 'Ad rejected'
                        : selectedDelivery.state === 'paused'
                          ? 'Stopped'
                          : 'Preparing'}
                  </b>
                </div>
                <div>
                  <Eyebrow>Views</Eyebrow>
                  <b className="pa-num text-pa-13">{compact(selectedDelivery.views)}</b>
                </div>
                <div>
                  <Eyebrow>Impressions</Eyebrow>
                  <b className="pa-num text-pa-13">{compact(selectedDelivery.impressions)}</b>
                </div>
                <div>
                  <Eyebrow>Clicks</Eyebrow>
                  <b className="pa-num text-pa-13">{compact(selectedDelivery.clicks)}</b>
                </div>
                <div>
                  <Eyebrow>Pacing</Eyebrow>
                  <b className="pa-num text-pa-13">{selectedDelivery.pacing}%</b>
                </div>
                <div>
                  <Eyebrow>CPI</Eyebrow>
                  <b className="pa-num text-pa-13">{cpi(selectedDelivery.cpi)}</b>
                </div>
              </div>
              <div className="rounded-pa-md border border-pa-border-subtle p-pa-3">
                <Eyebrow>Creator account</Eyebrow>
                <div className="mt-pa-2 flex items-center gap-pa-2">
                  <Avatar
                    name={selectedCreator.name}
                    src={selectedCreator.avatar}
                    hue={selectedCreator.hue}
                    size="s"
                  />
                  <div className="min-w-0">
                    <b className="block truncate text-pa-14 font-semibold text-pa-content">
                      {selectedCreator.name}
                    </b>
                    {selectedCreator.profileUrl ? (
                      <a
                        href={selectedCreator.profileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-pa-11 text-pa-accent hover:underline"
                      >
                        {selectedCreator.profileUrl}
                      </a>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Dialog>
      )}

      {addOpen && (
        <Drawer
          title={`Add creators to ${campaignLabel(campaign)}`}
          lede="Matching normally runs on its own — this adds people by hand."
          onClose={() => {
            setAddOpen(false);
            setPicked([]);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setAddOpen(false);
                  setPicked([]);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (picked.length === 0) {
                    toast("Couldn't add — pick at least one creator", 'error');
                    return;
                  }
                  dispatch({ type: 'addCreators', campaignId: campaign.id, creatorIds: picked });
                  toast(
                    `Added ${String(picked.length)} creator${picked.length === 1 ? '' : 's'} to ${campaignLabel(campaign)}`,
                    'ok',
                  );
                  setAddOpen(false);
                  setPicked([]);
                }}
              >
                Add selected
              </Button>
            </>
          }
        >
          {pool.length === 0 ? (
            <EmptyState
              title="Everyone is already on this campaign"
              description="Every creator in the network is already delivering here."
            />
          ) : (
            <div>
              {pool.map((creator) => (
                <Checkbox
                  key={creator.id}
                  checked={picked.includes(creator.id)}
                  onChange={(on) => {
                    setPicked((prev) =>
                      on ? [...prev, creator.id] : prev.filter((id) => id !== creator.id),
                    );
                  }}
                  className="justify-between"
                  label={
                    <span className="flex w-full items-center justify-between gap-pa-3">
                      <span className="flex min-w-0 items-center gap-pa-2">
                        <Avatar
                          name={creator.name}
                          src={creator.avatar}
                          hue={creator.hue}
                          size="m"
                        />
                        <span className="min-w-0">
                          <b className="block truncate text-pa-14 font-semibold text-pa-content">
                            {creator.name}
                          </b>
                          <span className="block truncate font-pa-mono text-pa-11 text-pa-content-tertiary">
                            {creator.handle} · {creator.market}
                          </span>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-pa-2">
                        {creator.platforms.map((p) => (
                          <PlatformIcon key={p} platform={p} small />
                        ))}
                        <b className="pa-num text-pa-11">{compact(creator.followers)}</b>
                      </span>
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </Drawer>
      )}
    </>
  );
}
