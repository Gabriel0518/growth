import Link from 'next/link';
import type { ReactNode } from 'react';

import { Track } from './track';

import { Avatar, PlatformIcon } from '@/components/ui';
import { compact, money, roas } from '@/lib/pa/format';
import type { Creator, Delivery } from '@/lib/pa/types';

interface CreatorCardProps {
  creator: Creator;
  delivery: Delivery;
}

/** Overview 上的合作创作者卡片：身份 + 三个指标 + 投放进度 + 标签 + ROAS。 */
export function CreatorCard({ creator, delivery }: CreatorCardProps): ReactNode {
  return (
    <div className="rounded-pa-lg border border-pa-border bg-pa-surface transition-[border-color,box-shadow] duration-[120ms] hover:border-pa-border-strong hover:shadow-pa-1">
      <Link
        href={`/pa/kols/${creator.id}`}
        className="block p-pa-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring"
      >
        <div className="flex flex-nowrap items-center gap-pa-3">
          <Avatar name={creator.name} src={creator.avatar} hue={creator.hue} size="m" />
          <div className="min-w-0 flex-1">
            {/* 创作者名与 handle 长度差异很大，截断而不是让长的把卡片挤变形 */}
            <b className="block truncate text-pa-14">{creator.name}</b>
            <div className="truncate font-pa-mono text-pa-11 text-pa-content-tertiary">
              {creator.handle}
            </div>
          </div>
          {creator.platforms[0] === undefined ? null : (
            <PlatformIcon platform={creator.platforms[0]} />
          )}
        </div>

        <hr className="my-[14px] border-0 border-t border-pa-border-subtle" />

        <div className="grid grid-cols-3 gap-pa-2">
          {[
            ['Impressions', compact(delivery.impressions)],
            ['Clicks', compact(delivery.clicks)],
            ['Revenue', money(delivery.revenue)],
          ].map(([label, value]) => (
            <div key={label}>
              <b className="pa-num text-pa-15 font-bold">{value}</b>
              <div className="mt-[3px] text-pa-9 text-pa-content-tertiary">{label}</div>
            </div>
          ))}
        </div>

        <div className="mt-[14px] flex items-center justify-between">
          <span className="text-pa-11 text-pa-content-tertiary">Campaign pacing</span>
          <b className="pa-num text-pa-11">{delivery.pacing}%</b>
        </div>
        <Track value={delivery.pacing} />

        <div className="mt-[14px] flex items-center justify-between gap-pa-3">
          <span className="flex flex-wrap gap-[6px]">
            {creator.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex h-[22px] items-center rounded-pa-full bg-pa-surface-muted px-[10px] text-pa-11 text-pa-content-body"
              >
                {tag}
              </span>
            ))}
          </span>
          <span className="text-right">
            <span className="block text-pa-9 text-pa-content-tertiary">ROAS</span>
            <b className="pa-num block text-pa-14">{roas(delivery.roas)}</b>
          </span>
        </div>

      </Link>
      {creator.profileUrl === undefined ? null : (
        <a
          href={creator.profileUrl}
          target="_blank"
          rel="noreferrer"
          className="mx-pa-4 mb-pa-3 block truncate text-pa-11 text-pa-accent hover:underline"
        >
          Open public profile ↗
        </a>
      )}
    </div>
  );
}
