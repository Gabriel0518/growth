import type { ReactNode } from 'react';

import { cn } from './cn';

export type Platform = 'ig' | 'tt' | 'yt';

const LABEL: Record<Platform, string> = {
  ig: 'Instagram',
  tt: 'TikTok',
  yt: 'YouTube',
};

/**
 * ⚠️ 品牌底色**故意写成字面值、不绑主题变量** —— logo 不应该随主题变色。
 * 这条规则以前靠人记（全站审计时总要解释「未绑的只有 TikTok 黑」），
 * 现在固化在这里（COMPONENTS.md 决定③）。
 *
 * 取值与 Figma 稿一致：这三个色是为了融进浅色面板而调过的，不是各平台的官方品牌色。
 * 改动前先看 Figma，别照搬 Instagram 渐变或 YouTube 正红。
 */
const BRAND: Record<Platform, string> = {
  ig: '#4778cf',
  tt: '#0f172a',
  yt: '#dc2626',
};

const PATHS: Record<Platform, ReactNode> = {
  ig: (
    <>
      <rect x="1.4" y="1.4" width="15.2" height="15.2" rx="4.6" />
      <circle cx="9" cy="9" r="3.6" />
      <circle cx="13.4" cy="4.6" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  tt: (
    <path
      d="M11.4 1.2h2.4c.2 1.7 1.2 3 3 3.3v2.4c-1.2 0-2.3-.35-3.2-1v5.4a5.2 5.2 0 11-5.2-5.2c.3 0 .55.02.8.06v2.5a2.75 2.75 0 102.2 2.7V1.2z"
      fill="currentColor"
      stroke="none"
    />
  ),
  yt: <path d="M6 4.6l5.4 3.4L6 11.4z" fill="currentColor" stroke="none" />,
};

interface PlatformIconProps {
  platform: Platform;
  /** 小号用于表格行内与卡片页脚，与 Figma 的 22px 档对应。 */
  small?: boolean;
  className?: string;
}

export function PlatformIcon({ platform, small = false, className }: PlatformIconProps): ReactNode {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-[6px] text-white',
        small ? 'h-[22px] w-[22px]' : 'h-[24px] w-[24px]',
        className,
      )}
      style={{ background: BRAND[platform] }}
      title={LABEL[platform]}
      aria-label={LABEL[platform]}
      role="img"
    >
      <svg
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        className={small ? 'h-[12px] w-[12px]' : 'h-[14px] w-[14px]'}
      >
        {PATHS[platform]}
      </svg>
    </span>
  );
}
