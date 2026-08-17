'use client';

import { useMemo } from 'react';

import { FieldRenderer } from './field-renderer';

import type { FieldDef } from '@/lib/client/ad/field-types';
import { classifyFields } from '@/lib/client/ad/field-types';


interface Props {
  open: boolean;
  title: string;
  channelExtra: Record<string, unknown>;
  onClose: () => void;
  onFieldChange?: (key: string, value: unknown) => void;
}

/** 详情 Drawer：解析 channel_extra JSONB 并按字段类型分模式展示。 */
export function AdDetailDrawer({
  open,
  title,
  channelExtra,
  onClose,
  onFieldChange,
}: Props): React.ReactElement | null {
  if (!open) return null;

  const fields: FieldDef[] = useMemo(() => classifyFields(channelExtra), [channelExtra]);

  return (
    <div className="fixed inset-0 z-[9000] flex">
      {/* 遮罩 */}
      <div className="flex-1 bg-black/40" onClick={onClose} />
      {/* Drawer */}
      <div className="w-[80vw] border-l border-border bg-bg-dark shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="font-bold text-text">{title}</h3>
          <button type="button" onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-xs text-text-dim hover:border-accent hover:text-accent">
            关闭
          </button>
        </div>
        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {fields.length === 0 ? (
            <div className="text-sm text-text-dim">无可用数据。</div>
          ) : (
            <div className="space-y-1">
              {fields.map((f) => (
                <FieldRenderer key={f.key} field={f} onChange={onFieldChange} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
