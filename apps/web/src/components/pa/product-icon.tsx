import type { ReactNode } from 'react';

import { cn } from '@/components/ui';
import type { Product } from '@/lib/pa/types';

/** 产品图标是真实 PNG（八个 app 的品牌标识），不是程序化生成的占位。 */
// 用原生 <img> 而不是 next/image：八个静态本地图标，尺寸固定且已知，
// next/image 的优化流水线在这里只增加运行时开销，换不来任何收益。
export function ProductIcon({
  product,
  size = 36,
  className,
}: {
  product: Product;
  size?: number;
  className?: string;
}): ReactNode {
  return (
    <img
      src={`/pa/icons/${product.icon}.png`}
      alt=""
      width={size}
      height={size}
      className={cn(
        'shrink-0 border border-pa-border-subtle bg-pa-surface-muted object-cover',
        className,
      )}
      style={{ width: size, height: size, borderRadius: size >= 48 ? 13 : size >= 32 ? 8 : 6 }}
    />
  );
}
