'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';

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
import type { CampaignStatus, DeliveryState } from '@/lib/pa/types';

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

/** 排序权重：失败最前、待处理次之、正常最后。异常必须一眼可见。 */
function severity(state: DeliveryState): number {
  return state === 'rejected' ? 0 : state === 'preparing' ? 1 : 2;
}

export default function CampaignDetailPage(): ReactNode {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { state, dispatch } = usePaStore();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'pause' | 'resume' | 'publish' | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  const campaign = state.campaigns.find((c) => c.id === params.id);
  const product = state.products.find((p) => p.id === campaign?.productId);

  /**
   * ⚠️ 失败行**默认排最前**。异常埋在 42 行里等于没报 ——
   * 全自动系统的价值不是「让你看它跑」，而是出问题时立刻告诉你（CAMPAIGN-LIVE.md）。
   */
  const work = useMemo(() => {
    if (!campaign) return [];
    return state.delivery
      .filter((d) => d.campaignId === campaign.id)
      .sort((a, b) => severity(a.state) - severity(b.state));
  }, [state.delivery, campaign]);

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
  const log = state.automationLog
    .filter((l) => l.campaignId === undefined || l.campaignId === campaign.id)
    .slice(0, 8);

  /**
   * 顶部状态带：前两个状态显示**构建进度**，后两个显示**投放结果** ——
   * 不同阶段问的问题不一样，不套同一个模板（CAMPAIGN-LIVE.md）。
   */
  const stages = building
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

  return (
    <>
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <PageHeader
        title={campaignLabel(campaign)}
        lede={copy.lede}
        badge={
          <StatusPill tone={STATUS_TONE_OF(campaign.status)}>
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
        <div className="flex flex-wrap items-stretch gap-pa-5">
          <div className="flex min-w-[270px] flex-nowrap items-center gap-pa-3">
            <ProductIcon product={product} size={60} />
            <div>
              <Eyebrow>Product</Eyebrow>
              <b className="mt-px block text-pa-17">{product.name}</b>
              <div className="text-pa-11 text-pa-content-tertiary">
                {product.category} · {product.platforms}
              </div>
              <div className="pa-num text-pa-11 text-pa-accent">{product.store}</div>
            </div>
          </div>
          <div className="hidden w-px bg-pa-border lg:block" />
          <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-pa-5">
            <div>
              <Eyebrow>Objective</Eyebrow>
              <b className="text-pa-13">{product.objective}</b>
            </div>
            <div>
              <Eyebrow>Market</Eyebrow>
              <b className="text-pa-13">{campaign.market}</b>
            </div>
            <div>
              <Eyebrow>Spent / Cap</Eyebrow>
              <b className="pa-num text-pa-13">
                {moneyK(campaign.spend)} / {moneyK(campaign.cap)}
              </b>
            </div>
            <div>
              <Eyebrow>Schedule</Eyebrow>
              <b className="pa-num text-pa-13">{campaign.schedule}</b>
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
              <div className="pa-num mt-pa-2 text-pa-20 font-bold">{s.value}</div>
              <div className="mt-pa-1 text-pa-10 text-pa-content-tertiary">{s.sub}</div>
              {s.pct > 0 && <Track value={s.pct} />}
            </div>
          ))}
        </div>
      </Card>

      {rejected.length > 0 && (
        <Banner
          tone="error"
          className="mb-pa-4"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setReasonOpen(true);
              }}
            >
              See reason
            </Button>
          }
        >
          <b>{rejected.length} ad was rejected by the platform</b>
          <span className="ml-pa-2">
            {state.creators.find((c) => c.id === rejected[0]?.creatorId)?.name} — the ad is closed.
            Other creators are unaffected.
          </span>
        </Banner>
      )}

      <div className="grid gap-pa-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
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
              <div className="overflow-x-auto p-pa-2">
                <div className="min-w-[600px]">
                  {work.map((w) => {
                    const creator = state.creators.find((c) => c.id === w.creatorId);
                    if (!creator) return null;
                    return (
                      <WorkRow
                        key={w.creatorId}
                        creator={creator}
                        delivery={w}
                        onOpen={() => {
                          router.push(`/pa/kols/${creator.id}`);
                        }}
                      />
                    );
                  })}
                </div>
              </div>
              <p className="border-t border-pa-border-subtle px-pa-4 py-pa-3 text-pa-11 text-pa-content-tertiary">
                Showing {work.length} of {campaign.kols}
              </p>
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
        <Card>
          <CardHead
            title="Automation log"
            aside={
              <DataTrust state={live ? 'fresh' : 'partial'}>{live ? 'live' : 'idle'}</DataTrust>
            }
          />
          <div className="px-pa-4 pb-pa-4 pt-pa-1">
            {log.map((entry) => (
              <LogRow key={`${entry.t}-${entry.title}`} entry={entry} />
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
                        <Avatar name={creator.name} hue={creator.hue} size="m" />
                        <span className="min-w-0">
                          <b className="block truncate text-pa-13">{creator.name}</b>
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
