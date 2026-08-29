'use client';

import { useState } from 'react';

import type { FieldDef } from '@/lib/client/ad/field-types';
import { Dropdown } from '@/components/ui/dropdown';

interface Props {
  field: FieldDef;
  onChange: ((key: string, value: unknown) => void) | undefined;
}

/** 单字段渲染器：根据 DisplayMode 渲染不同的输入控件。 */
export function FieldRenderer({ field, onChange }: Props): React.ReactElement {
  const [edit, setEdit] = useState(false);
  const [inputValue, setInputValue] = useState(formatValue(field.value));

  function commit(): void {
    const parsed = field.value === null || field.value === undefined
      ? inputValue
      : typeof field.value === 'number'
        ? (Number.isNaN(Number(inputValue)) ? inputValue : Number(inputValue))
        : inputValue;
    onChange?.(field.key, parsed);
    setEdit(false);
  }

  return (
    <div className="items-start gap-3 border-b border-border/30 py-2 text-sm" title={field.key}>
      <span className="w-[180px] flex-shrink-0 font-medium text-text-dim">{field.label}</span>

      {/* readonly */}
      {field.mode === 'readonly' ? (
        <span className="flex-1 break-all text-xs text-text-dim font-mono whitespace-pre-wrap">
          {formatValue(field.value)}
        </span>
      ) : null}

      {/* text — 可编辑输入框 */}
      {field.mode === 'text' ? (
        edit ? (
          <input
            type="text"
            value={inputValue}
            onChange={(e) => { setInputValue(e.target.value); }}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEdit(false); }}
            autoFocus
            className="flex-1 rounded border border-accent bg-bg-dark px-2 py-1 text-xs text-text outline-none"
          />
        ) : (
          <span
            className="flex-1 cursor-pointer break-all text-xs text-text hover:text-accent whitespace-pre-wrap"
            onClick={() => { setEdit(true); }}
          >
            {formatValue(field.value)}
          </span>
        )
      ) : null}

      {/* select — 单选搜索下拉 */}
      {field.mode === 'select' ? (
        <SelectDropdown
          value={formatValue(field.value)}
          options={field.options ?? ['true', 'false']}
          onChange={(v) => { onChange?.(field.key, v); }}
        />
      ) : null}

      {/* multi — 多选搜索下拉 */}
      {field.mode === 'multi' ? (
        <MultiSelectDropdown
          selected={(Array.isArray(field.value) ? field.value : []) as string[]}
          options={field.options ?? (Array.isArray(field.value) ? (field.value as string[]) : [])}
          onChange={(vals) => { onChange?.(field.key, vals); }}
        />
      ) : null}
    </div>
  );
}

// ── 内联组件 ──

function SelectDropdown({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <Dropdown tone="legacy" className="flex-1" aria-label="Select value" value={value} options={options.map((option) => ({ value: option, label: option }))} onChange={onChange} />
  );
}

function MultiSelectDropdown({
  selected,
  options,
  onChange,
}: {
  selected: string[];
  options: string[];
  onChange: (vals: string[]) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const allOptions = [...new Set([...options, ...selected])];
  const filtered = query
    ? allOptions.filter((o) => o.toLowerCase().includes(query.toLowerCase()))
    : allOptions;

  function toggle(v: string): void {
    if (selected.includes(v)) {
      onChange(selected.filter((s) => s !== v));
    } else {
      onChange([...selected, v]);
    }
  }

  return (
    <div className="relative flex-1">
      <button type="button" onClick={() => { setOpen(!open); }}
        className="unified-select w-full truncate border-border bg-bg-card px-2 text-left text-xs text-text">
        {selected.length === 0 ? '--' : `${String(selected.length)} 个已选`}
      </button>
      {open ? (
        <div className="absolute top-full left-0 z-50 mt-1 w-full overflow-auto rounded-pa-md border border-border bg-bg-dark p-1 shadow-pa-2">
          <input type="text" value={query} onChange={(e) => { setQuery(e.target.value); }}
            placeholder="搜索…" autoFocus
            className="unified-select mb-1 min-h-[36px] border-border bg-bg-dark px-2 text-xs text-text" />
          <div className="max-h-40 overflow-auto">
            {filtered.map((o) => (
              <label key={o}
                className={`flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-pa-sm px-2 py-1 text-xs hover:bg-bg-card ${
                  selected.includes(o) ? 'text-accent' : 'text-text'
                }`}>
                <input type="checkbox" checked={selected.includes(o)}
                  onChange={() => { toggle(o); }} className="sr-only" />
                {selected.includes(o) ? '☑' : '☐'} {o}
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── 工具 ──

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '--';
  /* eslint-disable @typescript-eslint/no-base-to-string */
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
  /* eslint-enable @typescript-eslint/no-base-to-string */
}
