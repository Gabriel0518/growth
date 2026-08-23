import type { ReactNode } from 'react';

import { cn } from './cn';

/** 尺寸取 Figma 组件轴 S/M/L = 24/36/72（原型里的 28/54/72 不是有文档的 API，不沿用）。 */
export type AvatarSize = 's' | 'm' | 'l';

const SIZE: Record<AvatarSize, string> = {
  s: 'h-[24px] w-[24px] basis-[24px] text-pa-8',
  m: 'h-[36px] w-[36px] basis-[36px] text-pa-11',
  l: 'h-[72px] w-[72px] basis-[72px] text-pa-20',
};

/**
 * 取姓名首字母，最多两个。空名回退 '—'（缺数一律用破折号，不用 '?' 或 'N/A'）。
 */
function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((word) => word.charAt(0))
    .join('');
  return letters.slice(0, 2).toUpperCase() || '—';
}

/**
 * 由姓名派生一个稳定色相：同一个人在任何页面都是同一个颜色，跨屏可辨认。
 * 用确定性哈希而非随机数 —— 服务端与客户端渲染结果必须一致，否则会 hydration 不匹配。
 */
function hueOf(name: string): number {
  let hash = 0;
  // codePointAt 返回 number | undefined；迭代出的字符必然非空，
  // 但用 ?? 0 兜住比加非空断言干净（strictTypeChecked 禁用 !）。
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hash;
}

interface AvatarProps {
  name: string;
  size?: AvatarSize;
  /** 有真实头像时传 URL；没有就落到首字母 + 稳定色相。 */
  src?: string | undefined;
  /** 覆盖派生色相，用于已经有既定配色的存量数据。 */
  hue?: number | undefined;
  className?: string;
}

export function Avatar({ name, size = 'm', src, hue, className }: AvatarProps): ReactNode {
  const resolvedHue = hue ?? hueOf(name);
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden rounded-pa-full',
        'font-bold text-white',
        SIZE[size],
        className,
      )}
      style={{ background: `hsl(${String(resolvedHue)} 52% 46%)` }}
      // 头像是装饰 —— 名字总是在旁边以文本形式出现，读屏重复一遍是噪音。
      aria-hidden="true"
    >
      {src === undefined ? (
        initialsOf(name)
      ) : (
        <img src={src} alt="" className="h-full w-full object-cover" />
      )}
    </span>
  );
}
