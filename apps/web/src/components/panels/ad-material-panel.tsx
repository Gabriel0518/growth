'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  createMaterial,
  fetchAccountMaterials,
  fetchMaterials,
  syncAccountMaterials,
  syncMaterial,
} from '@/lib/client/ad/api';
import type { AccountMaterialItem, MaterialWithUploads } from '@/lib/client/ad/types';

function formatDuration(ms: number | null): string {
  if (!ms) return '—';
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m)}:${String(s).padStart(2, '0')}`;
}

function formatSize(w: number | null, h: number | null): string {
  if (!w || !h) return '—';
  return `${String(w)}×${String(h)}`;
}

/** 素材库面板：展示素材列表、新添素材 URL、同步到 Facebook。 */
export function AdMaterialPanel({ accountId }: { accountId: string }): React.ReactElement {
  const [materials, setMaterials] = useState<MaterialWithUploads[]>([]);
  const [accountMaterials, setAccountMaterials] = useState<AccountMaterialItem[]>([]);
  const [matPage, setMatPage] = useState(1);
  const [matTotal, setMatTotal] = useState(0);
  const [matPageSize] = useState(24);
  const [matCollapsed, setMatCollapsed] = useState(true);
  const matTotalPages = Math.max(1, Math.ceil(matTotal / matPageSize));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchMaterials();
      setMaterials(data);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadAccountMaterials = useCallback(async (p = 1) => {
    try {
      const result = await fetchAccountMaterials(accountId, p, matPageSize);
      setAccountMaterials(result.data);
      setMatTotal(result.total);
      setMatPage(result.page);
    } catch { /* 非关键 */ }
  }, [accountId, matPageSize]);

  useEffect(() => {
    void reload();
    void reloadAccountMaterials(1);
  }, [reload, reloadAccountMaterials]);

  async function handleRegister(): Promise<void> {
    if (!fileUrl || !name) {
      setError('CDN 地址和文件名不能为空');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await createMaterial({ file_url: fileUrl, name });
      setFileUrl('');
      setName('');
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '注册失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleSync(id: number): Promise<void> {
    setError('');
    try {
      await syncMaterial(id, 'fb', accountId);
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '同步失败');
    }
  }

  async function handleAccountSync(): Promise<void> {
    setRefreshing(true);
    setError('');
    try {
      await syncAccountMaterials(accountId);
      await reloadAccountMaterials();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '同步失败');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-text">素材库</h2>

      {/* 新添素材表单 */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-bg-card p-4">
        <label className="flex flex-col gap-1 text-sm">
          文件 CDN 地址
          <input
            type="text"
            value={fileUrl}
            onChange={(e) => {
              setFileUrl(e.target.value);
            }}
            placeholder="https://cdn.xxx.com/video.mp4"
            className="w-[360px] rounded-md border border-border bg-bg-dark px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          文件名
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder="video_001.mp4"
            className="w-[200px] rounded-md border border-border bg-bg-dark px-3 py-2 text-sm text-text outline-none focus:border-accent"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            void handleRegister();
          }}
          disabled={busy}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85 disabled:opacity-50"
        >
          {busy ? '提交中…' : '注册素材'}
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">
          {error}
        </div>
      ) : null}

      {/* 广告账户素材库 */}
      <div className="space-y-3">
        <div
          className="flex items-center justify-between cursor-pointer select-none"
          onClick={() => { setMatCollapsed((v) => !v); }}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-dim">{matCollapsed ? '▶' : '▼'}</span>
            <h3 className="text-sm font-semibold text-text">
              广告账户素材（{accountId}）
            </h3>
            {matTotal > 0 ? (
              <span className="text-xs text-text-dim">({String(matTotal)} 条)</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void handleAccountSync(); }}
            disabled={refreshing}
            className="rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {refreshing ? '同步中…' : '🔄 刷新'}
          </button>
        </div>
        {matCollapsed ? null : accountMaterials.length === 0 ? (
          <div className="text-sm text-text-muted">暂无数据，点击刷新从 FB 获取。</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {accountMaterials.map((m) => (
              <div key={m.id} className="group rounded-lg border border-border bg-bg-card overflow-hidden hover:border-accent/50 transition-colors">
                {/* 缩略图 */}
                <div className="aspect-square bg-bg-dark flex items-center justify-center overflow-hidden relative">
                  {m.thumbnail_url || (m.url && m.type === 'image') ? (
                    <img
                      src={m.thumbnail_url ?? (m.url ?? undefined)}
                      alt={m.name ?? ''}
                      className="h-full w-full object-cover group-hover:scale-105 transition-transform"
                    />
                  ) : (
                    <span className="text-3xl text-text-dim">
                      {m.type === 'video' ? '🎬' : '🖼'}
                    </span>
                  )}
                  {/* 类型角标 */}
                  <span className="absolute top-1.5 left-1.5 rounded bg-bg-dark/80 px-1.5 py-0.5 text-[10px] text-text-dim">
                    {m.type === 'video' ? '🎬' : '🖼'}
                  </span>
                  {/* 状态点 */}
                  {m.status === 'ACTIVE' || m.status === 'ready' ? (
                    <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-green" />
                  ) : null}
                </div>
                {/* 信息 */}
                <div className="p-2 space-y-0.5">
                  <div className="text-xs text-text truncate" title={m.name ?? undefined}>
                    {m.name ?? '未命名'}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-text-dim">
                    <span>{formatSize(m.width, m.height)}</span>
                    {m.type === 'video' ? <span>{formatDuration(m.length_ms)}</span> : null}
                  </div>
                  <div className="text-[10px] text-text-dim/60 font-mono truncate" title={m.channel_material_id}>
                    {m.channel_material_id.slice(0, 16)}…
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {!matCollapsed && matTotal > 0 ? (
          <div className="flex items-center justify-between pt-2 text-sm text-text-dim">
            <span>共 {String(matTotal)} 条</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={matPage <= 1}
                onClick={() => { void reloadAccountMaterials(matPage - 1); }}
                className="rounded border border-border px-2 py-1 text-xs transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
              >
                上一页
              </button>
              <span>
                {String(matPage)} / {String(matTotalPages)}
              </span>
              <button
                type="button"
                disabled={matPage >= matTotalPages}
                onClick={() => { void reloadAccountMaterials(matPage + 1); }}
                className="rounded border border-border px-2 py-1 text-xs transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* 素材列表 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">已注册素材</h3>
        </div>
        {loading ? (
          <div className="text-sm text-text-muted">加载中…</div>
        ) : materials.length === 0 ? (
          <div className="text-sm text-text-muted">暂无素材，请先注册 CDN 地址。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="px-3 py-2 font-medium">文件名</th>
                  <th className="px-3 py-2 font-medium">URL</th>
                  <th className="px-3 py-2 font-medium">FB 状态</th>
                  <th className="px-3 py-2 font-medium">FB ID</th>
                  <th className="px-3 py-2 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((m) => {
                  const fbUpload = m.uploads.find((u) => u.channel === 'fb');
                  return (
                    <tr key={m.id} className="border-b border-border/50">
                      <td className="px-3 py-2 font-medium">{m.name}</td>
                      <td className="px-3 py-2 max-w-[200px] truncate text-text-dim">{m.file_url}</td>
                      <td className="px-3 py-2">
                        {fbUpload ? (
                          <span
                            className={
                              fbUpload.status === 'ready'
                                ? 'text-green'
                                : fbUpload.status === 'failed'
                                  ? 'text-red'
                                  : 'text-yellow'
                            }
                          >
                            {fbUpload.status === 'ready'
                              ? '就绪'
                              : fbUpload.status === 'failed'
                                ? '失败'
                                : '转码中'}
                          </span>
                        ) : (
                          <span className="text-text-dim">未同步</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-text-dim">
                        {fbUpload?.channel_material_id ?? '--'}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => {
                            void handleSync(m.id);
                          }}
                          disabled={fbUpload?.status === 'uploading'}
                          className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                        >
                          同步到 FB
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
