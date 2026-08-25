'use client';

import { useEffect, useState } from 'react';

import { AdCopyDrawer } from './ad-copy-drawer';
import { AdDetailDrawer } from './ad-detail-drawer';
import { CreateDrawer } from './create-drawer';
import { SearchableSelect } from './searchable-select';

import {
  createAd,
  fetchAdAccountConfigs,
  fetchAccountMaterials,
  fetchAdSets,
  fetchAds,
  fetchBrandedContentPermissions,
  fetchCampaigns,
  syncAdsOnly,
} from '@/lib/client/ad/api';
import type { AdAccountConfig, AvailablePage, BrandedContentPermission, FbAd, FbAdSet, FbCampaign } from '@/lib/client/ad/types';
import { Dropdown } from '@/components/ui/dropdown';


const LS_AD_CAMPAIGN_KEY = 'ad-campaign-selected';
const LS_AD_ADSET_KEY = 'ad-adset-selected';

function buildCampaignOpt(c: FbCampaign) {
  return { value: String(c.local_id), label: `${c.name} (${c.status})`, filterText: `${c.name} ${String(c.local_id)} ${c.status}` };
}
function buildAdSetOpt(a: FbAdSet) {
  return { value: String(a.local_id), label: `${a.name} (${a.status})`, filterText: `${a.name} ${String(a.local_id)} ${a.status}` };
}

/** 广告面板：级联选择 Campaign → AdGroup → 列表 + 创建弹窗。*/
export function AdPanel({ accountId }: { accountId: string }): React.ReactElement {
  const [campaigns, setCampaigns] = useState<FbCampaign[]>([]);
  const [adsets, setAdsets] = useState<FbAdSet[]>([]);
  const [ads, setAds] = useState<FbAd[]>([]);
  const [selectedCampaign, setSelectedCampaign] = useState('');
  const [selectedAdset, setSelectedAdset] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [detailExtra, setDetailExtra] = useState<Record<string, unknown>>({});
  const [detailTitle, setDetailTitle] = useState('');
  const [showDetail, setShowDetail] = useState(false);
  const [copyTarget, setCopyTarget] = useState<FbAd | null>(null);

  // 弹窗内表单
  const [modalCampaignId, setModalCampaignId] = useState('');
  const [modalAdsetOptions, setModalAdsetOptions] = useState<FbAdSet[]>([]);
  const [modalAdsetId, setModalAdsetId] = useState('');
  const [name, setName] = useState('');
  const [materialOptions, setMaterialOptions] = useState<{ value: string; label: string; filterText: string }[]>([]);
  const [selectedMaterial, setSelectedMaterial] = useState('');
  // 创意文案
  const [crTitles, setCrTitles] = useState<string[]>(['']);
  const [crBodies, setCrBodies] = useState<string[]>(['']);
  const [optimizationType, setOptimizationType] = useState('REGULAR');
  const [crLinkUrl, setCrLinkUrl] = useState('');
  const [crCtaType, setCrCtaType] = useState('INSTALL_MOBILE_APP');
  const [showMoreParams, setShowMoreParams] = useState(false);
  const [crLinkDesc, setCrLinkDesc] = useState('');
  const [crUrlTags, setCrUrlTags] = useState('');
  // 共创
  const [partnershipMode, setPartnershipMode] = useState<'brand_only' | 'brand_creator' | 'creator_primary'>('brand_only');
  const [brandedPermissions, setBrandedPermissions] = useState<BrandedContentPermission[]>([]);
  const [selectedCreator, setSelectedCreator] = useState('');
  const [availablePages, setAvailablePages] = useState<AvailablePage[]>([]);
  const [selectedPage, setSelectedPage] = useState('');

  useEffect(() => {
    fetchCampaigns(accountId)
      .then(setCampaigns)
      .catch((error_: unknown) => {
        setError(error_ instanceof Error ? error_.message : '加载失败');
      });
    fetchAccountMaterials(accountId)
      .then((result) => {
        setMaterialOptions(
          result.data.map((m) => ({
            value: String(m.id),
            label: `${m.type === 'video' ? '🎬' : '🖼'} ${m.name ?? m.channel_material_id}`,
            filterText: `${m.name ?? ''} ${m.channel_material_id} ${m.type}`,
          })),
        );
      })
      .catch(() => { /* 非关键 */ });
    // 加载可用 Pages
    fetchAdAccountConfigs()
      .then((configs: AdAccountConfig[]) => {
        const cfg = configs.find((c) => c.accountId === accountId);
        if (cfg?.availablePages.length) {
          setAvailablePages(cfg.availablePages);
          const first = cfg.availablePages[0];
          if (first) setSelectedPage(first.id);
        }
      })
      .catch(() => { /* 非关键 */ });
  }, [accountId]);

  // 当选中的 Page 有关联 IG 商业账户时，加载共创权限列表
  useEffect(() => {
    const page = availablePages.find((p) => p.id === selectedPage);
    if (page?.igBusinessAccount && showModal) {
      fetchBrandedContentPermissions(accountId, page.igBusinessAccount.id)
        .then(setBrandedPermissions)
        .catch(() => { setBrandedPermissions([]); });
    } else {
      setBrandedPermissions([]);
      setSelectedCreator('');
    }
  }, [selectedPage, availablePages, showModal, accountId]);

  // 恢复上次选择的 Campaign / AdSet
  useEffect(() => {
    if (campaigns.length > 0 && !selectedCampaign) {
      const saved = globalThis.localStorage.getItem(LS_AD_CAMPAIGN_KEY);
      if (saved && campaigns.some((c) => String(c.local_id) === saved)) {
        void handleSelectCampaign(saved);
      }
    }
  }, [campaigns, selectedCampaign]);

  async function handleSelectCampaign(id: string): Promise<void> {
    setSelectedCampaign(id);
    setSelectedAdset('');
    setAds([]);
    try { globalThis.localStorage.setItem(LS_AD_CAMPAIGN_KEY, id); } catch { /* SSR */ }
    try {
      const data = await fetchAdSets(id, accountId);
      setAdsets(data);
      // 恢复上次选择的 AdSet
      const saved = globalThis.localStorage.getItem(LS_AD_ADSET_KEY);
      if (saved && data.some((a: FbAdSet) => String(a.local_id) === saved)) {
        setSelectedAdset(saved);
        void handleSelectAdgroup(saved);
      }
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '加载 AdSet 失败');
    }
  }

  async function handleSelectAdgroup(id: string): Promise<void> {
    setSelectedAdset(id);
    try { globalThis.localStorage.setItem(LS_AD_ADSET_KEY, id); } catch { /* SSR */ }
    setLoading(true);
    try {
      const data = await fetchAds(id, accountId);
      setAds(data);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '加载 Ad 失败');
    } finally {
      setLoading(false);
    }
  }

  function openModal(): void {
    // 预填当前页面选中的值，但可更改
    setModalCampaignId(selectedCampaign);
    setModalAdsetOptions(adsets);
    setModalAdsetId(selectedAdset);
    setName('');
    setSelectedMaterial('');
    setCrTitles(['']);
    setCrBodies(['']);
    setOptimizationType('REGULAR');
    setCrLinkUrl('');
    setCrCtaType('INSTALL_MOBILE_APP');
    setShowMoreParams(false);
    setCrLinkDesc('');
    setCrUrlTags('');
    setPartnershipMode('brand_only');
    setBrandedPermissions([]);
    setSelectedCreator('');
    setSelectedPage(availablePages[0]?.id ?? '');
    setError('');
    setShowModal(true);
  }

  // 弹窗内选 Campaign 时级联加载 AdGroup 选项
  async function handleModalCampaignChange(id: string): Promise<void> {
    setModalCampaignId(id);
    setModalAdsetId('');
    try {
      const data = await fetchAdSets(id, accountId);
      setModalAdsetOptions(data);
    } catch {
      setModalAdsetOptions([]);
    }
  }

  async function handleCreate(): Promise<void> {
    if (!name || !modalAdsetId) {
      setError('请填写名称和选择 AdSet');
      return;
    }
    if (!selectedMaterial) {
      setError('请选择素材');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const page = availablePages.find((p) => p.id === selectedPage);
      let igUserId: string | undefined;
      let igBrandedContent: Record<string, unknown> | undefined;

      if (partnershipMode === 'brand_creator' && selectedCreator) {
        // 品牌方做主身份 + 共创者：instagram_user_id = 创作者 IG ID
        igUserId = selectedCreator;
      } else if (partnershipMode === 'creator_primary' && page?.igBusinessAccount) {
        // 创作者做主身份：instagram_branded_content.sponsor_id = 品牌方 IG ID
        igBrandedContent = { sponsor_id: page.igBusinessAccount.id };
      }

      await createAd(
        {
          name,
          adset_id: modalAdsetId,
          ...(selectedPage ? { page_id: selectedPage } : {}),
          material_id: Number.parseInt(selectedMaterial, 10),
          titles: crTitles,
          bodies: crBodies,
          optimization_type: optimizationType,
          ...(crLinkUrl ? { link_url: crLinkUrl } : {}),
          call_to_action_type: crCtaType,
          ...(crLinkDesc ? { link_description: crLinkDesc } : {}),
          ...(crUrlTags ? { url_tags: crUrlTags } : {}),
          ...(igUserId ? { ig_user_id: igUserId } : {}),
          ...(igBrandedContent ? { instagram_branded_content: igBrandedContent } : {}),
        },
        accountId,
      );
      setShowModal(false);
      // 如果弹窗里选的 AdSet 和页面当前一样，刷新列表
      if (modalAdsetId === selectedAdset) {
        await handleSelectAdgroup(selectedAdset);
      }
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function handleRefresh(): Promise<void> {
    if (selectedCampaign.length === 0 || selectedAdset.length === 0) {
      setError('请先选择 Campaign 和 AdSet');
      return;
    }
    // 从 adsets 列表找到 FB 侧的 adset_id
    const fbAdset = adsets.find((a) => a.local_id === Number(selectedAdset));
    if (!fbAdset) {
      setError('请先同步广告组');
      return;
    }
    setRefreshing(true);
    setError('');
    try {
      // 只同步当前 AdSet 下的 Ad
      await syncAdsOnly(accountId, fbAdset.id);
      setLoading(true);
      const adData = await fetchAds(selectedAdset, accountId);
      setAds(adData);
      setLoading(false);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : '刷新失败');
      setLoading(false);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-text">广告</h2>
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
            + 创建广告
          </button>
        </div>
      </div>

      {/* 级联选择 */}
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-text-muted">Campaign：</span>
          <SearchableSelect
            options={campaigns.map((c) => buildCampaignOpt(c))}
            value={selectedCampaign}
            placeholder="搜索 Campaign…"
            onChange={(id) => { handleSelectCampaign(id).catch(() => undefined); }} // eslint-disable-line unicorn/no-useless-undefined
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-text-muted">广告组：</span>
          <SearchableSelect
            options={adsets.map((a) => buildAdSetOpt(a))}
            value={selectedAdset}
            placeholder="搜索 AdSet…"
            onChange={(id) => { handleSelectAdgroup(id).catch(() => undefined); }} // eslint-disable-line unicorn/no-useless-undefined
          />
        </label>
      </div>

      {error ? (
        <div className="rounded-md border border-red/30 bg-red/10 px-4 py-2 text-sm text-red">
          {error}
        </div>
      ) : null}

      {/* Ad 列表 */}
      {selectedAdset ? (
        loading ? (
          <div className="text-sm text-text-muted">加载中…</div>
        ) : ads.length === 0 ? (
          <div className="text-sm text-text-muted">暂无广告。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-text-muted">
                  <th className="px-3 py-2 font-medium">名称</th>
                  <th className="px-3 py-2 font-medium">产品</th>
                  <th className="px-3 py-2 font-medium">投手</th>
                  <th className="px-3 py-2 font-medium">日期</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">详情</th>
                  <th className="px-3 py-2 font-medium">复制</th>
                  <th className="px-3 py-2 font-medium">FB Ad ID</th>
                </tr>
              </thead>
              <tbody>
                {ads.map((a) => (
                  <tr key={a.id} className="border-b border-border/50">
                    <td className="px-3 py-2 font-medium">{a.name}</td>
                    <td className="px-3 py-2 text-text-dim">{a.campaign_product ?? '—'}</td>
                    <td className="px-3 py-2 text-text-dim">{a.campaign_operator ?? '—'}</td>
                    <td className="px-3 py-2 text-text-dim">{a.campaign_created_at ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className={a.effective_status === 'ACTIVE' ? 'text-green' : a.effective_status === 'PENDING_REVIEW' ? 'text-yellow' : 'text-red'}>
                        {a.effective_status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <button type="button"
                        onClick={() => { // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                        setDetailExtra(a.channel_extra ?? {}); setDetailTitle(`Ad 详情 — ${a.name}`); setShowDetail(true); }}
                        className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent">
                        详情
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <button type="button"
                        onClick={() => { setCopyTarget(a); }}
                        className="rounded-md border border-border px-2 py-1 text-xs text-text-dim transition-colors hover:border-accent hover:text-accent">
                        复制
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-text-dim">{a.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div className="text-sm text-text-muted">请先选择一个广告组。</div>
      )}

      {/* 创建弹窗 */}
      <CreateDrawer open={showModal} title="创建广告" onClose={() => { setShowModal(false); }}>
        <div className="space-y-4">
          <label className="flex flex-col gap-1 text-sm">
            Campaign
            <Dropdown tone="legacy" aria-label="Campaign" value={modalCampaignId} onChange={(v) => { void handleModalCampaignChange(v); }} options={[{ value: '', label: '-- 选择 Campaign --' }, ...campaigns.map((c) => ({ value: String(c.local_id), label: `${c.name} (${c.status})` }))]} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            AdGroup
            <Dropdown tone="legacy" aria-label="AdGroup" value={modalAdsetId} onChange={setModalAdsetId} options={[{ value: '', label: '-- 选择广告组 --' }, ...modalAdsetOptions.map((a) => ({ value: String(a.local_id), label: `${a.name} (${a.status})` }))]} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            广告名（素材名）
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); }}
              placeholder="video_001.mp4"
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-dim">选择素材</span>
            <SearchableSelect
              options={materialOptions}
              value={selectedMaterial}
              placeholder="搜索素材（图片/视频）…"
              onChange={setSelectedMaterial}
            />
          </label>
          {/* 创意文案 - 多 title / 多 body */}
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-dim">标题列表（titles）</span>
              {crTitles.map((t, i) => (
                <div key={`t-${String(i)}`} className="flex gap-2">
                  <input
                    type="text" value={t}
                    onChange={(e) => {
                      const next = [...crTitles];
                      next[i] = e.target.value;
                      setCrTitles(next);
                    }}
                    placeholder={`标题 ${String(i + 1)}`}
                    className="flex-1 rounded-md border border-border bg-bg-card px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
                  />
                  <button type="button"
                    onClick={() => { setCrTitles((prev) => prev.filter((_, idx) => idx !== i)); }}
                    className="rounded border border-red/30 px-2 py-1 text-xs text-red hover:bg-red/10">×</button>
                </div>
              ))}
              <button type="button"
                onClick={() => { setCrTitles((prev) => [...prev, '']); }}
                className="rounded border border-border px-2 py-1 text-xs text-text-dim hover:border-accent hover:text-accent">+ 添加标题</button>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-dim">正文列表（bodies）</span>
              {crBodies.map((b, i) => (
                <div key={`b-${String(i)}`} className="flex gap-2">
                  <textarea
                    value={b}
                    onChange={(e) => {
                      const next = [...crBodies];
                      next[i] = e.target.value;
                      setCrBodies(next);
                    }}
                    placeholder={`正文 ${String(i + 1)}`}
                    rows={2}
                    className="flex-1 rounded-md border border-border bg-bg-card px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
                  />
                  <button type="button"
                    onClick={() => { setCrBodies((prev) => prev.filter((_, idx) => idx !== i)); }}
                    className="rounded border border-red/30 px-2 py-1 text-xs text-red hover:bg-red/10">×</button>
                </div>
              ))}
              <button type="button"
                onClick={() => { setCrBodies((prev) => [...prev, '']); }}
                className="rounded border border-border px-2 py-1 text-xs text-text-dim hover:border-accent hover:text-accent">+ 添加正文</button>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-dim">优化类型（optimization_type）</span>
            <Dropdown tone="legacy" aria-label="优化类型" value={optimizationType} onChange={setOptimizationType} options={[{ value: 'NONE', label: 'NONE — 无优化（单一创意）' }, { value: 'REGULAR', label: 'REGULAR — 基础优化' }, { value: 'DEGREES_OF_FREEDOM', label: 'DEGREES_OF_FREEDOM — 动态创意优化（≥2 titles + ≥3 bodies）' }]} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            落地页链接（link_url）
            <input
              type="text" value={crLinkUrl}
              onChange={(e) => { setCrLinkUrl(e.target.value); }}
              placeholder="https://..."
              className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            CTA 类型
            <Dropdown tone="legacy" aria-label="CTA 类型" value={crCtaType} onChange={setCrCtaType} options={['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE', 'DOWNLOAD', 'INSTALL_MOBILE_APP', 'CONTACT_US', 'BOOK_TRAVEL', 'APPLY_NOW', 'GET_OFFER'].map((o) => ({ value: o, label: o }))} />
          </label>
          {/* 共创模式 */}
          {(() => {
            const selPage = availablePages.find((p) => p.id === selectedPage);
            const hasIg = !!selPage?.igBusinessAccount;
            return hasIg ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-text-dim">共创模式</span>
                <Dropdown tone="legacy" aria-label="共创模式" value={partnershipMode} onChange={(v) => { setPartnershipMode(v as 'brand_only' | 'brand_creator' | 'creator_primary'); }} options={[{ value: 'brand_only', label: '品牌方（普通广告）' }, { value: 'brand_creator', label: '品牌方 + 创作者（共创广告 — 品牌做主身份）' }, { value: 'creator_primary', label: '创作者（共创广告 — 创作者做主身份）' }]} />
              </label>
            ) : null;
          })()}
          {partnershipMode === 'brand_creator' && brandedPermissions.length > 0 ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-dim">选择创作者</span>
              <SearchableSelect
                options={brandedPermissions.map((p) => ({
                  value: p.creatorIgId,
                  label: `${p.creatorUsername} (${p.creatorIgId})`,
                  filterText: `${p.creatorUsername} ${p.creatorIgId}`,
                }))}
                value={selectedCreator}
                placeholder="搜索创作者…"
                onChange={setSelectedCreator}
              />
            </label>
          ) : partnershipMode === 'brand_creator' ? (
            <div className="rounded-md border border-yellow/30 bg-yellow/10 px-3 py-2 text-xs text-yellow">
              当前品牌方没有 Approved 状态的创作者，请先在 FB 后台发送共创邀请。
            </div>
          ) : null}
          {partnershipMode === 'creator_primary' ? (
            <div className="rounded-md border border-blue/30 bg-blue/10 px-3 py-2 text-xs text-blue">
              创作者做主身份：Page 选择器中的创作者 Page + 品牌方 IG 作为 sponsor_id 自动注入。
              请确保创作者已将 Page 授权给品牌方 BM。
            </div>
          ) : null}
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
                链接描述（description）
                <input
                  type="text" value={crLinkDesc}
                  onChange={(e) => { setCrLinkDesc(e.target.value); }}
                  placeholder="链接下方的简短描述"
                  className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                URL 标签（url_tags）
                <input
                  type="text" value={crUrlTags}
                  onChange={(e) => { setCrUrlTags(e.target.value); }}
                  placeholder="utm_source=facebook&utm_campaign=test"
                  className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
            </div>
          ) : null}
          {availablePages.length > 0 ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-text-dim">发布 Page</span>
              <SearchableSelect
                options={availablePages.map((p) => ({
                  value: p.id,
                  label: p.igBusinessAccount ? `${p.name} (IG: ${p.igBusinessAccount.username})` : p.name,
                  filterText: `${p.name} ${p.igBusinessAccount?.username ?? ''}`,
                }))}
                value={selectedPage}
                placeholder="选择发布 Page…"
                onChange={setSelectedPage}
              />
            </label>
          ) : (
            <div className="rounded-md border border-yellow/30 bg-yellow/10 px-3 py-2 text-xs text-yellow">
              当前 Token 没有可用 Page，无法创建广告。请先添加有 Page 权限的 Token。
            </div>
          )}
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
              disabled={busy || (availablePages.length > 0 && !selectedPage) || !selectedMaterial}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85 disabled:opacity-50"
            >
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      </CreateDrawer>
      <AdDetailDrawer open={showDetail} title={detailTitle} channelExtra={detailExtra}
        onClose={() => { setShowDetail(false); }} />
      <AdCopyDrawer open={copyTarget !== null} ad={copyTarget} campaigns={campaigns}
        accountId={accountId} availablePages={availablePages}
        onClose={() => { setCopyTarget(null); }}
        onCopied={() => { void handleSelectAdgroup(selectedAdset); }} />
    </div>
  );
}
