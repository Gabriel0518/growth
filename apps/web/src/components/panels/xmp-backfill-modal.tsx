'use client';

import { useState } from 'react';

interface BackfillMsg {
  date?: string;
  status?: string;
  attempt?: number;
  maxRetries?: number;
  missingChannels?: string[];
  completed?: number;
  total?: number;
}

interface DateState {
  icon: string;
  note: string;
}

const START_ICON = '\u2B1C';

function iconFor(status: string | undefined): string | null {
  if (status === 'fetching') return '\u23F3';
  if (status === 'retrying') return '\uD83D\uDD04';
  if (status === 'done') return '\u2705';
  if (status === 'partial') return '\u26A0\uFE0F';
  if (status === 'error') return '\u274C';
  return null;
}

/** XMP 缓存一键补全弹窗：流式（换行分隔 JSON）读 /api/xmp-backfill，逐日期更新图标与进度。 */
export function XmpBackfillModal({
  dates,
  onClose,
  onComplete,
}: {
  dates: string[];
  onClose: () => void;
  onComplete: () => void;
}): React.ReactElement {
  const [states, setStates] = useState<Record<string, DateState>>(() => {
    const init: Record<string, DateState> = {};
    for (const d of dates) init[d] = { icon: START_ICON, note: '' };
    return init;
  });
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [startLabel, setStartLabel] = useState('\uD83D\uDE80 \u5F00\u59CB\u8865\u5168');
  const [running, setRunning] = useState(false);

  const estSeconds = dates.length * 15;
  const estText = estSeconds < 60 ? `~${estSeconds.toString()}\u79D2` : `~${Math.ceil(estSeconds / 60).toString()} \u5206\u949F`;

  function applyMsg(msg: BackfillMsg): void {
    if (msg.date != null) {
      const date = msg.date;
      const icon = iconFor(msg.status);
      setStates((prev) => {
        const cur = prev[date] ?? { icon: START_ICON, note: '' };
        let note = cur.note;
        switch (msg.status) {
        case 'retrying': {
          const missing = msg.missingChannels ? ` (${msg.missingChannels.join('/')})` : '';
          note = ` \u91CD\u8BD5${(msg.attempt ?? 0).toString()}/${(msg.maxRetries ?? 0).toString()}${missing}`;
        
        break;
        }
        case 'done': {
          note = '';
        
        break;
        }
        case 'partial': {
          note = ' \u90E8\u5206\u6E20\u9053\u672A\u8865\u5168';
        
        break;
        }
        // No default
        }
        return { ...prev, [date]: { icon: icon ?? cur.icon, note } };
      });
    }
    if (msg.total != null && msg.completed != null) {
      setProgress({ completed: msg.completed, total: msg.total });
    }
    if (msg.status === 'complete') {
      setStartLabel('\u2705 \u5B8C\u6210');
      onComplete();
      setTimeout(onClose, 1500);
    }
  }

  async function start(): Promise<void> {
    setRunning(true);
    setStartLabel('\u2708\uFE0F \u8865\u5168\u4E2D...');
    setProgress({ completed: 0, total: dates.length });
    try {
      const resp = await fetch('/api/xmp-backfill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dates }),
      });
      const reader = resp.body?.getReader();
      if (!reader) throw new Error('no stream');
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            applyMsg(JSON.parse(line) as BackfillMsg);
          } catch {
            /* 忽略半行/坏行 */
          }
        }
      }
    } catch (error) {
      setStartLabel('\u274C \u5931\u8D25');
      setRunning(false);
      console.error('Backfill error:', error);
    }
  }

  const pct = progress && progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[420px] max-w-[90vw] rounded-xl border border-white/10 bg-[#1e1e2e] p-7 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <h3 className="mb-4 text-lg font-bold text-text">
          {'\u26A0\uFE0F'} 缺少 {dates.length} 天 XMP 缓存
        </h3>
        <div className="mb-4 max-h-[240px] overflow-y-auto">
          {dates.map((d) => {
            const st = states[d] ?? { icon: START_ICON, note: '' };
            return (
              <div key={d} className="flex items-center gap-2 py-1 text-sm text-text-dim">
                <span>{st.icon}</span> {d}
                {st.note ? <span className="text-text-muted">{st.note}</span> : null}
              </div>
            );
          })}
        </div>
        <div className="mb-4 text-sm text-text-dim">
          <p>
            点击下方按钮一键补全缓存，预计等待 <strong className="text-text">{estText}</strong>
          </p>
          <p className="mt-1 text-xs text-text-muted">
            每个日期会确认 FB/GG/TT 三渠道全部补全，遇到限频自动重试（最多2次，每次等60s）
          </p>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={running}
            onClick={() => void start()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark disabled:opacity-60"
          >
            {startLabel}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-bg-card px-4 py-2 text-sm text-text-dim"
          >
            关闭
          </button>
        </div>
        {progress ? (
          <div className="mt-4 flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-accent transition-all" style={{ width: `${pct.toString()}%` }} />
            </div>
            <span className="text-xs text-text-dim">
              {progress.completed}/{progress.total}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
