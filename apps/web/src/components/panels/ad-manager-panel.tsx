'use client';

import { useEffect, useState } from 'react';

import { AdPanel } from './ad-ad-panel';
import { AdSetPanel } from './ad-adset-panel';
import { AdCampaignPanel } from './ad-campaign-panel';
import { AdMaterialPanel } from './ad-material-panel';
import { AdTokenPanel } from './ad-token-panel';
import { SearchableSelect, buildAccountOption } from './searchable-select';

import { fetchAdAccountConfigs, syncFromFb } from '@/lib/client/ad/api';
import type { AdAccountConfig } from '@/lib/client/ad/types';

// ── localStorage key ──
const LS_ACCOUNT_KEY = 'ad-current-account-id';

type SubTab = 'token' | 'material' | 'campaign' | 'adgroup' | 'ad';

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'token', label: 'Token 管理' },
  { key: 'material', label: '素材库' },
  { key: 'campaign', label: '广告系列' },
  { key: 'adgroup', label: '广告组' },
  { key: 'ad', label: '广告' },
];

// ── 轻量 Toast 通知 ──

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error';
}

let toastNextId = 0;

/** 投放管理面板壳 —— 顶部子 Tab + 账户选择器 + 同步按钮 + Toast */
export function AdManagerPanel(): React.ReactElement {
  const [tab, setTab] = useState<SubTab>('token');
  const [syncing, setSyncing] = useState(false);
  const [fullSyncing, setFullSyncing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // 通知
  const [toasts, setToasts] = useState<Toast[]>([]);
  // 广告账户选择
  const [accounts, setAccounts] = useState<AdAccountConfig[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');

  // 初始化加载账户列表（客户端执行，localStorage 安全）
  useEffect(() => {
    // 先从 localStorage 恢复之前选择的账户
    const saved = globalThis.localStorage.getItem(LS_ACCOUNT_KEY) ?? '';
    if (saved) setSelectedAccountId(saved);

    fetchAdAccountConfigs()
      .then((list) => {
        setAccounts(list);
        if (list.length > 0) {
          const exists = list.some((a) => a.accountId === saved);
          if (!exists) {
            const first = list[0]?.accountId ?? '';
            setSelectedAccountId(first);
          }
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      .catch(() => {});
  }, []);

  function addToast(message: string, type: 'success' | 'error'): void {
    const id = toastNextId++;
    setToasts((prev) => [...prev, { id, message, type }]);
  }

  function dismissToast(id: number): void {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function selectAccount(id: string): void {
    setSelectedAccountId(id);
    try { globalThis.localStorage.setItem(LS_ACCOUNT_KEY, id); } catch {
      /* SSR 环境无 localStorage */
    }
  }

  async function handleSync(): Promise<void> {
    setSyncing(true);
    try {
      const result = await syncFromFb(selectedAccountId);
      addToast(
        `同步完成：Campaign ${String(result.campaigns)} 条、AdSet ${String(result.adsets)} 条、Ad ${String(result.ads)} 条`,
        'success',
      );
      setRefreshKey((k) => k + 1);
    } catch (error) {
      addToast(`同步失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
    } finally {
      setSyncing(false);
    }
  }

  async function handleFullSync(): Promise<void> {
    setFullSyncing(true);
    try {
      const result = await syncFromFb(); // 不传 accountId → 全量同步所有 token 的账户
      const parts = [
        `全量同步完成：${String(result.accounts ?? 0)} 个账户`,
        `Campaign ${String(result.campaigns)}、AdSet ${String(result.adsets)}、Ad ${String(result.ads)}`,
      ];
      if (result.skippedAccounts) parts.push(`跳过重复 ${String(result.skippedAccounts)}`);
      if (result.failures?.length) parts.push(`失败 ${String(result.failures.length)}`);
      addToast(parts.join('，'), result.failures?.length ? 'error' : 'success');
      setRefreshKey((k) => k + 1);
    } catch (error) {
      addToast(`全量同步失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
    } finally {
      setFullSyncing(false);
    }
  }

  function handleSubTabClick(key: SubTab): void {
    setTab(key);
  }


  return (
    <div className="relative">
      {/* Toast 容器 — 右上角固定 */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-lg ${
              t.type === 'success'
                ? 'border border-green/30 bg-green/10 text-green'
                : 'border border-red/30 bg-red/10 text-red'
            }`}
          >
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              onClick={() => { dismissToast(t.id); }}
              className="text-current opacity-60 hover:opacity-100 font-bold text-base leading-none"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* 子 Tab 栏 + 账户选择器 + 同步按钮 */}
      <div className="flex items-center gap-2 border-b border-border px-6 py-3">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { handleSubTabClick(t.key); }}
            className={`rounded-md border px-3 py-1.5 text-[0.95rem] font-semibold whitespace-nowrap transition-colors cursor-pointer ${
              tab === t.key
                ? 'border-accent bg-[rgba(99,102,241,0.08)] text-accent'
                : 'border-border bg-bg-card text-text-muted hover:border-accent hover:text-accent'
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          {/* 广告账户选择器（可搜索） */}
          {accounts.length > 0 ? (
            <SearchableSelect
              options={accounts.map((a) => buildAccountOption(a))}
              value={selectedAccountId}
              placeholder="搜索广告账户…"
              onChange={selectAccount}
            />
          ) : null}
          <button
            type="button"
            onClick={() => { void handleSync(); }}
            disabled={syncing || fullSyncing}
            className="rounded-md border border-border bg-bg-card px-3 py-1.5 text-xs font-semibold text-text-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {syncing ? '同步中…' : '🔄 同步当前账户'}
          </button>
          <button
            type="button"
            onClick={() => { void handleFullSync(); }}
            disabled={syncing || fullSyncing}
            title="同步所有 token 下的所有广告账户"
            className="rounded-md border border-accent/50 bg-bg-card px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
          >
            {fullSyncing ? '全量同步中…' : '🚀 全量同步'}
          </button>
        </div>
      </div>

      {/* 子面板 */}
      <div className="p-4" key={refreshKey}>
        {tab === 'token' ? <AdTokenPanel /> : null}
        {tab === 'material' ? <AdMaterialPanel accountId={selectedAccountId} /> : null}
        {tab === 'campaign' ? <AdCampaignPanel accountId={selectedAccountId} /> : null}
        {tab === 'adgroup' ? <AdSetPanel accountId={selectedAccountId} /> : null}
        {tab === 'ad' ? <AdPanel accountId={selectedAccountId} /> : null}
      </div>

    </div>
  );
}
