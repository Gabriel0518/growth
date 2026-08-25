'use client';

import { useEffect, useState } from 'react';

import { FieldRenderer } from './field-renderer';
import { SearchableSelect } from './searchable-select';

import { copyAd, fetchAdSets } from '@/lib/client/ad/api';
import { classifyFields } from '@/lib/client/ad/field-types';
import type { AvailablePage, FbAd, FbAdSet, FbCampaign } from '@/lib/client/ad/types';
import { Dropdown } from '@/components/ui/dropdown';

interface Props {
  open: boolean;
  ad: FbAd | null;
  campaigns: FbCampaign[];
  accountId: string;
  availablePages: AvailablePage[];
  onClose: () => void;
  onCopied?: () => void;
}

const STATUS_OPTIONS = [
  { value: 'PAUSED', label: '暂停（PAUSED）' },
  { value: 'ACTIVE', label: '投放中（ACTIVE）' },
  { value: 'INHERITED_FROM_SOURCE', label: '继承源广告' },
];

const RENAME_OPTIONS = [
  { value: 'ONLY_TOP_LEVEL_RENAME', label: '仅重命名顶层' },
  { value: 'DEEP_RENAME', label: '深层重命名（含子级）' },
  { value: 'NO_RENAME', label: '不重命名' },
];

const CTA_OPTIONS = [
  'SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE', 'DOWNLOAD',
  'CONTACT_US', 'BOOK_TRAVEL', 'APPLY_NOW', 'GET_OFFER', 'INSTALL_MOBILE_APP',
];

export function AdCopyDrawer({ open, ad, campaigns, accountId, availablePages, onClose, onCopied }: Props): React.ReactElement | null {
  const [adsetOptions, setAdsetOptions] = useState<{ value: string; label: string; filterText: string }[]>([]);
  const [selectedAdset, setSelectedAdset] = useState('');
  const [statusOption, setStatusOption] = useState('PAUSED');
  const [renameStrategy, setRenameStrategy] = useState('ONLY_TOP_LEVEL_RENAME');
  const [selectedPage, setSelectedPage] = useState('');
  const [pageOptions, setPageOptions] = useState<{ value: string; label: string; filterText: string }[]>([]);

  // 创意覆盖参数
  const [crName, setCrName] = useState('');
  const [crTitle, setCrTitle] = useState('');
  const [crBody, setCrBody] = useState('');
  const [crLinkUrl, setCrLinkUrl] = useState('');
  const [crImageHash, setCrImageHash] = useState('');
  const [crVideoId, setCrVideoId] = useState('');
  const [crCtaType, setCrCtaType] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 初始化 Page 选项（默认选第一个）
  useEffect(() => {
    const opts = availablePages.map((p) => ({
      value: p.id,
      label: p.name,
      filterText: `${p.name} ${p.id}`,
    }));
    setPageOptions(opts);
    const first = opts[0];
    if (first && !selectedPage) {
      setSelectedPage(first.value);
    }
  }, [availablePages, selectedPage]);

  // 加载所有 Campaign 的 AdSet
  useEffect(() => {
    if (!open) return;
    (async () => {
      const result: (FbAdSet & { campaignName: string })[] = [];
      for (const c of campaigns) {
        try {
          const ags = await fetchAdSets(String(c.local_id), accountId);
          for (const ag of ags) {
            result.push({ ...ag, campaignName: c.name });
          }
        } catch { /* skip */ }
      }
      setAdsetOptions([
        { value: '', label: '原广告组（不迁移）', filterText: '原广告组 不迁移' },
        ...result.map((a) => ({
          value: a.id,
          label: `[${a.campaignName}]${a.name}`,
          filterText: `${a.campaignName} ${a.name} ${a.id}`,
        })),
      ]);
    })().catch(() => { /* SSR */ });
  }, [open, campaigns, accountId]);

  if (!open || !ad) return null;

  const fields = classifyFields(ad.channel_extra);

  async function handleCopy(): Promise<void> {
    if (!ad) return;
    setBusy(true);
    setError('');
    try {
      // 构建 creative_parameters
      const creativeParams: Record<string, unknown> = {};
      if (crName) creativeParams['name'] = crName;
      if (crTitle) creativeParams['title'] = crTitle;
      if (crBody) creativeParams['body'] = crBody;
      if (crLinkUrl) creativeParams['link_url'] = crLinkUrl;
      if (crImageHash) creativeParams['image_hash'] = crImageHash;
      if (crVideoId) creativeParams['video_id'] = crVideoId;
      if (crCtaType) creativeParams['call_to_action_type'] = crCtaType;

      const body: Record<string, unknown> = {
        status_option: statusOption,
        rename_strategy: renameStrategy,
      };
      if (selectedAdset) body['adset_id'] = selectedAdset;
      if (selectedPage) body['page_id'] = selectedPage;
      if (Object.keys(creativeParams).length > 0) body['creative_parameters'] = creativeParams;

      await copyAd(ad.id, accountId, body);
      onCopied?.();
      onClose();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '复制失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[9000] flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-[85vw] border-l border-border bg-bg-dark shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="font-bold text-text">复制广告 — {ad.name}</h3>
          <button type="button" onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-xs text-text-dim hover:border-accent hover:text-accent">
            关闭
          </button>
        </div>

        {/* Body — 左右布局 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左栏：原始广告详情 */}
          <div className="w-[45%] overflow-auto border-r border-border px-4 py-3">
            <div className="mb-2 text-sm font-semibold text-text-dim">原始广告详情</div>
            <div className="space-y-1">
              {fields.map((f) => (
                <FieldRenderer key={f.key} field={{ ...f, mode: 'readonly' as const }} onChange={undefined} />
              ))}
            </div>
          </div>

          {/* 右栏：复制参数 + 创意覆盖 */}
          <div className="w-[55%] overflow-auto px-4 py-3 flex flex-col">
            {/* 复制参数 */}
            <div className="mb-4">
              <div className="mb-2 text-sm font-semibold text-text-dim">复制参数</div>
              <div className="space-y-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-dim">目标 AdSet</span>
                  <SearchableSelect
                    options={adsetOptions}
                    value={selectedAdset}
                    placeholder="原广告组（不迁移）"
                    onChange={setSelectedAdset}
                  />
                </label>
                {availablePages.length > 0 ? (
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-text-dim">发布 Page</span>
                    <SearchableSelect
                      options={pageOptions}
                      value={selectedPage}
                      placeholder="选择发布 Page…"
                      onChange={setSelectedPage}
                    />
                  </label>
                ) : (
                  <div className="rounded-md border border-yellow/30 bg-yellow/10 px-3 py-2 text-xs text-yellow">
                    当前 Token 无可用 Page，无法复制广告
                  </div>
                )}
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-dim">新广告状态</span>
                  <Dropdown tone="legacy" aria-label="新广告状态" value={statusOption} onChange={setStatusOption} options={STATUS_OPTIONS} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-dim">重命名策略</span>
                  <Dropdown tone="legacy" aria-label="重命名策略" value={renameStrategy} onChange={setRenameStrategy} options={RENAME_OPTIONS} />
                </label>
              </div>
            </div>

            {/* 创意覆盖参数 */}
            <div className="mb-4">
              <div className="mb-2 text-sm font-semibold text-text-dim">创意覆盖参数（留空表示不覆盖）</div>
              <div className="space-y-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-dim">名称（name）</span>
                  <input type="text" value={crName} onChange={(e) => { setCrName(e.target.value); }}
                    placeholder="覆盖创意名称"
                    className="w-full rounded border border-border bg-bg-card px-2 py-1.5 text-xs text-text outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-dim">标题（title）</span>
                  <input type="text" value={crTitle} onChange={(e) => { setCrTitle(e.target.value); }}
                    placeholder="覆盖链接标题"
                    className="w-full rounded border border-border bg-bg-card px-2 py-1.5 text-xs text-text outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-dim">正文（body）</span>
                  <input type="text" value={crBody} onChange={(e) => { setCrBody(e.target.value); }}
                    placeholder="覆盖正文"
                    className="w-full rounded border border-border bg-bg-card px-2 py-1.5 text-xs text-text outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-dim">落地页链接（link_url）</span>
                  <input type="text" value={crLinkUrl} onChange={(e) => { setCrLinkUrl(e.target.value); }}
                    placeholder="https://..."
                    className="w-full rounded border border-border bg-bg-card px-2 py-1.5 text-xs text-text outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-dim">图片 Hash（image_hash）</span>
                  <input type="text" value={crImageHash} onChange={(e) => { setCrImageHash(e.target.value); }}
                    placeholder="覆盖图片"
                    className="w-full rounded border border-border bg-bg-card px-2 py-1.5 text-xs text-text outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-dim">视频 ID（video_id）</span>
                  <input type="text" value={crVideoId} onChange={(e) => { setCrVideoId(e.target.value); }}
                    placeholder="覆盖视频"
                    className="w-full rounded border border-border bg-bg-card px-2 py-1.5 text-xs text-text outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-text-dim">CTA 类型</span>
                  <Dropdown tone="legacy" aria-label="CTA 类型" value={crCtaType} onChange={setCrCtaType} options={[{ value: '', label: '不覆盖' }, ...CTA_OPTIONS.map((o) => ({ value: o, label: o }))]} />
                </label>
              </div>
            </div>

            {error ? (
              <div className="rounded-md border border-red/30 bg-red/10 px-3 py-2 text-xs text-red mb-3">
                {error}
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-2 border-t border-border/30 mt-auto">
              <button type="button" onClick={onClose}
                className="rounded-md border border-border px-4 py-2 text-sm text-text-dim hover:border-accent hover:text-accent">
                取消
              </button>
              <button type="button" onClick={() => { void handleCopy(); }} disabled={busy || (availablePages.length > 0 && !selectedPage)}
                className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85 disabled:opacity-50">
                {busy ? '复制中…' : '提交复制'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
