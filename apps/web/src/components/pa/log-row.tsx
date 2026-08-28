import type { ReactNode } from 'react';

import { cn } from '@/components/ui';
import type { LogEntry } from '@/lib/pa/types';

/** 自动化日志的一行。时间戳用 mono 保证纵向对齐。 */
export function LogRow({ entry, fresh = false }: { entry: LogEntry; fresh?: boolean }): ReactNode {
  return (
    <div
      className={cn(
        'grid grid-cols-[46px_1fr] gap-pa-3 border-b border-pa-border-subtle py-pa-3 last:border-b-0',
        fresh && 'pa-log-new',
      )}
    >
      <time className="font-pa-mono text-pa-10 text-pa-content-tertiary">{entry.t}</time>
      <div className="min-w-0">
        <b className="text-pa-13 font-semibold text-pa-content">{entry.title}</b>
        <span className="mt-px block text-pa-11 text-pa-content-tertiary">{entry.sub}</span>
      </div>
    </div>
  );
}
