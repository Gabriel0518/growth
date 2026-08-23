import type { ReactNode } from 'react';

import { StatusPill } from '@/components/ui';
import { ASSET_LABEL, ASSET_TONE_OF } from '@/lib/pa/status';
import type { Asset, Creator } from '@/lib/pa/types';

/**
 * 素材缩略图是程序化的渐变占位（真实缩略图未接入）。
 * ⚠️ **AI 变体与其源素材共用同一个色相** —— 换脸只改人脸、场景不变，
 * 这样卡片上的血缘关系一眼可读（BACKLOG.md）。
 */
function thumbStyle(hue: number): { background: string } {
  return {
    background: `linear-gradient(150deg, hsl(${String(hue)} 46% 62%), hsl(${String((hue + 40) % 360)} 42% 38%))`,
  };
}

interface AssetCardProps {
  asset: Asset;
  creator: Creator | undefined;
  onOpen: () => void;
}

export function AssetCard({ asset, creator, onOpen }: AssetCardProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full overflow-hidden rounded-pa-md border border-pa-border bg-pa-surface text-left hover:border-pa-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pa-ring"
    >
      <div
        className="relative grid aspect-[16/11] place-items-center"
        style={thumbStyle(asset.hue)}
      >
        <div className="absolute right-pa-2 top-pa-2">
          <StatusPill tone={ASSET_TONE_OF(asset.status)}>{ASSET_LABEL[asset.status]}</StatusPill>
        </div>
        <span className="absolute bottom-pa-2 left-pa-2 font-pa-mono text-pa-9 text-white [text-shadow:0_1px_3px_rgba(0,0,0,.6)]">
          {asset.kind} · {asset.ratio}
          {asset.len === null ? '' : ` · ${asset.len}`}
        </span>
      </div>
      <div className="grid gap-pa-2 px-[14px] py-pa-3">
        <div className="break-all text-pa-12 font-semibold">{asset.file}</div>
        <span className="inline-flex items-center gap-[6px] text-pa-10 text-pa-content-tertiary">
          {asset.origin === 'ai'
            ? `AI variant${creator === undefined ? '' : ` · ${creator.name}`}`
            : 'Source footage'}
        </span>
      </div>
    </button>
  );
}
