'use client';

import { useCallback, useEffect, useState } from 'react';

import { AdDetailDrawer } from './ad-detail-drawer';
import { CreateDrawer } from './create-drawer';
import { Modal } from './modal';
import { SearchableSelect } from './searchable-select';

import { createAdSet, fetchAdSets, fetchCampaigns, syncAdSetsOnly, updateAdSet } from '@/lib/client/ad/api';
import type { FbCampaign, FbAdSet } from '@/lib/client/ad/types';
import { Dropdown } from '@/components/ui/dropdown';

const LS_ADSET_CAMPAIGN_KEY = 'ad-current-campaign-id';

function buildCampaignOption(c: FbCampaign) {
  return {
    value: String(c.local_id),
    label: `${c.name} (${c.status})`,
    filterText: `${c.name} ${String(c.local_id)} ${c.status}`,
  };
}

/** 从 channel_extra 读广告组日预算（FB 返回字符串，单位分），转美元字符串；缺失返回空串。 */
function adsetBudgetDollars(a: FbAdSet): string {
  const raw = a.channel_extra?.['daily_budget'];
  if (raw === undefined || raw === null || raw === '') return '';
  const cents = Number.parseInt(String(raw), 10);
  return Number.isFinite(cents) ? String(cents / 100) : '';
}

/** 广告组面板：选 Campaign → 列表 + 创建弹窗。*/
export function AdSetPanel({ accountId }: { accountId: string }): React.ReactElement {
  const [campaigns, setCampaigns] = useState<FbCampaign[]>([]);
  const [adsets, setAdsets] = useState<FbAdSet[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState('');
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
  const [budgetAdset, setBudgetAdset] = useState<FbAdSet | null>(null);
  const [budgetValue, setBudgetValue] = useState('');
  const [budgetBusy, setBudgetBusy] = useState(false);

  // 弹窗内表单
  const [modalCampaignId, setModalCampaignId] = useState('');
  const [name, setName] = useState('');
  const [optGoal, setOptGoal] = useState('OFFSITE_CONVERSIONS');
  const [showMoreParams, setShowMoreParams] = useState(false);
  const [destType, setDestType] = useState('APP');
  const [skAd, setSkAd] = useState(false);
  const [dynamicCreative, setDynamicCreative] = useState(false);
  const [billingEvent, setBillingEvent] = useState('IMPRESSIONS');
  const [bidStrategy, setBidStrategy] = useState('LOWEST_COST_WITHOUT_CAP');
  const [budget, setBudget] = useState('');
  // promoted_object
  const [poAppId, setPoAppId] = useState('');
  const [poStoreUrl, setPoStoreUrl] = useState('');
  const [poCustomEvent, setPoCustomEvent] = useState('PURCHASE');
  // attribution_spec
  const [attrEventType, setAttrEventType] = useState('CLICK_THROUGH');
  const [attrWindowDays, setAttrWindowDays] = useState('7');
  // targeting
  const [tgCountries, setTgCountries] = useState('US');
  const [tgLocationTypes, setTgLocationTypes] = useState('home,recent');
  const [tgAgeMin, setTgAgeMin] = useState('18');
  const [tgAgeMax, setTgAgeMax] = useState('65');
  const [tgAppInstall, setTgAppInstall] = useState('not_installed');
  const [tgUserOs, setTgUserOs] = useState('Android_ver_8.0_and_above');
  const [tgUserDevice, setTgUserDevice] = useState('Android_Smartphone');
  const [tgAdvAudience, setTgAdvAudience] = useState(true);

  const loadCampaigns = useCallback(async () => {
    try {
      const data = await fetchCampaigns(accountId);
      setCampaigns(data);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '加载 Campaign 失败');
    }
  }, [accountId]);

  const loadAdSets = useCallback(
    async (campaignId: string) => {
      setLoading(true);
      try {
        const data = await fetchAdSets(campaignId, accountId);
        setAdsets(data);
      } catch (error_) {
        setError(error_ instanceof Error ? error_.message : '加载 AdSet 失败');
      } finally {
        setLoading(false);
      }
    },
    [accountId],
  );

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  // 恢复上次选择的 Campaign
  useEffect(() => {
    if (campaigns.length > 0 && !selectedCampaign) {
      const saved = globalThis.localStorage.getItem(LS_ADSET_CAMPAIGN_KEY);
      if (saved && campaigns.some((c) => String(c.local_id) === saved)) {
        handleSelectCampaign(saved);
      }
    }
  }, [campaigns, selectedCampaign]);

  function handleSelectCampaign(id: string): void {
    setSelectedCampaign(id);
    try { globalThis.localStorage.setItem(LS_ADSET_CAMPAIGN_KEY, id); } catch { /* SSR */ }
    void loadAdSets(id);
  }

  function openModal(): void {
    setModalCampaignId(selectedCampaign);
    setName('');
    setOptGoal('OFFSITE_CONVERSIONS');
    setShowMoreParams(false);
    setDestType('APP');
    setSkAd(false);
    setDynamicCreative(false);
    setBillingEvent('IMPRESSIONS');
    setBidStrategy('LOWEST_COST_WITHOUT_CAP');
    setBudget('');
    setPoAppId('');
    setPoStoreUrl('');
    setPoCustomEvent('PURCHASE');
    setAttrEventType('CLICK_THROUGH');
    setAttrWindowDays('7');
    setTgCountries('US');
    setTgLocationTypes('home,recent');
    setTgAgeMin('18');
    setTgAgeMax('65');
    setTgAppInstall('not_installed');
    setTgUserOs('Android_ver_8.0_and_above');
    setTgUserDevice('Android_Smartphone');
    setTgAdvAudience(true);
    setError('');
    setShowModal(true);
  }

  function handleModalCampaignChange(id: string): void {
    setModalCampaignId(id);
  }

  async function handleCreate(): Promise<void> {
    if (!name || !modalCampaignId) {
      setError('请填写名称并选择 Campaign');
      return;
    }
    const budgetTrim = budget.trim();
    let dailyBudget: number | undefined;
    if (budgetTrim !== '') {
      const dollars = Number.parseFloat(budgetTrim);
      if (!Number.isFinite(dollars) || dollars < 0) {
        setError('请输入有效的日预算金额');
        return;
      }
      dailyBudget = Math.round(dollars * 100);
    }
    setBusy(true);
    setError('');
    try {
      const promObj: Record<string, unknown> = {};
      if (poAppId) promObj['application_id'] = poAppId;
      if (poStoreUrl) promObj['object_store_url'] = poStoreUrl;
      if (poCustomEvent) promObj['custom_event_type'] = poCustomEvent;

      const attrSpec: Record<string, unknown>[] = [];
      if (attrEventType) {
        attrSpec.push({ event_type: attrEventType, window_days: Number.parseInt(attrWindowDays, 10) || 7 });
      }

      const targeting: Record<string, unknown> = {};
      const countries = tgCountries.split(',').map((s) => s.trim()).filter(Boolean);
      const locations = tgLocationTypes.split(',').map((s) => s.trim()).filter(Boolean);
      if (countries.length > 0) targeting['geo_locations'] = { countries, ...(locations.length > 0 ? { location_types: locations } : {}) };
      const ageMin = Number.parseInt(tgAgeMin, 10);
      const ageMax = Number.parseInt(tgAgeMax, 10);
      if (ageMin) targeting['age_min'] = ageMin;
      if (ageMax) targeting['age_max'] = ageMax;
      if (tgAppInstall) targeting['app_install_state'] = tgAppInstall;
      if (tgAdvAudience) targeting['targeting_automation'] = { advantage_audience: 1 };
      if (tgUserOs) targeting['user_os'] = tgUserOs.split(',').map((s) => s.trim()).filter(Boolean);
      if (tgUserDevice) targeting['user_device'] = tgUserDevice.split(',').map((s) => s.trim()).filter(Boolean);

      await createAdSet({
        name,
        campaign_id: modalCampaignId,
        optimization_goal: optGoal,
        billing_event: billingEvent,
        bid_strategy: bidStrategy,
        ...(dailyBudget !== undefined ? { daily_budget: dailyBudget } : {}),
        targeting,
        destination_type: destType,
        ...(skAd ? { is_skadnetwork_attribution: true } : {}),
        ...(dynamicCreative ? { is_dynamic_creative: true } : {}),
        ...(Object.keys(promObj).length > 0 ? { promoted_object: promObj } : {}),
        ...(attrSpec.length > 0 ? { attribution_spec: attrSpec } : {}),
      }, accountId);
      setShowModal(false);
      if (modalCampaignId === selectedCampaign) {
        await loadAdSets(selectedCampaign);
      }
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh(): Promise<void> {
    if (!selectedCampaign) { setError('请先选择一个 Campaign'); return; }
    const fbCampaign = campaigns.find((c) => c.local_id === Number(selectedCampaign));
    if (!fbCampaign) { setError('请先同步广告系列'); return; }
    setRefreshing(true);
    setError('');
    try {
      await syncAdSetsOnly(accountId, fbCampaign.id);
      await loadAdSets(selectedCampaign);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '刷新失败');
    } finally {
      setRefreshing(false);
    }
  }

  function openBudgetModal(a: FbAdSet): void {
    setBudgetAdset(a);
    setBudgetValue(adsetBudgetDollars(a));
    setError('');
    setShowBudgetModal(true);
  }

  async function handleSaveBudget(): Promise<void> {
    if (!budgetAdset) return;
    const dollars = Number.parseFloat(budgetValue);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError('请输入有效的日预算金额');
      return;
    }
    const fbCampaign = campaigns.find((c) => c.local_id === Number(selectedCampaign));
    if (!fbCampaign) {
      setError('请先同步广告系列');
      return;
    }
    setBudgetBusy(true);
    setError('');
    try {
      await updateAdSet(budgetAdset.id, { daily_budget: Math.round(dollars * 100) }, accountId);
      await syncAdSetsOnly(accountId, fbCampaign.id);
      await loadAdSets(selectedCampaign);
      setShowBudgetModal(false);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '保存失败');
    } finally {
      setBudgetBusy(false);
    }
  }

  const campaignOptions = campaigns.map((c) => buildCampaignOption(c));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text">广告组</h2>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { void handleRefresh(); }} disabled={refreshing}
            className="rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-dim transition-colors hover:border-accent hover:text-accent disabled:opacity-50">
            {refreshing ? '刷新中…' : '🔄 刷新'}
          </button>
          <button type="button" onClick={openModal}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85">
            + 创建广告组
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-sm text-text-muted">选择 Campaign：</label>
        <SearchableSelect options={campaignOptions} value={selectedCampaign}
          placeholder="搜索 Campaign…" onChange={handleSelectCampaign} />
      </div>

      {error ? (
        <div className="rounded-md border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">{error}</div>
      ) : null}

      {selectedCampaign ? (
        loading ? (<div className="text-sm text-text-muted">加载中…</div>)
        : adsets.length === 0 ? (<div className="text-sm text-text-muted">暂无广告组。</div>)
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead><tr className="border-b border-border text-text-muted">
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="px-3 py-2 font-medium">产品</th>
                <th className="px-3 py-2 font-medium">投手</th>
                <th className="px-3 py-2 font-medium">日期</th>
                <th className="px-3 py-2 font-medium">优化目标</th>
                <th className="px-3 py-2 font-medium">计费方式</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">详情</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr></thead>
              <tbody>
                {adsets.map((a) => (
                  <tr key={a.id} className="border-b border-border/50">
                    <td className="px-3 py-2 font-medium">{a.name}</td>
                    <td className="px-3 py-2 text-text-dim">{a.campaign_product ?? '—'}</td>
                    <td className="px-3 py-2 text-text-dim">{a.campaign_operator ?? '—'}</td>
                    <td className="px-3 py-2 text-text-dim">{a.campaign_created_at ?? '—'}</td>
                    <td className="px-3 py-2 text-text-dim">{a.optimization_goal}</td>
                    <td className="px-3 py-2 text-text-dim">{a.billing_event}</td>
                    <td className="px-3 py-2">
                      <span className={a.status === 'ACTIVE' ? 'text-green' : 'text-yellow'}>{a.status}</span>
                    </td>
                    <td className="px-3 py-2">
                      <button type="button"
                        onClick={() => { // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                        setDetailExtra(a.channel_extra ?? {}); setDetailTitle(`AdSet 详情 — ${a.name}`); setShowDetail(true); }}
                        className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent">
                        详情
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <button type="button"
                        onClick={() => { openBudgetModal(a); }}
                        className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent">
                        改预算
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (<div className="text-sm text-text-muted">请先选择一个 Campaign。</div>)}

      <CreateDrawer open={showModal} title="创建广告组" onClose={() => { setShowModal(false); }}>
        <div className="space-y-4">
          <label className="flex flex-col gap-1 text-sm">Campaign
            <SearchableSelect options={campaignOptions} value={modalCampaignId}
              placeholder="搜索 Campaign…" onChange={handleModalCampaignChange} />
          </label>
          <label className="flex flex-col gap-1 text-sm">名称
            <input type="text" value={name} onChange={(e) => { setName(e.target.value); }} placeholder="广告组 1"
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            日预算 ($)（可选，ABO 时填）
            <input
              type="number"
              value={budget}
              onChange={(e) => { setBudget(e.target.value); }}
              placeholder="留空则不设日预算"
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">计费方式（billing_event）
            <Dropdown tone="legacy" aria-label="计费方式" value={billingEvent} onChange={setBillingEvent} options={[{ value: 'IMPRESSIONS', label: 'IMPRESSIONS - 展示付费' }, { value: 'CLICKS', label: 'CLICKS - 点击付费' }, { value: 'LINK_CLICKS', label: 'LINK_CLICKS - 链接点击付费' }, { value: 'PAGE_LIKES', label: 'PAGE_LIKES - 主页赞付费' }, { value: 'POST_ENGAGEMENT', label: 'POST_ENGAGEMENT - 帖子互动付费' }]} />
          </label>
          <label className="flex flex-col gap-1 text-sm">出价策略（bid_strategy）
            <Dropdown tone="legacy" aria-label="出价策略" value={bidStrategy} onChange={setBidStrategy} options={[{ value: 'LOWEST_COST_WITHOUT_CAP', label: '最低成本（无出价上限）' }, { value: 'LOWEST_COST_WITH_BID_CAP', label: '最低成本（有出价上限）' }, { value: 'COST_CAP', label: '成本上限' }, { value: 'LOWEST_COST_WITH_MIN_ROAS', label: '最低成本（最低 ROAS）' }]} />
          </label>
          <label className="flex flex-col gap-1 text-sm">优化目标
            <Dropdown tone="legacy" aria-label="优化目标" value={optGoal} onChange={setOptGoal} options={[{ value: 'OFFSITE_CONVERSIONS', label: 'AEO - 转化' }, { value: 'VALUE', label: 'VO - 价值' }, { value: 'APP_INSTALLS', label: '应用安装' }, { value: 'LINK_CLICKS', label: '链接点击' }, { value: 'IMPRESSIONS', label: '展示' }]} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            App ID（application_id）
            <input type="text" value={poAppId} onChange={(e) => { setPoAppId(e.target.value); }} placeholder="774714691621452"
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            商店链接（object_store_url）
            <input type="text" value={poStoreUrl} onChange={(e) => { setPoStoreUrl(e.target.value); }} placeholder="http://play.google.com/store/apps/details?id=com.doramatch.app"
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent" />
          </label>
          {/* 更多参数 */}
          <button
            type="button"
            onClick={() => { setShowMoreParams((v) => !v); }}
            className="flex items-center gap-1 text-xs text-text-dim hover:text-accent transition-colors"
          >
            {showMoreParams ? '▲' : '▼'} 更多参数
          </button>
          {showMoreParams ? (
            <div className="space-y-4 rounded-md border border-border/50 bg-bg-card/50 p-3">
              <label className="flex flex-col gap-1 text-sm">
                跳转类型（destination_type）
                <Dropdown tone="legacy" aria-label="跳转类型" value={destType} onChange={setDestType} options={[{ value: 'APP', label: 'APP - 应用' }, { value: 'WEBSITE', label: 'WEBSITE - 网站' }, { value: 'MESSENGER', label: 'MESSENGER - Messenger' }, { value: 'WHATSAPP', label: 'WHATSAPP' }, { value: 'INSTAGRAM_DIRECT', label: 'INSTAGRAM_DIRECT' }, { value: 'ON_AD', label: 'ON_AD' }, { value: 'ON_POST', label: 'ON_POST' }]} />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={skAd} onChange={(e) => { setSkAd(e.target.checked); }} />
                <span className="text-text-dim">启用 SKAdNetwork 归因（iOS 14+）</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={dynamicCreative} onChange={(e) => { setDynamicCreative(e.target.checked); }} />
                <span className="text-text-dim">启用动态创意（is_dynamic_creative）</span>
              </label>
              <div className="text-xs font-semibold text-text-dim/60 uppercase tracking-wide">推广对象（promoted_object）</div>
              <label className="flex flex-col gap-1 text-sm">
                自定义事件（custom_event_type）
                <input type="text" value={poCustomEvent} onChange={(e) => { setPoCustomEvent(e.target.value); }} placeholder="PURCHASE"
                  className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <div className="text-xs font-semibold text-text-dim/60 uppercase tracking-wide">归因配置（attribution_spec）</div>
              <label className="flex flex-col gap-1 text-sm">
                事件类型（event_type）
                <input type="text" value={attrEventType} onChange={(e) => { setAttrEventType(e.target.value); }} placeholder="CLICK_THROUGH"
                  className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                窗口天数（window_days）
                <input type="number" value={attrWindowDays} onChange={(e) => { setAttrWindowDays(e.target.value); }}
                  className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <div className="text-xs font-semibold text-text-dim/60 uppercase tracking-wide">定向规则（targeting）</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-sm">
                  国家（逗号分隔）
                  <input type="text" value={tgCountries} onChange={(e) => { setTgCountries(e.target.value); }} placeholder="US"
                    className="w-full rounded-md border border-border bg-bg-card px-2 py-1.5 text-sm text-text outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  位置类型（逗号分隔）
                  <input type="text" value={tgLocationTypes} onChange={(e) => { setTgLocationTypes(e.target.value); }} placeholder="home,recent"
                    className="w-full rounded-md border border-border bg-bg-card px-2 py-1.5 text-sm text-text outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  最低年龄
                  <input type="number" value={tgAgeMin} onChange={(e) => { setTgAgeMin(e.target.value); }}
                    className="w-full rounded-md border border-border bg-bg-card px-2 py-1.5 text-sm text-text outline-none focus:border-accent" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  最高年龄
                  <input type="number" value={tgAgeMax} onChange={(e) => { setTgAgeMax(e.target.value); }}
                    className="w-full rounded-md border border-border bg-bg-card px-2 py-1.5 text-sm text-text outline-none focus:border-accent" />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                设备系统（user_os，逗号分隔）
                <input type="text" value={tgUserOs} onChange={(e) => { setTgUserOs(e.target.value); }} placeholder="Android_ver_8.0_and_above"
                  className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                设备类型（user_device，逗号分隔）
                <input type="text" value={tgUserDevice} onChange={(e) => { setTgUserDevice(e.target.value); }} placeholder="Android_Smartphone"
                  className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent" />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={tgAdvAudience} onChange={(e) => { setTgAdvAudience(e.target.checked); }} />
                <span className="text-text-dim">Advantage+ 受众</span>
              </label>
            </div>
          ) : null}
          {error ? (<div className="rounded-md border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">{error}</div>) : null}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => { setShowModal(false); }}
              className="rounded-md border border-border px-4 py-2 text-sm text-text-dim hover:border-accent hover:text-accent">取消</button>
            <button type="button" onClick={() => { void handleCreate(); }} disabled={busy}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85 disabled:opacity-50">
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      </CreateDrawer>
      <AdDetailDrawer open={showDetail} title={detailTitle} channelExtra={detailExtra}
        onClose={() => { setShowDetail(false); }} />
      <Modal open={showBudgetModal} title={`修改日预算 — ${budgetAdset?.name ?? ''}`}
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
