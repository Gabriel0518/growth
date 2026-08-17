'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdDetailDrawer } from './ad-detail-drawer';
import { CreateDrawer } from './create-drawer';
import { Modal } from './modal';

import { createCampaign, fetchCampaigns, syncCampaignsOnly, updateCampaign } from '@/lib/client/ad/api';
import type { FbCampaign } from '@/lib/client/ad/types';

/** 广告系列面板：列表 + 创建弹窗 + 状态切换。 */
export function AdCampaignPanel({ accountId }: { accountId: string }): React.ReactElement {
  const [campaigns, setCampaigns] = useState<FbCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [detailExtra, setDetailExtra] = useState<Record<string, unknown>>({});
  const [detailTitle, setDetailTitle] = useState('');
  const [showDetail, setShowDetail] = useState(false);

  // 修改日预算
  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [budgetCampaign, setBudgetCampaign] = useState<FbCampaign | null>(null);
  const [budgetValue, setBudgetValue] = useState('');
  const [budgetBusy, setBudgetBusy] = useState(false);

  // 表单
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('OUTCOME_APP_PROMOTION');
  const [budget, setBudget] = useState('100');
  const [campaignProduct, setCampaignProduct] = useState('');
  const [buyingType, setBuyingType] = useState('AUCTION');
  const [bidStrategy, setBidStrategy] = useState('LOWEST_COST_WITHOUT_CAP');
  const [isAbo, setIsAbo] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchCampaigns(accountId);
      setCampaigns(data);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openModal(): void {
    setName('');
    setObjective('OUTCOME_APP_PROMOTION');
    setBudget('100');
    setCampaignProduct('');
    setBuyingType('AUCTION');
    setBidStrategy('LOWEST_COST_WITHOUT_CAP');
    setIsAbo(false);
    setError('');
    setShowModal(true);
  }

  async function handleCreate(): Promise<void> {
    if (!name) {
      setError('名称不能为空');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await createCampaign({
        name,
        objective,
        ...(isAbo ? {} : { daily_budget: Number.parseInt(budget, 10) * 100 }),
        buying_type: buyingType,
        ...(isAbo ? {} : { bid_strategy: bidStrategy }),
        ...(campaignProduct ? { product: campaignProduct } : {}),
      }, accountId);
      setShowModal(false);
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(c: FbCampaign): Promise<void> {
    const next = c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    try {
      await updateCampaign(c.id, { status: next }, accountId);
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '操作失败');
    }
  }

  function openBudgetModal(c: FbCampaign): void {
    setBudgetCampaign(c);
    setBudgetValue(c.daily_budget !== undefined ? String(c.daily_budget / 100) : '');
    setError('');
    setShowBudgetModal(true);
  }

  async function handleSaveBudget(): Promise<void> {
    if (!budgetCampaign) return;
    const dollars = Number.parseFloat(budgetValue);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError('请输入有效的日预算金额');
      return;
    }
    setBudgetBusy(true);
    setError('');
    try {
      await updateCampaign(budgetCampaign.id, { daily_budget: Math.round(dollars * 100) }, accountId);
      setShowBudgetModal(false);
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '保存失败');
    } finally {
      setBudgetBusy(false);
    }
  }

  async function handleRefresh(): Promise<void> {
    setRefreshing(true);
    setError('');
    try {
      // 只同步当前广告账户下的 Campaign
      await syncCampaignsOnly(accountId);
      await reload();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '刷新失败');
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) return <div className="text-sm text-text-muted">加载中…</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text">广告系列</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void handleRefresh(); }}
            disabled={refreshing}
            className="rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {refreshing ? '刷新中…' : '🔄 刷新'}
          </button>
          <button
            type="button"
            onClick={openModal}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85"
          >
            + 创建广告系列
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">
          {error}
        </div>
      ) : null}

      {campaigns.length === 0 ? (
        <div className="text-sm text-text-muted">暂无广告系列。</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-text-muted">
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="px-3 py-2 font-medium">产品</th>
                <th className="px-3 py-2 font-medium">投手</th>
                <th className="px-3 py-2 font-medium">日期</th>
                <th className="px-3 py-2 font-medium">目标</th>
                <th className="px-3 py-2 font-medium">日预算</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">详情</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-border/50">
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-3 py-2 text-text-dim">{c.app_product ?? '—'}</td>
                  <td className="px-3 py-2 text-text-dim">{c.creator ?? '—'}</td>
                  <td className="px-3 py-2 text-text-dim">{c.created_at ?? '—'}</td>
                  <td className="px-3 py-2 text-text-dim">{c.objective}</td>
                  <td className="px-3 py-2 text-text-dim">
                    {c.daily_budget === undefined ? '--' : `$${String(c.daily_budget / 100)}`}
                  </td>
                  <td className="px-3 py-2">
                    <span className={c.status === 'ACTIVE' ? 'text-green' : 'text-yellow'}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <button type="button"
                      onClick={() => { // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                      setDetailExtra(c.channel_extra ?? {},); setDetailTitle(`Campaign 详情 — ${c.name}`); setShowDetail(true); }}
                      className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent">
                      详情
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          void handleToggle(c);
                        }}
                        className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent"
                      >
                        {c.status === 'ACTIVE' ? '暂停' : '启动'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          openBudgetModal(c);
                        }}
                        disabled={c.daily_budget === undefined}
                        title={c.daily_budget === undefined ? '预算在广告组上' : '修改日预算'}
                        className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        改预算
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 创建弹窗 */}
      <CreateDrawer open={showModal} title="创建广告系列" onClose={() => { setShowModal(false); }}>
        <div className="space-y-4">
          <label className="flex flex-col gap-1 text-sm">
            名称
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); }}
              placeholder="自定义 Campaign 名称"
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            产品
            <input
              type="text"
              value={campaignProduct}
              onChange={(e) => { setCampaignProduct(e.target.value); }}
              placeholder="如 Dora And"
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            目标
            <select
              value={objective}
              onChange={(e) => { setObjective(e.target.value); }}
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent"
            >
              <option value="OUTCOME_APP_PROMOTION">应用推广</option>
              <option value="OUTCOME_TRAFFIC">流量</option>
              <option value="OUTCOME_SALES">转化</option>
              <option value="OUTCOME_ENGAGEMENT">互动</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isAbo} onChange={(e) => { setIsAbo(e.target.checked); }} />
            <span className="text-text-dim">预算在广告组上（ABO）</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            日预算 ($)
            <input
              type="number"
              value={budget}
              onChange={(e) => { setBudget(e.target.value); }}
              disabled={isAbo}
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            购买类型（buying_type）
            <select value={buyingType} onChange={(e) => { setBuyingType(e.target.value); }}
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent">
              <option value="AUCTION">AUCTION - 竞价</option>
              <option value="RESERVED">RESERVED - 预定</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            出价策略（bid_strategy）{isAbo ? '（ABO 时在广告组设置）' : ''}
            <select value={bidStrategy} onChange={(e) => { setBidStrategy(e.target.value); }} disabled={isAbo}
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:opacity-50">
              <option value="LOWEST_COST_WITHOUT_CAP">最低成本（无出价上限）</option>
              <option value="LOWEST_COST_WITH_BID_CAP">最低成本（有出价上限）</option>
              <option value="COST_CAP">成本上限</option>
              <option value="LOWEST_COST_WITH_MIN_ROAS">最低成本（最低 ROAS）</option>
            </select>
          </label>
          {error ? (
            <div className="rounded-md border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
              {error}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => { setShowModal(false); }}
              className="rounded-md border border-border px-4 py-2 text-sm text-text-dim hover:border-accent hover:text-accent"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => { void handleCreate(); }}
              disabled={busy}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85 disabled:opacity-50"
            >
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      </CreateDrawer>
      <AdDetailDrawer open={showDetail} title={detailTitle} channelExtra={detailExtra}
        onClose={() => { setShowDetail(false); }} />
      <Modal open={showBudgetModal} title={`修改日预算 — ${budgetCampaign?.name ?? ''}`}
        onClose={() => { setShowBudgetModal(false); }}>
        <div className="space-y-4">
          <label className="flex flex-col gap-1 text-sm">
            日预算 ($)
            <input
              type="number"
              value={budgetValue}
              onChange={(e) => { setBudgetValue(e.target.value); }}
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          {error ? (
            <div className="rounded-md border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
              {error}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => { setShowBudgetModal(false); }}
              className="rounded-md border border-border px-4 py-2 text-sm text-text-dim hover:border-accent hover:text-accent"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => { void handleSaveBudget(); }}
              disabled={budgetBusy}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85 disabled:opacity-50"
            >
              {budgetBusy ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
