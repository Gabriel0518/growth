'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  Card,
  DeltaList,
  Dialog,
  Eyebrow,
  PageHeader,
  ProductIcon,
  Stepper,
  useToast,
  usePaStore,
} from '@/components/pa';
import { Button, buttonClasses, DataTrust, StatusPill } from '@/components/ui';
import { campaignLabel, int, money, roas } from '@/lib/pa/format';

const INPUT =
  'pa-num h-[var(--pa-hit-target)] w-full rounded-pa-md border border-pa-border bg-pa-surface px-[14px] text-pa-13 outline-none focus:border-pa-ring focus:shadow-[0_0_0_3px_rgba(8,145,178,0.16)]';

/**
 * ⚠️ 两种目标**不对称**，这是本页最容易做错的地方（CREATE-CAMPAIGN.md）：
 *
 *   installs 模式 —— 钱是**填**进去的（预算上限），安装量是算出来的
 *   roas 模式     —— 目标是个**比值**，不含量纲，推不出消耗；所以仍要用户填预算上限，
 *                   再由它反推预期营收
 *
 * 两个模式的「大数字区」因此不是同一个模板换数字。这里共用 cap 输入，
 * 但派生出的第二个数字不同（安装量 vs 预期营收）。
 */
function derive(mode: 'installs' | 'roas', cap: number, targetRoas: number) {
  // KOL 数量按该品类的平均单条曝光估算。接后端后换成真实的品类基准值。
  const kols = Math.max(12, Math.round(cap / 3000));
  return mode === 'roas'
    ? { kols, label: 'Projected revenue', value: money(cap * targetRoas) }
    : { kols, label: 'Projected installs', value: int(Math.round(cap / 2.4)) };
}

export default function ConversionGoalPage(): ReactNode {
  const { state, dispatch } = usePaStore();
  const router = useRouter();
  const toast = useToast();
  const draft = state.draft;
  const [reviewOpen, setReviewOpen] = useState(false);

  /**
   * 发布会把草稿置空。
   * ⚠️ 没有这个标记，下面「没草稿就退回第一步」的守卫会抢在跳转之前触发，
   * 把刚发布完的用户又弹回向导第一步。已踩过一次。
   */
  const publishedRef = useRef(false);

  // 没有草稿（或直接深链接进来）就退回第一步 —— 这一页离开草稿没有意义。
  useEffect(() => {
    if (!publishedRef.current && !draft?.name) router.replace('/pa/campaigns/new');
  }, [draft, router]);

  if (!draft?.name) return null;

  // 取成常量：下面的 patch/publish 是闭包，TS 无法把可选链的收窄带进去。
  const current = draft;
  const product = state.products.find((p) => p.id === current.productId);
  const est = derive(current.mode, current.cap, current.targetRoas);

  function patch(next: Partial<typeof current>): void {
    dispatch({ type: 'setDraft', draft: { ...current, ...next } });
  }

  function publish(): void {
    if (current.cap < 1000) {
      toast("Couldn't continue — set a budget cap of at least $1,000", 'error');
      return;
    }
    setReviewOpen(true);
  }

  return (
    <>
      <Eyebrow>New campaign / Conversion goal</Eyebrow>
      <PageHeader
        title={current.name}
        lede="Step 2 of 2 — state the outcome. Spend and creator count are derived from it."
      />

      <Stepper steps={['Ad setup', 'Conversion goal']} active={2} />

      <Card padded className="mb-pa-4 flex flex-wrap items-center justify-between gap-pa-3">
        <div className="flex items-center gap-pa-3">
          {product ? <ProductIcon product={product} /> : null}
          <div>
            <b className="text-pa-13">{product?.name}</b>
            <div className="text-pa-11 text-pa-content-tertiary">
              {product?.category} · {product?.platforms}
            </div>
          </div>
        </div>
        <Link href="/pa/campaigns/new" className={buttonClasses('ghost', 'sm')}>
          Change product
        </Link>
      </Card>

      <Card padded className="mb-pa-4">
        <Eyebrow className="mb-pa-3">② Optimise for</Eyebrow>
        <div className="grid gap-pa-3 md:grid-cols-2">
          {(
            [
              [
                'installs',
                'App installs',
                'Bid toward the lowest cost per install. Best when the product is new in this market.',
              ],
              [
                'roas',
                'Return on ad spend',
                'Bid toward a blended ROAS target. Needs at least 30 days of purchase history.',
              ],
            ] as const
          ).map(([mode, title, body]) => {
            const on = current.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  patch({ mode });
                }}
                className={`rounded-pa-lg border bg-pa-surface p-pa-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring ${
                  on
                    ? 'border-pa-accent shadow-[0_0_0_3px_var(--color-pa-accent-subtle)]'
                    : 'border-pa-border'
                }`}
              >
                <div className="flex items-center justify-between gap-pa-2">
                  <b className="text-pa-13">{title}</b>
                  {on ? <StatusPill tone="progress">Selected</StatusPill> : null}
                </div>
                <p className="mt-pa-2 text-pa-11 text-pa-content-tertiary">{body}</p>
              </button>
            );
          })}
        </div>

        {current.mode === 'roas' && (
          <div className="mt-pa-4 grid max-w-[280px] gap-[6px]">
            <label
              htmlFor="pa-troas"
              className="text-pa-12 font-semibold text-pa-content-secondary"
            >
              Target ROAS
            </label>
            <input
              id="pa-troas"
              type="number"
              step="0.1"
              min="1"
              className={INPUT}
              value={current.targetRoas}
              onChange={(event) => {
                patch({ targetRoas: Number(event.target.value) || 0 });
              }}
            />
            <p className="text-pa-11 text-pa-content-tertiary">
              Campaigns below target for 3 days trigger a review.
            </p>
          </div>
        )}

        <hr className="my-pa-5 border-0 border-t border-pa-border-subtle" />

        <div className="grid gap-pa-4 md:grid-cols-2">
          <div className="grid gap-[6px]">
            <label htmlFor="pa-ccap" className="text-pa-12 font-semibold text-pa-content-secondary">
              Budget cap
            </label>
            <input
              id="pa-ccap"
              type="number"
              step="1000"
              min="1000"
              className={INPUT}
              value={current.cap}
              onChange={(event) => {
                patch({ cap: Number(event.target.value) || 0 });
              }}
            />
            <p className="text-pa-11 text-pa-content-tertiary">
              Total spend ceiling for the whole flight. Delivery stops at the cap.
            </p>
          </div>
          <div className="grid gap-[6px]">
            <span className="text-pa-12 font-semibold text-pa-content-secondary">Delivery</span>
            <div className={`${INPUT} flex items-center bg-pa-surface-muted text-pa-content-body`}>
              Manual start / stop
            </div>
            <p className="text-pa-11 text-pa-content-tertiary">
              Start or pause delivery from the campaign controls whenever you are ready.
            </p>
          </div>
        </div>

        <div className="mt-pa-4 rounded-pa-md bg-pa-surface-muted p-pa-4">
          <div className="flex flex-wrap items-center justify-between gap-pa-2">
            <b className="text-pa-13">Derived plan</b>
            {/* 估算必须标明它是估算，不能与实测数字长得一样 */}
            <DataTrust state="partial">estimate · not measured</DataTrust>
          </div>
          <div className="mt-pa-3 grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-pa-3">
            <div>
              <b className="pa-num text-[18px] leading-[24px]">{int(est.kols)}</b>
              <div className="mt-[3px] text-pa-9 text-pa-content-tertiary">Creators needed</div>
            </div>
            <div>
              <b className="pa-num text-[18px] leading-[24px]">{est.value}</b>
              <div className="mt-[3px] text-pa-9 text-pa-content-tertiary">{est.label}</div>
            </div>
            <div>
              <b className="pa-num text-[18px] leading-[24px]">{money(current.cap)}</b>
              <div className="mt-[3px] text-pa-9 text-pa-content-tertiary">Cap</div>
            </div>
          </div>
          <p className="mt-pa-3 text-pa-11 text-pa-content-tertiary">
            Modelled on 128 partner creators in {product?.category} — {current.market}.
          </p>
        </div>

        <div className="mt-pa-5 flex flex-wrap items-center justify-between gap-pa-3">
          <Link href="/pa/campaigns/new" className={buttonClasses('secondary')}>
            Back to ad setup
          </Link>
          <Button onClick={publish}>Review before publishing</Button>
        </div>
      </Card>

      {reviewOpen && (
        <Dialog
          wide
          title="Review before publishing"
          lede="Publishing starts delivery and begins spending against the cap."
          onClose={() => {
            setReviewOpen(false);
          }}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setReviewOpen(false);
                }}
              >
                Keep editing
              </Button>
              <Button
                onClick={() => {
                  publishedRef.current = true;
                  setReviewOpen(false);
                  dispatch({ type: 'createCampaign', draft: current });
                  toast(`Published ${campaignLabel(current)}`, 'ok');
                  router.push('/pa/campaigns');
                }}
              >
                Publish campaign
              </Button>
            </>
          }
        >
          <DeltaList
            rows={[
              { label: 'Campaign', from: '—', to: campaignLabel(current) },
              {
                label: 'Product',
                from: '—',
                to: `${product?.name ?? ''} · ${product?.category ?? ''}`,
              },
              {
                label: 'Objective',
                from: '—',
                to:
                  current.mode === 'roas'
                    ? `Return on ad spend · target ${roas(current.targetRoas)}`
                    : (product?.objective ?? ''),
              },
              { label: 'Budget cap', from: '$0', to: money(current.cap) },
              { label: 'Delivery', from: '—', to: 'Manual start / stop' },
            ]}
          />
          <p className="text-pa-12 text-pa-content-body">
            Matching, creative generation and ad build run automatically once published. You only
            step in when something fails.
          </p>
        </Dialog>
      )}
    </>
  );
}
