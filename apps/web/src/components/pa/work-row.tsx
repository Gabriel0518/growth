import type { ReactNode } from 'react';

import { Avatar, StatusPill } from '@/components/ui';
import { compact, cpi } from '@/lib/pa/format';
import { DELIVERY_LABEL, DELIVERY_TONE_OF } from '@/lib/pa/status';
import type { Creator, Delivery, PlatformKey } from '@/lib/pa/types';

const PLATFORM_NAME: Record<PlatformKey, string> = {
  ig: 'Instagram',
  tt: 'TikTok',
  yt: 'YouTube',
};

/** 三段进度：Creative → Ad → Live。平台拒审时 Ad 段标红。 */
function Progress({ state }: { state: Delivery['state'] }): ReactNode {
  const stages = ['Creative', 'Ad', 'Live'];
  return (
    <span>
      <span className="flex gap-[6px]">
        {stages.map((label, i) => {
          // A platform rejection happens at the Ad stage, while the creative
          // itself remains a valid source asset.
          const bad = state === 'rejected' && i === 1;
          const on =
            state === 'rejected'
              ? i === 0
              : state === 'paused'
                ? false
                : state === 'preparing'
                  ? i === 0
                  : true;
          return (
            <i
              key={label}
              className={`h-[4px] flex-1 rounded-pa-full ${
                bad ? 'bg-pa-negative' : on ? 'bg-pa-positive' : 'bg-pa-surface-muted'
              }`}
            />
          );
        })}
      </span>
      <span className="mt-pa-1 flex gap-[22px] text-pa-9 text-pa-content-tertiary">
        {stages.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </span>
    </span>
  );
}

interface WorkRowProps {
  creator: Creator;
  delivery: Delivery;
  onOpen: () => void;
  onStop?: () => void;
  enterDelay?: number;
}

/**
 * campaign 详情里的一行创作者工作状态。
 * ⚠️ 失败行整行标红底并**默认排最前** —— 异常不能埋在 42 行里
 * （CAMPAIGN-LIVE.md：全自动系统的价值是出问题时立刻告诉你）。
 */
export function WorkRow({
  creator,
  delivery,
  onOpen,
  onStop,
  enterDelay = 0,
}: WorkRowProps): ReactNode {
  const bad = delivery.state === 'rejected';
  return (
    <div
      role="group"
      aria-label={`Creator work for ${creator.name}`}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      style={{ animationDelay: `${String(enterDelay)}ms` }}
      className={`pa-row-enter grid grid-cols-[minmax(120px,1fr)_44px_132px_118px_84px_108px] items-center gap-pa-2 rounded-pa-md p-pa-2 transition-[background-color] duration-[160ms] hover:bg-pa-surface-muted [&+&]:border-t [&+&]:border-pa-border-subtle focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-pa-ring ${
        bad ? 'bg-pa-negative-subtle' : ''
      }`}
    >
      <span className="flex min-w-0 flex-nowrap items-center gap-pa-2">
        <Avatar name={creator.name} src={creator.avatar} hue={creator.hue} size="m" />
        <span className="min-w-0">
          <b className="block truncate text-pa-14 font-semibold text-pa-content">{creator.name}</b>
          <span className="block truncate text-pa-11 text-pa-content-tertiary">
            {compact(creator.followers)} ·{' '}
            {creator.platforms.map((p) => PLATFORM_NAME[p]).join(', ')}
          </span>
        </span>
      </span>

      <span className="text-center">
        <b className="pa-num block text-pa-13">{delivery.fit}</b>
        <span className="text-pa-9 text-pa-content-tertiary">FIT</span>
      </span>

      <Progress state={delivery.state} />

      <span>
        <StatusPill
          key={delivery.state}
          tone={DELIVERY_TONE_OF(delivery.state)}
          {...(delivery.state === 'live'
            ? { className: 'pa-state-arrive' }
            : delivery.state === 'rejected'
              ? { className: 'pa-state-alert' }
              : {})}
        >
          {DELIVERY_LABEL[delivery.state]}
        </StatusPill>
      </span>

      {/* 未上线的行右半留空 —— 一眼看出谁在跑、谁卡住 */}
      <span className="text-right">
        {bad || delivery.state === 'paused' ? (
          <StatusPill tone="neutral">Closed</StatusPill>
        ) : delivery.state === 'preparing' ? (
          <span className="text-pa-11 text-pa-content-tertiary">—</span>
        ) : (
          <>
            <b className="pa-num block text-pa-11">{compact(delivery.views)} views</b>
            <span className="pa-num block text-pa-11 text-pa-content-tertiary">
              {cpi(delivery.cpi)} CPI
            </span>
          </>
        )}
      </span>

      <span className="flex w-[108px] items-center justify-end gap-1">
        {onStop && (delivery.state === 'live' || delivery.state === 'preparing') ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onStop();
            }}
            aria-label={`Stop video for ${creator.name}`}
            className="pa-hit h-[28px] w-[44px] rounded-pa-md px-1 text-pa-10 font-semibold text-pa-content-tertiary hover:bg-pa-negative-subtle hover:text-pa-negative focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring"
          >
            Stop
          </button>
        ) : (
          <span aria-hidden="true" className="h-[28px] w-[44px]" />
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          aria-label={`Open ${creator.name}`}
          className="pa-hit grid h-[32px] w-[32px] place-items-center rounded-pa-md text-pa-content-tertiary hover:bg-pa-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring"
        >
          ...
        </button>
      </span>
    </div>
  );
}
