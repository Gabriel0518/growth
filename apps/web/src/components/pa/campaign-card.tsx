import Link from 'next/link';
import type { ReactNode } from 'react';

import { ProductIcon } from './product-icon';
import { Track } from './track';

import { PlatformIcon, StatusPill } from '@/components/ui';
import { campaignLabel, money, int, pacing, roas } from '@/lib/pa/format';
import { STATUS_LABEL, STATUS_TONE_OF } from '@/lib/pa/status';
import type { Campaign, Product } from '@/lib/pa/types';

export function CampaignCard({
  campaign,
  product,
}: {
  campaign: Campaign;
  product: Product;
}): ReactNode {
  const pace = pacing(campaign);
  return (
    <Link
      href={`/pa/campaigns/${campaign.id}`}
      className="block rounded-pa-md border border-pa-border bg-pa-surface p-pa-4 transition-[border-color,box-shadow] duration-[120ms] hover:border-pa-border-strong hover:shadow-pa-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring"
    >
      <div className="flex items-start gap-pa-3">
        <ProductIcon product={product} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-pa-13 font-bold">{campaignLabel(campaign)}</div>
          <div className="mt-px truncate text-pa-10 text-pa-content-secondary">
            {product.name} · {product.objective}
          </div>
          <div className="mt-px font-pa-mono text-pa-9 text-pa-content-tertiary">{campaign.id}</div>
        </div>
        <StatusPill tone={STATUS_TONE_OF(campaign.status)}>
          {STATUS_LABEL[campaign.status]}
        </StatusPill>
      </div>

      <hr className="my-[14px] border-0 border-t border-pa-border" />

      <div className="grid grid-cols-[60px_1fr_60px] gap-pa-2">
        <div>
          <div className="pa-num text-pa-14 font-bold">{int(campaign.kols)}</div>
          <div className="mt-[3px] text-pa-9 text-pa-content-tertiary">KOLs</div>
        </div>
        <div>
          <div className="pa-num text-pa-14 font-bold">
            {money(campaign.spend)}{' '}
            <small className="text-pa-10 font-normal text-pa-content-tertiary">
              / {money(campaign.cap)}
            </small>
          </div>
          <div className="mt-[3px] text-pa-9 text-pa-content-tertiary">Spend / Cap</div>
        </div>
        <div>
          <div className="pa-num text-pa-14 font-bold">{roas(campaign.roas)}</div>
          <div className="mt-[3px] text-pa-9 text-pa-content-tertiary">ROAS</div>
        </div>
      </div>

      <hr className="my-[14px] border-0 border-t border-pa-border" />

      <div className="flex items-baseline justify-between text-pa-9 text-pa-content-tertiary">
        <span>Spend pacing</span>
        <b className="pa-num text-pa-12 text-pa-content">{pace}%</b>
      </div>
      <Track value={pace} />

      <div className="mt-[14px] flex items-center justify-between">
        <span className="font-pa-mono text-pa-9 text-pa-content-secondary">
          {/* 无结束日期时说「No end date」，不写 0 天 —— 0 会被读成「今天结束」 */}
          {campaign.days === null ? 'No end date' : `${String(campaign.days)} days remaining`}
        </span>
        <span className="flex gap-pa-1">
          {campaign.channels.map((ch) => (
            <PlatformIcon key={ch} platform={ch} />
          ))}
        </span>
      </div>
    </Link>
  );
}
