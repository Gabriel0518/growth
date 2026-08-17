'use client';

import { useEffect, useRef, useState } from 'react';

import { apiUrl, getJson } from '@/lib/client/api';

export interface AiAdviceTarget {
  campaign: string;
  product: string;
  channel: string;
  operator: string;
  date: string;
}

interface HistoryDay {
  date: string;
  cost: number;
  cpm: number;
  cpc: number;
  cpi: number;
  newUserRevenue: number;
  correctedNewUserRevenue: number;
  correctionFactor: number;
  newUserROAS: number;
  newUserEltvROAS: number;
}

interface RealtimeRow {
  date: string;
  snapshotTime?: string;
  cost: number;
  cpm: number;
  cpc: number;
  cpi: number;
  newUserRevenue: number;
  correctedNewUserRevenue: number;
  correctionFactor: number;
  newUserROAS: number;
  eltvD180?: number | string;
  newUserEltvROAS: number;
  eltvConfidence?: string;
  breakevenROAS?: number | null;
}

interface StructuredInput {
  campaign: string;
  product: string;
  channel: string;
  historyDays: HistoryDay[];
  realtime: RealtimeRow;
}

interface CampaignContext {
  structuredInput?: StructuredInput;
  messages: unknown;
}

interface LlmMessage {
  content?: string;
  reasoning_content?: string;
}

interface LlmResponse {
  choices?: { message?: LlmMessage }[];
}

function confTag(c: string | undefined): string {
  if (c === 'green') return '🟢可信';
  if (c === 'yellow') return '🟡供参考';
  return '🔴不可信';
}

function f3(v: number): string {
  const s = String(v);
  const dot = s.indexOf('.');
  return dot === -1 ? s : s.slice(0, dot + 4);
}

/** 显示宽度：CJK 记 1.6，ASCII 记 1，复刻旧对齐算法。 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) != null && (ch.codePointAt(0) ?? 0) > 0x7f ? 1.6 : 1;
  return Math.ceil(w);
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

function buildInputText(si: StructuredInput): string {
  const headers = ['日期', '消耗', 'CPM', 'CPC', 'CPI', '新用户收入', '修正后收入', '修正系数', '新用户ROAS', 'eLTV_ROAS'];
  const rows = si.historyDays.map((d) => [
    d.date.slice(5),
    `$${f3(d.cost)}`,
    `$${f3(d.cpm)}`,
    `$${f3(d.cpc)}`,
    `$${f3(d.cpi)}`,
    `$${f3(d.newUserRevenue)}`,
    `$${f3(d.correctedNewUserRevenue)}`,
    f3(d.correctionFactor),
    `${(d.newUserROAS * 100).toFixed(1)}%`,
    `${(d.newUserEltvROAS * 100).toFixed(1)}%`,
  ]);
  const colW = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))));
  const fmtRow = (cells: string[]): string => `| ${cells.map((c, i) => pad(c, colW[i] ?? 0)).join(' | ')} |`;
  const sepRow = `|${colW.map((w) => '-'.repeat(w + 2)).join('|')}|`;

  let text = `Campaign: ${si.campaign}\nProduct: ${si.product}\nChannel: ${si.channel}\n\n`;
  text += `=== 过去7天每日数据 ===\n`;
  text += `${fmtRow(headers)}\n`;
  text += `${sepRow}\n`;
  for (const r of rows) text += `${fmtRow(r)}\n`;
  const rt = si.realtime;
  text += `\n=== 今天实时数据 (截至 ${rt.snapshotTime ?? '?'}) ===\n`;
  text += `日期: ${rt.date}\n`;
  text += `消耗: $${f3(rt.cost)}\n`;
  text += `CPM: $${f3(rt.cpm)}\n`;
  text += `CPC: $${f3(rt.cpc)}\n`;
  text += `CPI: $${f3(rt.cpi)}\n`;
  text += `新用户收入: $${f3(rt.newUserRevenue)}\n`;
  text += `修正后收入: $${f3(rt.correctedNewUserRevenue)}\n`;
  text += `修正系数: ${f3(rt.correctionFactor)}\n`;
  text += `新用户ROAS: ${(rt.newUserROAS * 100).toFixed(1)}%\n`;
  text += `eLTV D180: ${rt.eltvD180 == null ? 'N/A' : String(rt.eltvD180)}\n`;
  text += `eLTV ROAS: ${(rt.newUserEltvROAS * 100).toFixed(1)}% ${confTag(rt.eltvConfidence)}\n`;
  if (rt.breakevenROAS != null) {
    text += `回本ROAS: ${rt.breakevenROAS.toString()}%${rt.eltvConfidence === 'yellow' ? '（已含5%风险调整）' : ''}\n`;
  }
  return text;
}

/** AI 投放建议弹窗：先取 campaign-context 构建结构化输入，再调 /api/llm/chat 非流式生成建议。 */
export function AiAdviceModal({
  target,
  onClose,
}: {
  target: AiAdviceTarget;
  onClose: () => void;
}): React.ReactElement {
  const [statusText, setStatusText] = useState('正在获取 campaign 数据...');
  const [statusKind, setStatusKind] = useState<'loading' | 'done' | 'error'>('loading');
  const [inputText, setInputText] = useState('');
  const [response, setResponse] = useState('');
  const [thinking, setThinking] = useState('');
  const [showThinking, setShowThinking] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();

    async function run(): Promise<void> {
      try {
        const { campaign, product, channel, operator, date } = target;
        const ctxUrl = `/api/campaign-context?campaign=${encodeURIComponent(campaign)}&product=${encodeURIComponent(product)}&channel=${encodeURIComponent(channel)}&operator=${encodeURIComponent(operator)}&date=${encodeURIComponent(date)}`;
        const campData = await getJson<CampaignContext>(ctxUrl, controller.signal);
        if (campData.structuredInput) setInputText(buildInputText(campData.structuredInput));

        setStatusText('AI 正在生成建议，请耐心等待（约30-60秒）...');
        const llmRes = await fetch(apiUrl('/api/llm/chat'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: campData.messages, stream: false, temperature: 0.7, max_tokens: 4096 }),
          signal: controller.signal,
        });
        if (!llmRes.ok) {
          const errText = await llmRes.text().catch(() => '');
          throw new Error(`LLM 调用失败: ${llmRes.status.toString()} ${errText.slice(0, 100)}`);
        }
        const llmData = (await llmRes.json()) as LlmResponse;
        const choice = llmData.choices?.[0];
        if (!choice) throw new Error('LLM 返回为空');
        if (choice.message?.reasoning_content != null) setThinking(choice.message.reasoning_content);
        setResponse(choice.message?.content ?? '');
        setStatusText('✅ 建议生成完毕');
        setStatusKind('done');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setStatusText(`❌ ${error instanceof Error ? error.message : String(error)}`);
        setStatusKind('error');
      }
    }

    void run();
    return () => {
      controller.abort();
    };
  }, [target]);

  const statusCls = statusKind === 'error' ? 'text-red' : statusKind === 'done' ? 'text-green' : 'text-text-dim';

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-[820px] max-w-[95vw] flex-col rounded-xl border border-border bg-bg-card p-6 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="text-sm text-text-dim">
            <span className="font-bold text-text">{target.campaign}</span>
            <span className="ml-2 text-text-muted">
              {target.product} · {target.channel} · {target.date}
            </span>
          </div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text">
            ✕
          </button>
        </div>
        <div className={`mb-3 flex items-center gap-2 text-sm ${statusCls}`}>{statusText}</div>
        {inputText ? (
          <details className="mb-3">
            <summary className="cursor-pointer text-xs text-text-muted">输入数据</summary>
            <textarea
              readOnly
              value={inputText}
              className="mt-2 h-40 w-full resize-y rounded-md border border-border bg-bg-dark p-2 font-mono text-[0.7rem] text-text-dim"
            />
          </details>
        ) : null}
        {thinking ? (
          <div className="mb-2">
            <button
              type="button"
              onClick={() => {
                setShowThinking((v) => !v);
              }}
              className="text-xs text-text-muted hover:text-accent"
            >
              {showThinking ? '💭 隐藏推理过程' : '💭 显示推理过程'}
            </button>
            {showThinking ? (
              <pre className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border bg-bg-dark p-2 text-[0.72rem] whitespace-pre-wrap text-text-muted">
                {thinking}
              </pre>
            ) : null}
          </div>
        ) : null}
        <div className="overflow-y-auto rounded-md border border-border bg-bg-dark p-3 text-sm whitespace-pre-wrap text-text">
          {response}
        </div>
      </div>
    </div>
  );
}
