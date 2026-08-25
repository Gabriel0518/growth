'use client';

import { useCallback, useEffect, useState } from 'react';

import { createCreative, fetchCreatives, fetchMaterials, fetchPages } from '@/lib/client/ad/api';
import type { AvailablePage, CreativeItem, MaterialUploadItem } from '@/lib/client/ad/types';
import { Dropdown } from '@/components/ui/dropdown';

/** 创意面板：选 Page + 选素材 → 创建 FB Creative。 */
export function AdCreativePanel({ accountId }: { accountId: string }): React.ReactElement {
  const [creatives, setCreatives] = useState<CreativeItem[]>([]);
  const [pages, setPages] = useState<AvailablePage[]>([]);
  const [materials, setMaterials] = useState<MaterialUploadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 表单
  const [selectedPage, setSelectedPage] = useState('');
  const [selectedUpload, setSelectedUpload] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [c, p, m] = await Promise.all([fetchCreatives(), fetchPages(accountId), fetchMaterials('fb')]);
      setCreatives(c);
      setPages(p);
      // 展平所有 materials 的 FB uploads
      const uploads: MaterialUploadItem[] = m.flatMap((mat) =>
        mat.uploads.filter((u) => u.channel === 'fb' && u.status === 'ready'),
      );
      setMaterials(uploads);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleCreate(): Promise<void> {
    if (!selectedPage || !selectedUpload) {
      setError('请选择 Page 和素材');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await createCreative({
        material_upload_id: selectedUpload,
        page_id: selectedPage,
      });
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="text-sm text-text-muted">加载中…</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-text">广告创意</h2>

      {/* 新建创意表单 */}
      <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-bg-card p-4">
        <label className="flex flex-col gap-1 text-sm">
          选择 Page
          <Dropdown tone="legacy" className="w-[260px]" aria-label="选择 Page" value={selectedPage} onChange={setSelectedPage} options={[{ value: '', label: '-- 选择 Page --' }, ...pages.filter((p) => p.source === 'owned').map((p) => ({ value: p.id, label: `自有 · ${p.name}` })), ...pages.filter((p) => p.source === 'partner').map((p) => ({ value: p.id, label: `合作方 · ${p.name}` }))]} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          选择素材（已同步 FB 且就绪）
          <Dropdown tone="legacy" className="w-[300px]" aria-label="选择素材" value={selectedUpload} onChange={setSelectedUpload} options={[{ value: '', label: '-- 选择素材 --' }, ...materials.map((u) => ({ value: String(u.id), label: u.channel_material_id ?? String(u.id) }))]} />
        </label>
        <button
          type="button"
          onClick={() => {
            void handleCreate();
          }}
          disabled={busy}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85 disabled:opacity-50"
        >
          {busy ? '创建中…' : '创建创意'}
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">
          {error}
        </div>
      ) : null}

      {/* 已创建创意列表 */}
      {creatives.length === 0 ? (
        <div className="text-sm text-text-muted">暂无创意，请先创建。</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="px-3 py-2 font-medium">FB Creative ID</th>
                <th className="px-3 py-2 font-medium">Page</th>
                <th className="px-3 py-2 font-medium">素材 ID</th>
                <th className="px-3 py-2 font-medium">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {creatives.map((c) => (
                <tr key={c.id} className="border-b border-border/50">
                  <td className="px-3 py-2 font-mono text-xs text-accent">
                    {c.channel_creative_id ?? '--'}
                  </td>
                  <td className="px-3 py-2">{c.page_id ?? '--'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-text-dim">
                    {c.channel_material_id}
                  </td>
                  <td className="px-3 py-2 text-text-dim">{c.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
