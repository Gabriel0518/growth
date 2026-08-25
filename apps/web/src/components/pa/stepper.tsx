import type { ReactNode } from 'react';

import { cn } from '@/components/ui';

/** 创建向导的两步指示器。已完成的步骤打勾，不再显示序号。 */
export function Stepper({ steps, active }: { steps: string[]; active: number }): ReactNode {
  return (
    <div className="mb-pa-5 flex items-center gap-[12px] rounded-pa-lg border border-pa-border bg-pa-surface px-pa-4 py-[12px]">
      {steps.map((label, index) => {
        const n = index + 1;
        const done = n < active;
        const current = n === active;
        return (
          <div key={label} className="flex shrink-0 items-center gap-[10px]">
            {index > 0 && <span className="h-px w-[clamp(42px,8vw,96px)] bg-pa-border" />}
            <span
              className={cn(
                'flex items-center gap-[10px] text-pa-13',
                current ? 'font-semibold text-pa-content' : 'text-pa-content-tertiary',
              )}
            >
              <span
                className={cn(
                  'grid h-[24px] w-[24px] place-items-center rounded-pa-full text-pa-11 font-bold',
                  done && 'bg-pa-positive text-white',
                  current && 'bg-pa-accent text-white',
                  !done && !current && 'bg-pa-surface-muted',
                )}
              >
                {done ? (
                  <svg
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-[12px] w-[12px]"
                    aria-hidden="true"
                  >
                    <path d="M1.5 6.3l3 3 6-6.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  n
                )}
              </span>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
