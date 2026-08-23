import type { ReactNode } from 'react';

import type { LogEntry } from '@/lib/pa/types';

/** 自动化日志的一行。时间戳用 mono 保证纵向对齐。 */
export function LogRow({ entry }: { entry: LogEntry }): ReactNode {
  return (
    <div className="grid grid-cols-[46px_1fr] gap-pa-3 border-b border-pa-border-subtle py-pa-3 last:border-b-0">
      <time className="font-pa-mono text-pa-10 text-pa-content-tertiary">{entry.t}</time>
      <div className="min-w-0">
        <b className="text-pa-12">{entry.title}</b>
        <span className="mt-px block text-pa-11 text-pa-content-tertiary">{entry.sub}</span>
      </div>
    </div>
  );
}
