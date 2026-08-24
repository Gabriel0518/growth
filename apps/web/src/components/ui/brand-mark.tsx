import type { ReactNode } from 'react';

import { cn } from './cn';

/**
 * Sitin.ai S mark from the Figma logo component set.
 * The source silhouette is shared across primary, inverse, light and mono usages;
 * `color` controls only the mark fill so the same component can be themed safely.
 */
const SOURCE_PATH =
  'M4485 8354 c-16 -2 -73 -9 -125 -15 -618 -70 -1195 -430 -1553 -971 -402 -606 -483 -1378 -213 -2038 62 -150 71 -167 307 -577 115 -199 209 -364 209 -367 0 -3 -342 -6 -761 -6 -418 0 -759 -4 -757 -8 2 -5 345 -601 763 -1326 l760 -1316 1285 3 1285 2 115 23 c149 29 312 75 425 119 609 239 1088 751 1293 1384 146 449 145 922 -3 1366 -62 187 -123 309 -358 715 -114 196 -207 359 -207 362 0 3 342 6 760 6 418 0 760 2 760 4 0 4 -130 229 -700 1216 -119 206 -353 612 -520 903 l-305 527 -1215 -1 c-668 -1 -1228 -4 -1245 -5z m1758 -1434 c34 -58 204 -352 378 -655 l318 -550 -760 -3 c-417 -1 -759 -6 -759 -10 0 -5 174 -310 386 -678 213 -368 400 -698 416 -733 53 -116 71 -201 71 -351 0 -108 -4 -151 -22 -215 -96 -355 -374 -607 -730 -660 -77 -12 -247 -15 -873 -15 l-778 0 -17 27 c-10 15 -183 313 -385 663 l-367 635 763 5 763 5 -127 220 c-70 121 -247 429 -395 685 -147 255 -280 494 -295 531 -44 107 -62 201 -62 329 1 244 97 468 273 636 82 77 140 116 246 166 166 78 152 77 1077 75 l818 -2 61 -105z';

export function BrandMark({
  className,
  title = 'Sitin.ai',
}: {
  className?: string;
  title?: string;
}): ReactNode {
  return (
    <svg
      viewBox="0 0 688 663"
      className={cn('shrink-0', className)}
      fill="none"
      role="img"
      aria-label={title}
    >
      <g transform="translate(-159.165931 836) scale(0.1 -0.1)">
        <path d={SOURCE_PATH} fill="currentColor" />
      </g>
    </svg>
  );
}

export function BrandLockup({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}): ReactNode {
  return (
    <span className={cn('flex items-center gap-[10px]', className)}>
      <span
        className={cn(
          'grid place-items-center rounded-pa-md bg-pa-accent text-pa-on-accent',
          compact ? 'h-[30px] w-[30px] p-[6px]' : 'h-[34px] w-[34px] p-[7px]',
        )}
      >
        <BrandMark className="h-full w-full" />
      </span>
      <span className="text-pa-14 font-bold">Sitin.ai</span>
    </span>
  );
}
