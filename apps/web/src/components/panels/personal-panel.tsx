'use client';

import { useCallback, useEffect, useState } from 'react';

import { AiAdviceModal, type AiAdviceTarget } from './ai-advice-modal';
import { CreateDrawer } from './create-drawer';
import { RbiModal, type RbiTarget } from './rbi-modal';
import type { PanelProps } from './types';

import { fetchTargetInfo, updateAdSet, updateCampaign } from '@/lib/client/ad/api';
import { getJsonSoft } from '@/lib/client/api';
import { fmt, fmtPct } from '@/lib/client/format';
import {
  applyCorrection,
  buildPartnershipOverlay,
  computeOperatorTotals,
  getEltvConfidence,
  getEltvMultiplier,
  OPERATOR_LABELS,
  PARTNERSHIP_OPERATOR,
  regroupPartnershipOperator,
  roasClass,
} from '@/lib/client/pb-personal';
import type {
  CorrectionFactors,
  CorrectionFactorsResponse,
  EltvMultipliers,
  EltvMultipliersResponse,
  PbChannel,
  PbOperator,
  PbPersonalData,
} from '@/lib/client/pb-personal';

interface PersonalPanelProps extends PanelProps {
  correctionMode: boolean;
}

interface Bundle {
  data: PbPersonalData | null;
  factors: CorrectionFactors;
  eltv: EltvMultipliers;
}

const DETAIL_HEADERS = [
  '渠道',
  '消耗',
  'CPM',
  'CPC',
  'CPI',
  '总收入',
  '扣费收入',
  '新用户收入',
  '新用户ROAS',
  'eLTV ROAS',
];
const NUM = 'px-2 py-1.5 text-right whitespace-nowrap overflow-hidden text-ellipsis';

// 固定列宽：第一列（名称层级）占主要宽度，其余数值列等宽收窄，让每一列在不同表格间对齐、数值间距不至于过大。
// 新增「扣费收入」列后重新分配：名称列与总收入/新用户收入列略收窄给新列腾位。
const COL_WIDTHS = ['31%', '9%', '7%', '7%', '7%', '9%', '8%', '9%', '7%', '7%'];

function d2(v: number): string {
  return `$${v.toFixed(2)}`;
}

function toggleSet(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** 个人面板 pb-personal：投手 × 产品 × 渠道 × campaign × adset × ad 明细，含修正/eLTV/AI/收入来源图。 */
export function PersonalPanel({
  startDate,
  endDate,
  correctionMode,
  onLastUpdate,
}: PersonalPanelProps): React.ReactElement {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [expandedOps, setExpandedOps] = useState<Set<string>>(new Set());
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());
  const [expandedCampaigns, setExpandedCampaigns] = useState<Set<string>>(new Set());
  const [expandedAdsets, setExpandedAdsets] = useState<Set<string>>(new Set());
  const [rbiTarget, setRbiTarget] = useState<RbiTarget | null>(null);
  const [aiTarget, setAiTarget] = useState<AiAdviceTarget | null>(null);

  // 广告操作：编辑抽屉（toggle + 改预算，撞车多 id 时批量调用）
  const [drawerTarget, setDrawerTarget] = useState<{
    kind: 'campaign' | 'adset';
    name: string;
    ids: string[];
  } | null>(null);
  const [drawerInfo, setDrawerInfo] = useState<{ status: string; daily_budget: number | null } | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [budgetValue, setBudgetValue] = useState('');
  const [actionMsg, setActionMsg] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const isRangeMode = startDate !== endDate;

  const reload = useCallback(async (): Promise<void> => {
    const [data, factorsResp, eltvResp] = await Promise.all([
      getJsonSoft<PbPersonalData>(
        `/api/postback/personal?startDate=${startDate}&endDate=${endDate}`,
      ),
      getJsonSoft<CorrectionFactorsResponse>(
        `/api/correction-factors?startDate=${startDate}&endDate=${endDate}`,
      ),
      getJsonSoft<EltvMultipliersResponse>(`/api/eltv-multipliers?date=${endDate}`),
    ]);
    setBundle({
      data,
      factors: factorsResp?.dailyFactors == null ? (factorsResp?.factors ?? {}) : {},
      eltv: eltvResp?.multipliers ?? {},
    });
  }, [startDate, endDate]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    onLastUpdate(isRangeMode ? `日期范围：${startDate} → ${endDate}` : `最后更新：${endDate}`);
  }, [onLastUpdate, isRangeMode, startDate, endDate]);

  /** 对一组 FB id 逐个解析账户并执行 action，返回成功/失败计数。 */
  async function actOnIds(
    ids: string[],
    kind: 'campaign' | 'adset',
    action: (id: string, accountId: string) => Promise<unknown>,
  ): Promise<{ ok: number; fail: number }> {
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        const { accountId } = await fetchTargetInfo(id, kind);
        await action(id, accountId);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    return { ok, fail };
  }

  /** 打开编辑抽屉：拉取首个 id 的当前状态与日预算。 */
  async function openEditDrawer(
    kind: 'campaign' | 'adset',
    name: string,
    ids: string[],
  ): Promise<void> {
    setDrawerTarget({ kind, name, ids });
    setDrawerInfo(null);
    setBudgetValue('');
    setActionMsg('');
    setDrawerLoading(true);
    try {
      const firstId = ids[0];
      if (firstId) {
        const info = await fetchTargetInfo(firstId, kind);
        setDrawerInfo({ status: info.status, daily_budget: info.daily_budget });
        setBudgetValue(info.daily_budget != null ? String(info.daily_budget / 100) : '');
      }
    } catch {
      setDrawerInfo(null);
    } finally {
      setDrawerLoading(false);
    }
  }

  /** 启动/暂停：按当前状态取反（合并成一个按钮）。 */
  async function handleToggle(): Promise<void> {
    if (!drawerTarget || !drawerInfo) return;
    const target = drawerInfo.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setActionBusy(true);
    setActionMsg('');
    const { ok, fail } = await actOnIds(drawerTarget.ids, 'campaign', (id, accountId) =>
      updateCampaign(id, { status: target }, accountId),
    );
    setActionBusy(false);
    if (fail === 0) setDrawerInfo((prev) => (prev ? { ...prev, status: target } : prev));
    setActionMsg(
      `${target === 'PAUSED' ? '暂停' : '启动'}完成：成功 ${ok}/${drawerTarget.ids.length}${fail > 0 ? `，${fail} 个失败` : ''}`,
    );
  }

  async function handleSaveBudget(): Promise<void> {
    if (!drawerTarget) return;
    const dollars = Number.parseFloat(budgetValue);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setActionMsg('请输入有效的日预算金额');
      return;
    }
    const cents = Math.round(dollars * 100);
    setActionBusy(true);
    setActionMsg('');
    const { ok, fail } = await actOnIds(drawerTarget.ids, drawerTarget.kind, (id, accountId) =>
      drawerTarget.kind === 'campaign'
        ? updateCampaign(id, { daily_budget: cents }, accountId)
        : updateAdSet(id, { daily_budget: cents }, accountId),
    );
    setActionBusy(false);
    if (fail === 0) setDrawerInfo((prev) => (prev ? { ...prev, daily_budget: cents } : prev));
    setActionMsg(
      `预算更新完成：成功 ${ok}/${drawerTarget.ids.length}${fail > 0 ? `，${fail} 个失败` : ''}`,
    );
  }

  const data = bundle?.data ?? null;
  const factors = bundle?.factors ?? {};
  const eltv = bundle?.eltv ?? {};
  const hasOps = data != null && data.operators.length > 0;
  // 合创(partnership)聚合维度：从各投手桶里合成（campaign 仍留在其投手桶内），作为额外一栏
  // 追加在投手桶之后展示；不计入顶部卡片合计（与投手桶数据有意重叠）。
  const partnershipOverlay = data ? buildPartnershipOverlay(data.operators) : null;
  const renderOps =
    data == null
      ? []
      : partnershipOverlay
        ? [...data.operators, partnershipOverlay]
        : data.operators;

  const cards = hasOps
    ? {
        cost: fmt(data.operators.reduce((s, o) => s + (o.cost ?? 0), 0)),
        rev: fmt(data.operators.reduce((s, o) => s + o.revenue, 0)),
        deducted: fmt(
          data.operators.reduce(
            (s, o) =>
              s + computeOperatorTotals(o, correctionMode, isRangeMode, factors, eltv).deducted,
            0,
          ),
        ),
        newRev: fmt(data.operators.reduce((s, o) => s + o.newUserRevenue, 0)),
        organicRev: fmt(data.organic.revenue),
        organicNew: fmt(data.organic.newUserRevenue),
        restricted: fmt(data.restricted ? data.restricted.revenue : 0),
      }
    : {
        cost: '--',
        rev: '--',
        deducted: '--',
        newRev: '--',
        organicRev: data?.organic ? fmt(data.organic.revenue) : '--',
        organicNew: data?.organic ? fmt(data.organic.newUserRevenue) : '--',
        restricted: data?.restricted ? fmt(data.restricted.revenue) : '--',
      };

  const corr = (
    value: number,
    product: string,
    channel: string,
    correctedValue: number | undefined,
  ): number =>
    applyCorrection(value, product, channel, correctedValue, correctionMode, isRangeMode, factors);

  function renderChannelRow(op: PbOperator, product: string, ch: PbChannel): React.ReactElement[] {
    const chKey = `${op.operator}|${product}|${ch.channel}`;
    // 合创重排后：product=广告组名、ch.channel=真实产品；修正/eLTV 用真实产品 + 渠道默认 FB。
    const isPartner = op.operator === PARTNERSHIP_OPERATOR;
    const cProd = isPartner ? ch.channel : product;
    const cChan = isPartner ? 'FB' : ch.channel;
    const eltvM = getEltvMultiplier(eltv, cProd, cChan);
    const eltvConf = getEltvConfidence(eltv, cProd, cChan);
    const installs = (ch.campaigns ?? []).reduce((s, c) => s + (c.installs ?? 0), 0);
    const cpi = (ch.cost ?? 0) > 0 && installs > 0 ? d2((ch.cost ?? 0) / installs) : '-';
    const rev = corr(ch.revenue, cProd, cChan, ch.correctedRevenue);
    const newRev = corr(ch.newUserRevenue, cProd, cChan, ch.correctedNewUserRevenue);
    const roas = (ch.cost ?? 0) > 0 ? fmtPct((newRev / (ch.cost ?? 1)) * 100) : '0%';
    const eltvRoas =
      eltvM != null && (ch.cost ?? 0) > 0 ? fmtPct((newRev / (ch.cost ?? 1)) * 100 * eltvM) : '-';
    const hasCampaigns = (ch.campaigns?.length ?? 0) > 0;
    const open = expandedChannels.has(chKey);

    const rows: React.ReactElement[] = [
      <tr
        key={chKey}
        onClick={
          hasCampaigns
            ? () => {
                setExpandedChannels((s) => toggleSet(s, chKey));
              }
            : undefined
        }
        className={`border-b border-border/40 text-text ${hasCampaigns ? 'cursor-pointer hover:bg-bg-card-hover' : ''}`}
      >
        <td className="px-2 py-1.5 whitespace-nowrap overflow-hidden">
          {hasCampaigns ? <span className="mr-1 text-text-muted">{open ? '▾' : '▸'}</span> : null}
          {ch.channel}
          {!isPartner && (
            <RbiButton
              onClick={() => {
                setRbiTarget({
                  level: 'channel',
                  operator: op.operator,
                  product,
                  channel: ch.channel,
                  date: endDate,
                });
              }}
            />
          )}
        </td>
        <td className={`${NUM} text-yellow`}>{(ch.cost ?? 0) > 0 ? fmt(ch.cost) : '-'}</td>
        <td className={NUM}>{(ch.cpm ?? 0) > 0 ? fmt(ch.cpm) : '-'}</td>
        <td className={NUM}>{(ch.cpc ?? 0) > 0 ? fmt(ch.cpc) : '-'}</td>
        <td className={NUM}>{cpi}</td>
        <td className={NUM}>{fmt(rev)}</td>
        <td className={NUM}>
          {fmt(corr(ch.deductedRevenue ?? 0, cProd, cChan, ch.correctedDeductedRevenue))}
        </td>
        <td className={`${NUM} text-green`}>{fmt(newRev)}</td>
        <td className={`${NUM} ${roasClass(newRev, ch.cost)}`}>{roas}</td>
        <td
          className={`${NUM} ${eltvM != null && (ch.cost ?? 0) > 0 ? roasClass(newRev * eltvM, ch.cost) : 'text-text-dim'}`}
        >
          {eltvRoas}
          {eltvConf ? (
            <span className={`ml-1 text-[0.7rem] ${eltvConf.cls}`}>({eltvConf.label})</span>
          ) : null}
        </td>
      </tr>,
    ];

    if (hasCampaigns && open) {
      for (let ci = 0; ci < (ch.campaigns?.length ?? 0); ci++) {
        rows.push(...renderCampaignRow(op, product, ch, ci));
      }
    }
    return rows;
  }

  function renderCampaignRow(
    op: PbOperator,
    product: string,
    ch: PbChannel,
    campIdx: number,
  ): React.ReactElement[] {
    const camp = ch.campaigns?.[campIdx];
    if (!camp) return [];
    const campKey = `${op.operator}|${product}|${ch.channel}|${campIdx.toString()}`;
    const isPartner = op.operator === PARTNERSHIP_OPERATOR;
    const cProd = isPartner ? ch.channel : product;
    const cChan = isPartner ? 'FB' : ch.channel;
    const eltvM = getEltvMultiplier(eltv, cProd, cChan);
    const cost = camp.cost ?? 0;
    const rev = corr(camp.revenue, cProd, cChan, camp.correctedRevenue);
    const newRev = corr(camp.newUserRevenue, cProd, cChan, camp.correctedNewUserRevenue);
    const dedRev = corr(camp.deductedRevenue ?? 0, cProd, cChan, camp.correctedDeductedRevenue);
    const roasStr =
      cost > 0 || newRev > 0 ? (cost > 0 ? fmtPct((newRev / cost) * 100) : '0%') : '-';
    const eltvRoas = eltvM != null && cost > 0 ? fmtPct((newRev / cost) * 100 * eltvM) : '-';
    const hasAdsets = (camp.adsets?.length ?? 0) > 0;
    const open = expandedCampaigns.has(campKey);

    const rows: React.ReactElement[] = [
      <tr
        key={campKey}
        onClick={
          hasAdsets
            ? () => {
                setExpandedCampaigns((s) => toggleSet(s, campKey));
              }
            : undefined
        }
        className={`border-b border-border/30 bg-bg-dark/30 text-text-dim ${hasAdsets ? 'cursor-pointer hover:bg-bg-card-hover' : ''}`}
      >
        <td className="px-2 py-1 pl-6 whitespace-nowrap overflow-hidden">
          {hasAdsets ? <span className="mr-1 text-text-muted">{open ? '▾' : '▸'}</span> : null}
          {camp.campaign}
          {!isPartner && (
            <>
              <AiButton
                onClick={() => {
                  setAiTarget({
                    campaign: camp.campaign,
                    product,
                    channel: ch.channel,
                    operator: op.operator,
                    date: endDate,
                  });
                }}
              />
              <RbiButton
                onClick={() => {
                  setRbiTarget({
                    level: 'campaign',
                    operator: op.operator,
                    product,
                    channel: ch.channel,
                    campaign: camp.campaign,
                    date: endDate,
                  });
                }}
              />
            </>
          )}
          {ch.channel === 'FB' && (camp.campaignIds?.length ?? 0) > 0 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void openEditDrawer('campaign', camp.campaign, camp.campaignIds ?? []);
              }}
              title="编辑（启动/暂停 + 改预算）"
              className="ml-1.5 rounded border border-border px-1 text-[0.7rem] hover:border-accent"
            >
              编辑
            </button>
          ) : null}
        </td>
        <td className={`${NUM} text-yellow`}>{cost > 0 ? fmt(cost) : '-'}</td>
        <td className={NUM}>
          {(camp.impressions ?? 0) > 0 ? d2((cost / (camp.impressions ?? 1)) * 1000) : '-'}
        </td>
        <td className={NUM}>{(camp.clicks ?? 0) > 0 ? d2(cost / (camp.clicks ?? 1)) : '-'}</td>
        <td className={NUM}>
          {cost > 0 && (camp.installs ?? 0) > 0 ? d2(cost / (camp.installs ?? 1)) : '-'}
        </td>
        <td className={NUM}>{rev > 0 ? fmt(rev) : '-'}</td>
        <td className={NUM}>{dedRev > 0 ? fmt(dedRev) : '-'}</td>
        <td className={`${NUM} text-green`}>{newRev > 0 ? fmt(newRev) : '-'}</td>
        <td className={`${NUM} ${roasClass(newRev, cost)}`}>{roasStr}</td>
        <td
          className={`${NUM} ${eltvM != null && cost > 0 ? roasClass(newRev * eltvM, cost) : 'text-text-dim'}`}
        >
          {eltvRoas}
        </td>
      </tr>,
    ];

    if (hasAdsets && open) {
      for (let ai = 0; ai < (camp.adsets?.length ?? 0); ai++) {
        rows.push(...renderAdsetRow(op, product, ch, campIdx, ai));
      }
    }
    return rows;
  }

  function renderAdsetRow(
    op: PbOperator,
    product: string,
    ch: PbChannel,
    campIdx: number,
    adsetIdx: number,
  ): React.ReactElement[] {
    const adset = ch.campaigns?.[campIdx]?.adsets?.[adsetIdx];
    if (!adset) return [];
    const adsetKey = `${op.operator}|${product}|${ch.channel}|${campIdx.toString()}|${adsetIdx.toString()}`;
    const isPartner = op.operator === PARTNERSHIP_OPERATOR;
    const cProd = isPartner ? ch.channel : product;
    const cChan = isPartner ? 'FB' : ch.channel;
    const eltvM = getEltvMultiplier(eltv, cProd, cChan);
    const cost = adset.cost ?? 0;
    const rev = corr(adset.revenue, cProd, cChan, adset.correctedRevenue);
    const newRev = corr(adset.newUserRevenue, cProd, cChan, adset.correctedNewUserRevenue);
    const dedRev = corr(adset.deductedRevenue ?? 0, cProd, cChan, adset.correctedDeductedRevenue);
    const roasStr =
      cost > 0 || newRev > 0 ? (cost > 0 ? fmtPct((newRev / cost) * 100) : '0%') : '-';
    const eltvRoas = eltvM != null && cost > 0 ? fmtPct((newRev / cost) * 100 * eltvM) : '-';
    const hasAds = (adset.ads?.length ?? 0) > 0;
    const open = expandedAdsets.has(adsetKey);

    const rows: React.ReactElement[] = [
      <tr
        key={adsetKey}
        onClick={
          hasAds
            ? () => {
                setExpandedAdsets((s) => toggleSet(s, adsetKey));
              }
            : undefined
        }
        className={`border-b border-border/20 bg-bg-dark/50 text-text-muted ${hasAds ? 'cursor-pointer hover:bg-bg-card-hover' : ''}`}
      >
        <td className="px-2 py-1 pl-10 whitespace-nowrap overflow-hidden">
          {hasAds ? <span className="mr-1">{open ? '▾' : '▸'}</span> : null}
          {adset.adset}
          {ch.channel === 'FB' && (adset.adsetIds?.length ?? 0) > 0 ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void openEditDrawer('adset', adset.adset, adset.adsetIds ?? []);
              }}
              title="编辑（改预算）"
              className="ml-1.5 rounded border border-border px-1 text-[0.7rem] hover:border-accent"
            >
              编辑
            </button>
          ) : null}
        </td>
        <td className={`${NUM} text-yellow`}>{cost > 0 ? fmt(cost) : '-'}</td>
        <td className={NUM}>
          {(adset.impressions ?? 0) > 0 ? d2((cost / (adset.impressions ?? 1)) * 1000) : '-'}
        </td>
        <td className={NUM}>{(adset.clicks ?? 0) > 0 ? d2(cost / (adset.clicks ?? 1)) : '-'}</td>
        <td className={NUM}>-</td>
        <td className={NUM}>{rev > 0 ? fmt(rev) : '-'}</td>
        <td className={NUM}>{dedRev > 0 ? fmt(dedRev) : '-'}</td>
        <td className={`${NUM} text-green`}>{newRev > 0 ? fmt(newRev) : '-'}</td>
        <td className={`${NUM} ${roasClass(newRev, cost)}`}>{roasStr}</td>
        <td
          className={`${NUM} ${eltvM != null && cost > 0 ? roasClass(newRev * eltvM, cost) : 'text-text-dim'}`}
        >
          {eltvRoas}
        </td>
      </tr>,
    ];

    if (hasAds && open) {
      for (const ad of adset.ads ?? []) {
        const adRev = corr(ad.revenue, cProd, cChan, ad.correctedRevenue);
        const adNewRev = corr(ad.newUserRevenue, cProd, cChan, ad.correctedNewUserRevenue);
        const adDedRev = corr(ad.deductedRevenue ?? 0, cProd, cChan, ad.correctedDeductedRevenue);
        rows.push(
          <tr
            key={`${adsetKey}|${ad.ad}`}
            className="border-b border-border/10 bg-bg-dark/70 text-text-muted"
          >
            <td className="px-2 py-1 pl-14 truncate">{ad.ad}</td>
            <td className={NUM}>-</td>
            <td className={NUM}>-</td>
            <td className={NUM}>-</td>
            <td className={NUM}>-</td>
            <td className={NUM}>{adRev > 0 ? fmt(adRev) : '-'}</td>
            <td className={NUM}>{adDedRev > 0 ? fmt(adDedRev) : '-'}</td>
            <td className={`${NUM} text-green`}>{adNewRev > 0 ? fmt(adNewRev) : '-'}</td>
            <td className={NUM}>-</td>
            <td className={NUM}>-</td>
          </tr>,
        );
      }
    }
    return rows;
  }

  function renderOperator(op: PbOperator): React.ReactElement {
    const label = OPERATOR_LABELS[op.operator] ?? op.operator;
    const hasCost = op.cost != null && op.cost > 0;
    // 顶部汇总用原始 op（正常结构，computeOperatorTotals 内部已对合创按 FB 口径处理）。
    const t = computeOperatorTotals(op, correctionMode, isRangeMode, factors, eltv);
    const open = expandedOps.has(op.operator);
    // 合创(partnership)：桶内先按 subOperator 二级分「投手/test/未匹配」，每个二级组再按
    // 广告组名重排展示（展示逻辑与合创单桶一致）。非合创：直接按正常结构展示。
    const isPartner = op.operator === PARTNERSHIP_OPERATOR;

    return (
      <div
        key={op.operator}
        className="mb-3 overflow-hidden rounded-card border border-border bg-bg-card"
      >
        <div
          onClick={() => {
            setExpandedOps((s) => toggleSet(s, op.operator));
          }}
          className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-[0.85rem] hover:bg-bg-card-hover"
        >
          <span className="text-[1.125rem] font-bold text-text">
            {label}{' '}
            <span className="text-[0.9rem] font-normal text-text-muted">({op.operator})</span>
            <RbiButton
              onClick={() => {
                setRbiTarget({ level: 'operator', operator: op.operator, date: endDate });
              }}
            />
          </span>
          <div className="flex flex-1 items-center justify-end gap-0">
            <Stat value={hasCost ? fmt(op.cost) : '-'} label="消耗" cls="text-yellow" />
            <Stat value={fmt(t.rev)} label="总收入" />
            <Stat value={fmt(t.deducted)} label="扣费收入" />
            <Stat value={fmt(t.newRev)} label="新用户" cls="text-green" />
            <Stat
              value={t.roas == null ? '0%' : fmtPct(t.roas)}
              label="新ROAS"
              cls={t.roas == null ? 'text-text-dim' : t.roas >= 100 ? 'text-green' : 'text-red'}
            />
            <Stat
              value={t.eltvRoas == null ? '-' : fmtPct(t.eltvRoas)}
              label="eLTV"
              cls={
                t.eltvRoas == null ? 'text-text-dim' : t.eltvRoas >= 100 ? 'text-green' : 'text-red'
              }
            />
            <span
              className={`ml-3 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
            >
              ▾
            </span>
          </div>
        </div>
        {open ? (
          <div className="border-t border-border px-4 py-3">
            {isPartner
              ? renderProductTables(regroupPartnershipOperator(op))
              : renderProductTables(op)}
          </div>
        ) : null}
      </div>
    );
  }

  /**
   * 渲染一个 op 的「产品→表格」明细块。dop.operator 决定 keys 与是否合创口径：
   * 合创（整桶或二级组复合键）时第一列表头为「产品」、隐藏下钻按钮、修正按真实产品+FB。
   */
  function renderProductTables(dop: PbOperator): React.ReactElement[] {
    const partner = dop.operator === PARTNERSHIP_OPERATOR;
    const headers = partner ? ['产品', ...DETAIL_HEADERS.slice(1)] : DETAIL_HEADERS;
    return dop.products.map((prod) => (
      <div key={prod.product} className="mb-4">
        <div className="mb-1 flex items-center text-sm font-semibold text-text">
          {partner ? <span className="mr-1 text-text-muted">广告组</span> : null}
          {prod.product}
          {!partner && (
            <RbiButton
              onClick={() => {
                setRbiTarget({
                  level: 'product',
                  operator: dop.operator,
                  product: prod.product,
                  date: endDate,
                });
              }}
            />
          )}
        </div>
        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="w-full table-fixed text-[0.8rem]">
            <colgroup>
              {COL_WIDTHS.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-border text-text-dim">
                <th className="px-2 py-1.5 text-left font-semibold">{headers[0]}</th>
                {headers.slice(1).map((h) => (
                  <th key={h} className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{prod.channels.flatMap((ch) => renderChannelRow(dop, prod.product, ch))}</tbody>
          </table>
        </div>
      </div>
    ));
  }

  return (
    <div>
      <section className="grid grid-cols-2 gap-4 p-6 md:grid-cols-3 xl:grid-cols-7">
        <Card label="付费渠道总消耗" value={cards.cost} valueCls="text-yellow" />
        <Card label="付费渠道总收入" value={cards.rev} />
        <Card label="付费渠道扣费收入" value={cards.deducted} />
        <Card label="付费渠道新用户收入" value={cards.newRev} />
        <Card label="Organic 总收入" value={cards.organicRev} />
        <Card label="Organic 新用户收入" value={cards.organicNew} />
        <Card label="AF Restricted 收入" value={cards.restricted} valueCls="text-text-muted" />
      </section>

      <section className="px-6 pb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-text">投手 × 产品 × 渠道明细</h2>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/downloads/richang-daily-data.skill"
              download
              title="下载「AF/AD 数据取数接口」Skill（对方 agent 用飞书授权登录后即可取 AF/AD 原始数据：提供飞书用户名 → 在飞书点确认卡片即获登录态；未登录过则返回授权链接。Skill 不含凭证）"
              className="rounded-md border border-border bg-bg-card px-2 py-1 text-xs text-text no-underline hover:bg-bg-card-hover"
            >
              ⬇ 取数接口 Skill
            </a>
            <span
              className="whitespace-nowrap text-[11px] text-text-muted"
              title="接口保护策略有更新时此日期会变，请及时重新下载最新版 Skill"
            >
              最近更新：2026-07-16
            </span>
          </div>
        </div>
        {hasOps ? (
          renderOps.map((op) => renderOperator(op))
        ) : (
          <div className="rounded-card border border-border bg-bg-card p-6 text-center text-text-muted">
            {data == null ? '加载中...' : '该日暂无付费渠道数据'}
          </div>
        )}
      </section>

      {rbiTarget ? (
        <RbiModal
          target={rbiTarget}
          onClose={() => {
            setRbiTarget(null);
          }}
        />
      ) : null}
      {aiTarget ? (
        <AiAdviceModal
          target={aiTarget}
          onClose={() => {
            setAiTarget(null);
          }}
        />
      ) : null}

      <CreateDrawer
        open={drawerTarget !== null}
        title={`编辑 — ${drawerTarget?.name ?? ''}`}
        onClose={() => {
          setDrawerTarget(null);
        }}
      >
        <div className="space-y-4">
          {drawerTarget && drawerTarget.ids.length > 1 ? (
            <div className="rounded-md border border-yellow/30 bg-yellow/10 px-3 py-2 text-xs text-yellow">
              该名称对应 {String(drawerTarget.ids.length)} 个 FB
              {drawerTarget.kind === 'campaign' ? '系列' : '广告组'}，操作将同时应用到所有。
            </div>
          ) : null}

          {drawerLoading ? (
            <div className="text-sm text-text-muted">加载中…</div>
          ) : drawerInfo ? (
            <>
              <div className="flex items-center justify-between rounded-md border border-border bg-bg-card px-3 py-2">
                <span className="text-sm text-text-dim">当前状态</span>
                <span
                  className={`text-sm font-semibold ${drawerInfo.status === 'ACTIVE' ? 'text-green' : 'text-yellow'}`}
                >
                  {drawerInfo.status}
                </span>
              </div>

              {drawerTarget?.kind === 'campaign' ? (
                <button
                  type="button"
                  onClick={() => {
                    void handleToggle();
                  }}
                  disabled={actionBusy}
                  className="w-full rounded-md border border-accent/50 px-4 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
                >
                  {actionBusy ? '处理中…' : drawerInfo.status === 'ACTIVE' ? '暂停' : '启动'}
                </button>
              ) : null}

              <label className="flex flex-col gap-1 text-sm">
                日预算 ($)
                <input
                  type="number"
                  value={budgetValue}
                  onChange={(e) => {
                    setBudgetValue(e.target.value);
                  }}
                  className="w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text outline-none focus:border-accent"
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  void handleSaveBudget();
                }}
                disabled={actionBusy}
                className="w-full rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg-dark transition-opacity hover:opacity-85 disabled:opacity-50"
              >
                {actionBusy ? '保存中…' : '保存预算'}
              </button>
            </>
          ) : (
            <div className="text-sm text-text-muted">无法获取该对象信息（可能未同步或已删除）。</div>
          )}
        </div>
      </CreateDrawer>

      {actionMsg ? (
        <div className="fixed bottom-4 right-4 z-[9000] flex items-center gap-3 rounded-lg border border-border bg-bg-card px-4 py-2 text-sm text-text shadow-card">
          <span>{actionMsg}</span>
          <button
            type="button"
            onClick={() => {
              setActionMsg('');
            }}
            className="text-text-dim hover:text-text"
          >
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Card({
  label,
  value,
  valueCls,
}: {
  label: string;
  value: string;
  valueCls?: string;
}): React.ReactElement {
  return (
    <div className="rounded-card border border-border bg-bg-card p-4 shadow-card">
      <div className="text-[0.8rem] text-text-dim">{label}</div>
      <div className={`mt-1 text-xl font-bold ${valueCls ?? 'text-text'}`}>{value}</div>
    </div>
  );
}

function Stat({
  value,
  label,
  cls,
}: {
  value: string;
  label: string;
  cls?: string;
}): React.ReactElement {
  return (
    <span className="flex w-[8%] flex-col items-end leading-tight">
      <span className={`text-[0.98rem] font-semibold ${cls ?? 'text-text'}`}>{value}</span>
      <span className="text-[0.79rem] text-text-muted">{label}</span>
    </span>
  );
}

function RbiButton({ onClick }: { onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title="收入来源（按安装日期）"
      className="ml-1.5 rounded border border-border px-1 text-[0.7rem] hover:border-accent"
    >
      📈
    </button>
  );
}

function AiButton({ onClick }: { onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title="AI 投放建议"
      className="ml-1.5 rounded border border-accent/50 px-1 text-[0.7rem] text-accent hover:bg-accent/10"
    >
      ✨AI
    </button>
  );
}
