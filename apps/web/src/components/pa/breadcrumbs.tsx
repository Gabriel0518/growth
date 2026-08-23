import Link from 'next/link';
import type { ReactNode } from 'react';

export interface Crumb {
  label: string;
  href?: string;
}

/** 顶栏面包屑。最后一项是当前页，不做链接。 */
export function Breadcrumbs({ items }: { items: Crumb[] }): ReactNode {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-[10px] text-pa-12 text-pa-content-tertiary"
    >
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <span key={item.label} className="flex min-w-0 items-center gap-[10px]">
            {last || item.href === undefined ? (
              <span className="truncate font-semibold text-pa-content">{item.label}</span>
            ) : (
              <>
                <Link href={item.href} className="truncate hover:text-pa-accent hover:underline">
                  {item.label}
                </Link>
                <span aria-hidden="true">/</span>
              </>
            )}
          </span>
        );
      })}
    </nav>
  );
}
