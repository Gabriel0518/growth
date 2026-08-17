'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  createFbToken,
  deleteFbToken,
  fetchFbTokens,
  refreshFbToken,
  updateFbToken,
} from '@/lib/client/ad/api';
import type { AdAccount, FbTokenPublic } from '@/lib/client/ad/types';

const STATUS_LABELS: Record<number, string> = {
  1: '正常',
  2: '已禁用',
  3: '未结算',
  7: '审核中',
  9: '宽限期',
  100: '待关闭',
  101: '暂不可用',
};

function statusLabel(status: number): string {
  return STATUS_LABELS[status] ?? String(status);
}

function statusClass(status: number): string {
  if (status === 1) return 'text-green';
  if (status === 101) return 'text-yellow';
  return 'text-red';
}

/** Token 管理面板：多套 FB 凭据的增删改，行展开查看广告账户。 */
export function AdTokenPanel(): React.ReactElement {
  const [tokens, setTokens] = useState<FbTokenPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 新增表单
  const [newToken, setNewToken] = useState('');
  const [newAppId, setNewAppId] = useState('');
  const [newAppSecret, setNewAppSecret] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  // 编辑状态
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editToken, setEditToken] = useState('');
  const [editAppId, setEditAppId] = useState('');
  const [editAppSecret, setEditAppSecret] = useState('');
  const [editName, setEditName] = useState('');

  // 展开的 token
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchFbTokens();
      setTokens(data);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function toggleExpand(id: number): void {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  async function handleCreate(): Promise<void> {
    if (!newToken || !newAppId || !newAppSecret) {
      setError('Token、App ID 和 App Secret 为必填项');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await createFbToken({
        token: newToken,
        app_id: newAppId,
        app_secret: newAppSecret,
        ...(newName ? { name: newName } : {}),
      });
      setNewToken('');
      setNewAppId('');
      setNewAppSecret('');
      setNewName('');
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '新增失败');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(t: FbTokenPublic): void {
    setEditingId(t.id);
    setEditToken('');
    setEditAppId('');
    setEditAppSecret('');
    setEditName(t.name ?? '');
  }

  function cancelEdit(): void {
    setEditingId(null);
  }

  async function handleUpdate(id: number): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const body: Record<string, string> = {};
      if (editName) body['name'] = editName;
      if (editToken) body['token'] = editToken;
      if (editAppId) body['app_id'] = editAppId;
      if (editAppSecret) body['app_secret'] = editAppSecret;
      await updateFbToken(id, body);
      setEditingId(null);
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '更新失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: number): Promise<void> {
    if (!confirm('确认删除此 Token？此操作不可撤销。')) return;
    setError('');
    try {
      await deleteFbToken(id);
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '删除失败');
    }
  }

  async function handleRefresh(id: number): Promise<void> {
    setRefreshingId(id);
    setError('');
    try {
      await refreshFbToken(id);
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '刷新失败');
    } finally {
      setRefreshingId(null);
    }
  }

  if (loading) return <div className="text-sm text-text-muted">加载中…</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold text-text">Token 管理</h2>

      {/* 新增表单 */}
      <div className="space-y-3 rounded-lg border border-border bg-bg-card p-4">
        <h3 className="text-sm font-semibold text-text">新增 Token</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Token
            <input
              type="text"
              value={newToken}
              onChange={(e) => { setNewToken(e.target.value); }}
              placeholder="EAAY..."
              className="w-[300px] rounded-md border border-border bg-bg-dark px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            App ID
            <input
              type="text"
              value={newAppId}
              onChange={(e) => { setNewAppId(e.target.value); }}
              placeholder="1708296213710928"
              className="w-[200px] rounded-md border border-border bg-bg-dark px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            App Secret
            <input
              type="text"
              value={newAppSecret}
              onChange={(e) => { setNewAppSecret(e.target.value); }}
              placeholder="a14469..."
              className="w-[200px] rounded-md border border-border bg-bg-dark px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            名称（可选）
            <input
              type="text"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); }}
              placeholder="默认取 BM 名称"
              className="w-[160px] rounded-md border border-border bg-bg-dark px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <button
            type="button"
            onClick={() => { void handleCreate(); }}
            disabled={busy}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85 disabled:opacity-50"
          >
            {busy ? '验证中…' : '新增'}
          </button>
        </div>
        <p className="text-xs text-text-dim">
          提交时自动查询 Token 所属 BM 和有权限的广告账户并回填。
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">
          {error}
        </div>
      ) : null}

      {/* Token 列表 */}
      {tokens.length === 0 ? (
        <div className="text-sm text-text-muted">暂无配置的 Token。</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="w-8 px-3 py-2 font-medium" />
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="px-3 py-2 font-medium">Token</th>
                <th className="px-3 py-2 font-medium">BM</th>
                <th className="px-3 py-2 font-medium">广告账户</th>
                <th className="px-3 py-2 font-medium">最后验证</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <>
                  {/* 主行 */}
                  <tr
                    key={t.id}
                    className={`border-b border-border/50 ${
                      editingId === t.id ? '' : 'cursor-pointer hover:bg-bg-card'
                    }`}
                    onClick={() => { if (editingId !== t.id) toggleExpand(t.id); }}
                  >
                    {editingId === t.id ? (
                      /* 编辑行 */
                      <>
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => { setEditName(e.target.value); }}
                            placeholder="名称"
                            className="w-[120px] rounded-md border border-border bg-bg-dark px-2 py-1 text-xs text-text outline-none focus:border-accent"
                          />
                        </td>
                        <td className="px-3 py-2 space-y-1">
                          <input
                            type="text"
                            value={editToken}
                            onChange={(e) => { setEditToken(e.target.value); }}
                            placeholder="新 Token（留空不改）"
                            className="w-[200px] rounded-md border border-border bg-bg-dark px-2 py-1 text-xs text-text outline-none focus:border-accent"
                          />
                          <input
                            type="text"
                            value={editAppId}
                            onChange={(e) => { setEditAppId(e.target.value); }}
                            placeholder="新 App ID（留空不改）"
                            className="w-[200px] rounded-md border border-border bg-bg-dark px-2 py-1 text-xs text-text outline-none focus:border-accent"
                          />
                          <input
                            type="text"
                            value={editAppSecret}
                            onChange={(e) => { setEditAppSecret(e.target.value); }}
                            placeholder="新 App Secret（留空不改）"
                            className="w-[200px] rounded-md border border-border bg-bg-dark px-2 py-1 text-xs text-text outline-none focus:border-accent"
                          />
                        </td>
                        <td className="px-3 py-2 text-xs text-text-dim">
                          {t.bm_name ?? '—'}<br />
                          <span className="text-text-dim/60">不可编辑</span>
                        </td>
                        <td className="px-3 py-2 text-xs text-text-dim">
                          {t.ad_accounts.length} 个账户
                        </td>
                        <td className="px-3 py-2 text-xs text-text-dim">—</td>
                        <td className="px-3 py-2 flex gap-2">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void handleUpdate(t.id); }}
                            disabled={busy}
                            className="rounded-md border border-accent px-2 py-1 text-xs text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
                          >
                            {busy ? '验证中…' : '保存'}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); cancelEdit(); }}
                            className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent"
                          >
                            取消
                          </button>
                        </td>
                      </>
                    ) : (
                      /* 展示行 */
                      <>
                        <td className="px-3 py-2 text-text-dim">
                          {expandedId === t.id ? '▼' : '▶'}
                        </td>
                        <td className="px-3 py-2 font-medium">
                          {t.name ?? t.bm_name ?? '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-text-dim">
                          {t.token_preview}
                        </td>
                        <td className="px-3 py-2 text-text-dim">
                          {t.bm_name ?? t.bm_id ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-text-dim">
                          {t.ad_accounts.length} 个账户
                        </td>
                        <td className="px-3 py-2 text-text-dim">
                          {t.last_checked_at ?? '—'}
                        </td>
                        <td className="px-3 py-2 flex gap-2">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); startEdit(t); }}
                            className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent"
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void handleRefresh(t.id); }}
                            disabled={refreshingId === t.id}
                            className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                          >
                            {refreshingId === t.id ? '刷新中…' : '刷新'}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void handleDelete(t.id); }}
                            className="rounded-md border border-red/30 px-2 py-1 text-xs text-red transition-colors hover:border-red hover:bg-red/10"
                          >
                            删除
                          </button>
                        </td>
                      </>
                    )}
                  </tr>
                  {/* 展开行 — 广告账户列表 */}
                  {expandedId === t.id && editingId !== t.id ? (
                    <tr key={`${String(t.id)}-accts`} className="border-b border-border/30 bg-bg-card/50">
                      <td colSpan={7} className="px-8 py-3">
                        <div className="text-xs text-text-dim font-medium mb-2">广告账户列表</div>
                        {t.ad_accounts.length === 0 ? (
                          <div className="text-xs text-text-dim/60">无可用账户</div>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-text-dim/60">
                                <th className="py-1 pr-4 text-left font-medium">账户 ID</th>
                                <th className="py-1 pr-4 text-left font-medium">名称</th>
                                <th className="py-1 text-left font-medium">状态</th>
                              </tr>
                            </thead>
                            <tbody>
                              {/* eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion */}
                              {(t.ad_accounts as AdAccount[]).map((acct) => (
                                <tr key={acct.id} className="border-t border-border/20">
                                  <td className="py-1.5 pr-4 font-mono text-text-dim">{acct.id}</td>
                                  <td className="py-1.5 pr-4 text-text-dim">{acct.name}</td>
                                  <td className="py-1.5">
                                    <span className={statusClass(acct.status)}>
                                      {statusLabel(acct.status)}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
