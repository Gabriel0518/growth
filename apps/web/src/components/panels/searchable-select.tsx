'use client';

import { useEffect, useRef, useState } from 'react';

interface Option<T> {
  value: string;
  label: string;
  filterText: string; // 搜索时匹配的文本
  extra?: T;
}

interface Props<T> {
  options: Option<T>[];
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}

/** 可搜索下拉选择器。支持键盘输入筛选，点击外部自动关闭。 */
export function SearchableSelect<T = undefined>({
  options,
  value,
  placeholder = '搜索…',
  onChange,
}: Props<T>): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 点击外部关闭
  useEffect(() => {
    function handleClick(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('mousedown', handleClick);
    };
  }, []);

  const selected = options.find((o) => o.value === value);

  const filtered = query
    ? options.filter((o) => o.filterText.toLowerCase().includes(query.toLowerCase()))
    : options;

  function handleSelect(val: string): void {
    onChange(val);
    setOpen(false);
    setQuery('');
  }

  return (
    <div ref={containerRef} className="relative">
      {/* 输入框 / 选中展示 */}
      {open ? (
        <input
          ref={inputRef}
          type="text"
          autoFocus
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              setQuery('');
            }
            if (e.key === 'Enter' && filtered.length > 0) {
              const first = filtered[0];
              if (first) handleSelect(first.value);
            }
          }}
          placeholder={placeholder}
          className="unified-select w-[280px] border-accent bg-bg-dark"
        />
      ) : (
        <button
          type="button"
          onClick={() => { setOpen(true); }}
          className="unified-select w-[280px] truncate border-border bg-bg-dark text-left transition-colors hover:border-accent/50"
        >
          {selected ? (
            <span className="whitespace-nowrap">{selected.label}</span>
          ) : (
            <span className="text-text-dim">{placeholder}</span>
          )}
        </button>
      )}

      {/* 下拉列表 */}
      {open ? (
        <div className="absolute top-full left-0 z-[100] mt-1 max-h-48 w-[380px] overflow-auto rounded-pa-md border border-border bg-bg-card p-1 shadow-pa-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-dim">无匹配结果</div>
          ) : (
            filtered.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => { handleSelect(o.value); }}
                className={`flex min-h-[36px] w-full truncate rounded-pa-sm px-3 py-1.5 text-left text-xs whitespace-nowrap transition-colors ${
                  o.value === value
                    ? 'bg-accent/10 font-semibold text-accent'
                    : 'text-text hover:bg-bg-dark'
                }`}
              >
                {o.label}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── 广告账户状态映射 ──

const ACCOUNT_STATUS_LABELS: Record<number, string> = {
  1: '正常',
  2: '已禁用',
  3: '未结算',
  7: '审核中',
  9: '宽限期',
  100: '待关闭',
  101: '暂不可用',
};

/** 生成下拉选项的 label 和 filterText */
export function buildAccountOption(account: {
  accountId: string;
  accountName: string;
  accountStatus: number;
  tokenName: string;
}): Option<undefined> {
  const status = ACCOUNT_STATUS_LABELS[account.accountStatus] ?? String(account.accountStatus);
  return {
    value: account.accountId,
    label: `[${status}][${account.tokenName}]${account.accountName}`,
    filterText: `${status} ${account.tokenName} ${account.accountName} ${account.accountId}`,
  };
}
