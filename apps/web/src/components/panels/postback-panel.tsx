'use client';

import { useCallback, useEffect, useState } from 'react';

import type { PanelProps } from './types';

import { getJsonSoft } from '@/lib/client/api';
import { fmt } from '@/lib/client/format';

interface PbChannel {
  channel: string;
  count: number;
  revenue: number;
}

interface PbProduct {
  product: string;
  count: number;
  revenue: number;
  channels: PbChannel[];
}

interface PbSection {
  products?: PbProduct[];
  totals?: { count: number; revenue: number };
}

interface PostbackData {
  af?: PbSection;
  ad?: PbSection;
  products?: PbProduct[];
  totals?: { count: number; revenue: number };
}

function toggleSet(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** API 接收数据面板 postback：af_purchase / ad_purchase 两段的产品×渠道明细，跟随顶栏日期。 */
export function PostbackPanel({ startDate, endDate, onLastUpdate }: PanelProps): React.ReactElement {
  const [data, setData] = useState<PostbackData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const isRangeMode = startDate !== endDate;

  const reload = useCallback(async (): Promise<void> => {
    setLoaded(false);
    const d = await getJsonSoft<PostbackData>(`/api/postback/data?startDate=${startDate}&endDate=${endDate}`);
    setData(d);
    setLoaded(true);
  }, [startDate, endDate]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    onLastUpdate(isRangeMode ? `日期范围：${startDate} → ${endDate}` : `最后更新：${endDate}`);
  }, [onLastUpdate, isRangeMode, startDate, endDate]);

  const af: PbSection = data?.af ?? {
    products: data?.products ?? [],
    totals: data?.totals ?? { count: 0, revenue: 0 },
  };
  const ad: PbSection = data?.ad ?? { products: [], totals: { count: 0, revenue: 0 } };

  const afProducts = af.products ?? [];
  const adProducts = ad.products ?? [];

  return (
    <div>
      <section className="grid grid-cols-2 gap-4 p-6 md:grid-cols-4">
        <Card label="af_purchase 笔数" value={afProducts.length > 0 ? (af.totals?.count ?? 0).toLocaleString() : '--'} />
        <Card label="af_purchase 金额" value={afProducts.length > 0 ? fmt(af.totals?.revenue) : '--'} />
        <Card label="ad_purchase 笔数" value={adProducts.length > 0 ? (ad.totals?.count ?? 0).toLocaleString() : '--'} />
        <Card label="ad_purchase 金额" value={adProducts.length > 0 ? fmt(ad.totals?.revenue) : '--'} />
      </section>

      <section className="px-6 pb-6">
        <h2 className="mb-3 text-lg font-bold text-text">产品 × 渠道明细（af_purchase）</h2>
        <ProductList
          products={afProducts}
          prefix="af"
          expanded={expanded}
          onToggle={(k) => { setExpanded((s) => toggleSet(s, k)); }}
          emptyText={loaded ? '该日暂无 af_purchase 数据' : '加载中...'}
        />
      </section>

      <section className="px-6 pb-6">
        <h2 className="mb-3 text-lg font-bold text-text">产品 × 渠道明细（ad_purchase）</h2>
        <ProductList
          products={adProducts}
          prefix="ad"
          expanded={expanded}
          onToggle={(k) => { setExpanded((s) => toggleSet(s, k)); }}
          emptyText={loaded ? '该日暂无 ad_purchase 数据' : '加载中...'}
        />
      </section>
    </div>
  );
}

function ProductList({
  products,
  prefix,
  expanded,
  onToggle,
  emptyText,
}: {
  products: PbProduct[];
  prefix: string;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  emptyText: string;
}): React.ReactElement {
  if (products.length === 0) {
    return <div className="rounded-card border border-border bg-bg-card p-6 text-center text-text-muted">{emptyText}</div>;
  }
  return (
    <div className="flex flex-col gap-2">
      {products.map((product) => {
        const key = `${prefix}|${product.product}`;
        const open = expanded.has(key);
        const channelMax = Math.max(...product.channels.map((c) => c.revenue), 1);
        return (
          <div key={key} className="overflow-hidden rounded-card border border-border bg-bg-card">
            <div
              onClick={() => { onToggle(key); }}
              className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-bg-card-hover"
            >
              <span className="font-semibold text-text">{product.product}</span>
              <div className="flex items-center gap-5 text-sm">
                <span className="flex items-baseline gap-1">
                  <span className="font-semibold text-text">{product.count.toLocaleString()}</span>
                  <span className="text-[0.7rem] text-text-muted">笔</span>
                </span>
                <span className="font-semibold text-text">{fmt(product.revenue)}</span>
                <span className={`text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
              </div>
            </div>
            {open ? (
              <div className="border-t border-border px-4 py-3">
                <div className="overflow-x-auto rounded-md border border-border/60">
                  <table className="w-full text-[0.8rem]">
                    <thead>
                      <tr className="border-b border-border text-text-dim">
                        <th className="px-2 py-1.5 text-left font-semibold">渠道</th>
                        <th className="px-2 py-1.5 text-right font-semibold">笔数</th>
                        <th className="px-2 py-1.5 text-right font-semibold">金额</th>
                        <th className="px-2 py-1.5 text-right font-semibold">占比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {product.channels.map((ch) => {
                        const pct = product.revenue > 0 ? (ch.revenue / product.revenue) * 100 : 0;
                        const barW = Math.max(2, Math.round((ch.revenue / channelMax) * 60));
                        return (
                          <tr key={ch.channel} className="border-b border-border/30 text-text">
                            <td className="px-2 py-1.5 whitespace-nowrap">{ch.channel}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">{ch.count.toLocaleString()}</td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap">
                              <span
                                className="mr-2 inline-block h-2 rounded-sm bg-accent align-middle"
                                style={{ width: `${barW.toString()}px` }}
                              />
                              {fmt(ch.revenue)}
                            </td>
                            <td className="px-2 py-1.5 text-right whitespace-nowrap text-text-dim">{pct.toFixed(1)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded-card border border-border bg-bg-card p-4 shadow-card">
      <div className="text-[0.8rem] text-text-dim">{label}</div>
      <div className="mt-1 text-xl font-bold text-text">{value}</div>
    </div>
  );
}
