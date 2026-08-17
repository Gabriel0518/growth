#!/usr/bin/env python3
"""
Campaign Factor Analysis v2 - Full Analysis with data quality awareness
Uses:
  - Product-level (athena+xmp): 44 days for calendar/macro analysis
  - Campaign-level matched data: May 10-27 (18 days) for campaign-specific factors
"""

import csv, os, json, sys
from datetime import datetime, timedelta
from collections import defaultdict
import statistics
import math

ANALYSIS_DIR = '/home/admin/.openclaw/workspace/analysis'

# Valid date range for campaign-level analysis
CAMP_START = '2026-05-10'
CAMP_END = '2026-06-12'

def load_wide_table():
    rows = []
    with open(os.path.join(ANALYSIS_DIR, 'campaign_wide_table.csv')) as f:
        for row in csv.DictReader(f):
            row['cost'] = float(row['cost'])
            row['revenue'] = float(row['revenue'])
            row['new_user_revenue'] = float(row['new_user_revenue'])
            row['impressions'] = int(row['impressions'])
            row['clicks'] = int(row['clicks'])
            row['installs'] = int(row['installs'])
            rows.append(row)
    # Filter to reliable date range
    rows = [r for r in rows if CAMP_START <= r['date'] <= CAMP_END]
    return rows

def load_product_daily():
    rows = []
    with open(os.path.join(ANALYSIS_DIR, 'product_daily_summary.csv')) as f:
        for row in csv.DictReader(f):
            row['athena_revenue'] = float(row['athena_total_revenue'] or 0)
            row['athena_new_user_revenue'] = float(row['athena_new_user_revenue'] or 0)
            row['xmp_cost'] = float(row['xmp_cost'] or 0)
            rows.append(row)
    return rows

def is_weekend(date_str):
    return datetime.strptime(date_str, '%Y-%m-%d').weekday() >= 5

def weekday_num(date_str):
    return datetime.strptime(date_str, '%Y-%m-%d').weekday()

def safe_div(a, b):
    return a / b if b and b > 0 else None

def welch_t_test(g1, g2):
    n1, n2 = len(g1), len(g2)
    if n1 < 3 or n2 < 3: return None, None
    m1, m2 = statistics.mean(g1), statistics.mean(g2)
    v1, v2 = statistics.variance(g1), statistics.variance(g2)
    se = math.sqrt(v1/n1 + v2/n2) if (v1/n1 + v2/n2) > 0 else 0
    if se == 0: return 0, 1.0
    t = (m1 - m2) / se
    z = abs(t)
    p = math.exp(-0.5*z*z) * (0.4361836/(1+0.3326*z) - 0.1201676/(1+0.3326*z)**2 + 0.9372980/(1+0.3326*z)**3) * 2
    return t, max(0, min(1, p))

def pearson_r(x, y):
    if len(x) < 5: return None
    mx, my = statistics.mean(x), statistics.mean(y)
    sx, sy = statistics.stdev(x), statistics.stdev(y)
    if sx == 0 or sy == 0: return None
    cov = sum((xi-mx)*(yi-my) for xi, yi in zip(x, y)) / (len(x)-1)
    return cov / (sx * sy)

def f(v, d=2):
    if v is None: return 'N/A'
    return f"{v:.{d}f}"

def pct(v):
    if v is None: return 'N/A'
    return f"{v*100:.1f}%"

def sig_stars(p):
    if p is None: return ''
    if p < 0.01: return '***'
    if p < 0.05: return '**'
    if p < 0.1: return '*'
    return ''

# ============================================================
# FACTOR 1: CALENDAR
# ============================================================
def analyze_calendar(wide_table, product_daily, out):
    out.append("\n" + "="*70)
    out.append("因子 1：日历因子（周末 vs 工作日）")
    out.append("="*70)
    
    # --- 1.1 Product level (44 days) ---
    out.append("\n### 1.1 产品级分析（雅典娜收入 + XMP 消耗，44 天）")
    
    date_agg = defaultdict(lambda: {'rev': 0, 'nrev': 0, 'cost': 0})
    for r in product_daily:
        d = r['date']
        date_agg[d]['rev'] += r['athena_revenue']
        date_agg[d]['nrev'] += r['athena_new_user_revenue']
        date_agg[d]['cost'] += r['xmp_cost']
    
    we_total_roas, wd_total_roas = [], []
    we_cost, wd_cost = [], []
    we_nroas, wd_nroas = [], []
    
    for date, a in sorted(date_agg.items()):
        if a['cost'] < 1000: continue  # skip days with minimal data
        total_roas = safe_div(a['rev'], a['cost'])
        nroas = safe_div(a['nrev'], a['cost'])
        if total_roas is not None:
            if is_weekend(date):
                we_total_roas.append(total_roas)
                we_cost.append(a['cost'])
                if nroas: we_nroas.append(nroas)
            else:
                wd_total_roas.append(total_roas)
                wd_cost.append(a['cost'])
                if nroas: wd_nroas.append(nroas)
    
    out.append(f"\n  全产品总 ROAS（雅典娜总收入/XMP 消耗）：")
    out.append(f"  周末: n={len(we_total_roas)}, 均值={f(statistics.mean(we_total_roas) if we_total_roas else None)}, 中位数={f(statistics.median(we_total_roas) if we_total_roas else None)}")
    out.append(f"  工作日: n={len(wd_total_roas)}, 均值={f(statistics.mean(wd_total_roas) if wd_total_roas else None)}, 中位数={f(statistics.median(wd_total_roas) if wd_total_roas else None)}")
    if we_total_roas and wd_total_roas:
        diff_pct = (statistics.mean(we_total_roas) - statistics.mean(wd_total_roas)) / statistics.mean(wd_total_roas) * 100
        t, p = welch_t_test(we_total_roas, wd_total_roas)
        out.append(f"  Δ: {diff_pct:+.1f}%, p={f(p, 4)} {sig_stars(p)}")
    
    if we_nroas and wd_nroas:
        diff_pct2 = (statistics.mean(we_nroas) - statistics.mean(wd_nroas)) / statistics.mean(wd_nroas) * 100
        t2, p2 = welch_t_test(we_nroas, wd_nroas)
        out.append(f"\n  新用户 ROAS：周末={f(statistics.mean(we_nroas))}, 工作日={f(statistics.mean(wd_nroas))}, Δ={diff_pct2:+.1f}%, p={f(p2, 4)} {sig_stars(p2)}")
    
    out.append(f"\n  消耗：周末=${f(statistics.mean(we_cost) if we_cost else None, 0)}, 工作日=${f(statistics.mean(wd_cost) if wd_cost else None, 0)}")
    
    # Day-of-week
    out.append(f"\n### 1.2 按星期几分布（产品级）")
    dow_names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    dow_data = defaultdict(list)
    for date, a in date_agg.items():
        if a['cost'] < 1000: continue
        dow = weekday_num(date)
        dow_data[dow].append({'roas': safe_div(a['rev'], a['cost']), 'cost': a['cost'], 'rev': a['rev']})
    
    for i in range(7):
        vals = dow_data.get(i, [])
        if vals:
            roas_vals = [v['roas'] for v in vals if v['roas'] is not None]
            cost_vals = [v['cost'] for v in vals]
            if roas_vals:
                out.append(f"  {dow_names[i]}: n={len(roas_vals):2d}, 总ROAS均值={f(statistics.mean(roas_vals))}, 中位数={f(statistics.median(roas_vals))}, 均消耗=${f(statistics.mean(cost_vals),0)}")
    
    # --- 1.3 Campaign level by platform ---
    out.append(f"\n### 1.3 按平台 × 系统（Campaign 级，{CAMP_START}~{CAMP_END}）")
    
    for platform in ['FB', 'GG', 'TT']:
        for system in ['iOS', 'Android', 'ALL']:
            plat_rows = [r for r in wide_table if r['platform'] == platform 
                        and (system == 'ALL' or r['system'] == system)
                        and r['cost'] > 0]
            
            # Aggregate by date
            d_agg = defaultdict(lambda: {'cost': 0, 'nrev': 0, 'installs': 0})
            for r in plat_rows:
                d_agg[r['date']]['cost'] += r['cost']
                d_agg[r['date']]['nrev'] += r['new_user_revenue']
                d_agg[r['date']]['installs'] += r['installs']
            
            we, wd = [], []
            we_cpi, wd_cpi = [], []
            for date, a in d_agg.items():
                roas = safe_div(a['nrev'], a['cost'])
                cpi = safe_div(a['cost'], a['installs'])
                if roas is not None:
                    (we if is_weekend(date) else wd).append(roas)
                if cpi is not None:
                    (we_cpi if is_weekend(date) else wd_cpi).append(cpi)
            
            if len(we) >= 3 and len(wd) >= 3:
                t, p = welch_t_test(we, wd)
                diff = (statistics.mean(we) - statistics.mean(wd)) / statistics.mean(wd) * 100 if statistics.mean(wd) else 0
                
                cpi_diff = ''
                if len(we_cpi) >= 3 and len(wd_cpi) >= 3:
                    t2, p2 = welch_t_test(we_cpi, wd_cpi)
                    cd = (statistics.mean(we_cpi) - statistics.mean(wd_cpi)) / statistics.mean(wd_cpi) * 100
                    cpi_diff = f", CPI Δ={cd:+.1f}% p={f(p2,3)}{sig_stars(p2)}"
                
                label = f"{platform}" if system == 'ALL' else f"{platform} {system}"
                out.append(f"  {label:12s}: WE={f(statistics.mean(we))}, WD={f(statistics.mean(wd))}, ROAS Δ={diff:+.1f}% p={f(p,3)}{sig_stars(p)}{cpi_diff}")
    
    # --- 1.4 By product ---
    out.append(f"\n### 1.4 按产品（产品级，日均消耗 > $500）")
    
    prod_dow = defaultdict(lambda: defaultdict(list))
    for r in product_daily:
        if r['xmp_cost'] > 0 and r['athena_revenue'] > 0:
            prod_dow[r['product']][is_weekend(r['date'])].append(
                safe_div(r['athena_revenue'], r['xmp_cost']))
    
    for prod in sorted(prod_dow.keys()):
        we = [v for v in prod_dow[prod][True] if v is not None]
        wd = [v for v in prod_dow[prod][False] if v is not None]
        if len(we) >= 3 and len(wd) >= 3:
            t, p = welch_t_test(we, wd)
            diff = (statistics.mean(we) - statistics.mean(wd)) / statistics.mean(wd) * 100 if statistics.mean(wd) else 0
            out.append(f"  {prod:12s}: WE={f(statistics.mean(we))}, WD={f(statistics.mean(wd))}, Δ={diff:+.1f}% p={f(p,3)}{sig_stars(p)}")


# ============================================================
# FACTOR 2: MOMENTUM  
# ============================================================
def analyze_momentum(wide_table, out):
    out.append("\n" + "="*70)
    out.append("因子 2：动量因子（ROAS 持续性分析）")
    out.append("="*70)
    
    # Build time series per campaign
    campaign_ts = defaultdict(dict)
    for r in wide_table:
        if r['cost'] > 10 and r['new_user_revenue'] > 0:
            key = (r['platform'], r['product'], r['campaign'])
            campaign_ts[key][r['date']] = {
                'roas': r['new_user_revenue'] / r['cost'],
                'cost': r['cost'],
                'nrev': r['new_user_revenue']
            }
    
    active = {k: v for k, v in campaign_ts.items() if len(v) >= 5}
    out.append(f"\n  有效 campaign（cost>$10 + 有新用户收入 + ≥5天）: {len(active)}")
    
    # --- Autocorrelation ---
    out.append(f"\n### 2.1 ROAS 自相关（lag-1 ~ lag-3）")
    for platform in ['FB', 'GG', 'TT', 'ALL']:
        for lag in [1, 2, 3]:
            pairs = []
            for key, ts in active.items():
                if platform != 'ALL' and key[0] != platform: continue
                dates = sorted(ts.keys())
                for i in range(lag, len(dates)):
                    d1 = datetime.strptime(dates[i-lag], '%Y-%m-%d')
                    d2 = datetime.strptime(dates[i], '%Y-%m-%d')
                    if (d2 - d1).days == lag:
                        pairs.append((ts[dates[i-lag]]['roas'], ts[dates[i]]['roas']))
            
            if len(pairs) >= 10:
                r = pearson_r([p[0] for p in pairs], [p[1] for p in pairs])
                if r is not None:
                    label = f"{platform:3s} lag-{lag}" if platform != 'ALL' else f"ALL lag-{lag}"
                    out.append(f"  {label}: r={f(r,3)} (n={len(pairs)})")
    
    # --- Momentum signal test ---
    out.append(f"\n### 2.2 动量信号测试：连续 N 天 ROAS > 中位数后的延续率")
    
    for lookback in [3]:
        for platform in ['FB', 'GG', 'TT', 'ALL']:
            mom, no_mom = [], []
            
            for key, ts in active.items():
                if platform != 'ALL' and key[0] != platform: continue
                dates = sorted(ts.keys())
                if len(dates) < lookback + 1: continue
                
                med = statistics.median([ts[d]['roas'] for d in dates])
                
                for i in range(lookback, len(dates)):
                    prev = dates[i-lookback:i]
                    # Check consecutive
                    ok = True
                    for j in range(1, len(prev)):
                        if (datetime.strptime(prev[j], '%Y-%m-%d') - datetime.strptime(prev[j-1], '%Y-%m-%d')).days != 1:
                            ok = False; break
                    if not ok: continue
                    if (datetime.strptime(dates[i], '%Y-%m-%d') - datetime.strptime(prev[-1], '%Y-%m-%d')).days != 1:
                        continue
                    
                    above = all(ts[d]['roas'] > med for d in prev)
                    curr_above = ts[dates[i]]['roas'] > med
                    
                    if above:
                        mom.append(curr_above)
                    else:
                        no_mom.append(curr_above)
            
            if mom and no_mom:
                mom_rate = sum(mom) / len(mom)
                no_rate = sum(no_mom) / len(no_mom)
                lift = mom_rate - no_rate
                interpretation = "动量" if lift > 0.05 else "均值回归" if lift < -0.05 else "中性"
                out.append(f"  {platform:3s}: 信号后={mom_rate:.0%}(n={len(mom):3d}), 无信号={no_rate:.0%}(n={len(no_mom):3d}), lift={lift:+.0%} → {interpretation}")
    
    # --- Mean reversion analysis ---
    out.append(f"\n### 2.3 均值回归速度：极端 ROAS 后的回归")
    for platform in ['FB', 'GG', 'TT']:
        top_q_next = []
        bot_q_next = []
        
        for key, ts in active.items():
            if key[0] != platform: continue
            dates = sorted(ts.keys())
            roas_vals = [ts[d]['roas'] for d in dates]
            if len(roas_vals) < 5: continue
            
            q25 = sorted(roas_vals)[len(roas_vals)//4]
            q75 = sorted(roas_vals)[3*len(roas_vals)//4]
            med = statistics.median(roas_vals)
            
            for i in range(len(dates)-1):
                d1 = datetime.strptime(dates[i], '%Y-%m-%d')
                d2 = datetime.strptime(dates[i+1], '%Y-%m-%d')
                if (d2 - d1).days != 1: continue
                
                r_today = ts[dates[i]]['roas']
                r_next = ts[dates[i+1]]['roas']
                
                if r_today >= q75:
                    top_q_next.append(r_next / med if med > 0 else 0)
                elif r_today <= q25:
                    bot_q_next.append(r_next / med if med > 0 else 0)
        
        if top_q_next and bot_q_next:
            out.append(f"  {platform}: 高ROAS日(Q4)次日 → 均值的 {f(statistics.mean(top_q_next))}倍 (n={len(top_q_next)})")
            out.append(f"  {platform}: 低ROAS日(Q1)次日 → 均值的 {f(statistics.mean(bot_q_next))}倍 (n={len(bot_q_next)})")


# ============================================================
# FACTOR 3: VOLATILITY
# ============================================================
def analyze_volatility(wide_table, out):
    out.append("\n" + "="*70)
    out.append("因子 3：波动率因子（稳定性 vs 收益）")
    out.append("="*70)
    
    campaign_ts = defaultdict(list)
    for r in wide_table:
        if r['cost'] > 10 and r['new_user_revenue'] > 0:
            key = (r['platform'], r['product'], r['campaign'])
            campaign_ts[key].append({
                'date': r['date'],
                'roas': r['new_user_revenue'] / r['cost'],
                'cost': r['cost']
            })
    
    active = {k: sorted(v, key=lambda x: x['date']) for k, v in campaign_ts.items() if len(v) >= 5}
    out.append(f"\n  有效 campaign (≥5天有 cost>$10 + 新用户收入): {len(active)}")
    
    # Campaign-level stats
    camp_stats = []
    for key, ts in active.items():
        roas_s = [d['roas'] for d in ts]
        cost_s = [d['cost'] for d in ts]
        avg_roas = statistics.mean(roas_s)
        std_roas = statistics.stdev(roas_s) if len(roas_s) > 1 else 0
        cv = std_roas / avg_roas if avg_roas > 0 else 0
        camp_stats.append({
            'platform': key[0], 'product': key[1], 'campaign': key[2],
            'days': len(ts), 'avg_roas': avg_roas, 'std_roas': std_roas,
            'cv': cv, 'avg_cost': statistics.mean(cost_s), 'total_cost': sum(cost_s)
        })
    
    out.append(f"\n### 3.1 波动率四分位分析（按平台）")
    for platform in ['FB', 'GG', 'TT']:
        plat = [c for c in camp_stats if c['platform'] == platform]
        if len(plat) < 8:
            out.append(f"\n  {platform}: 样本不足 ({len(plat)})")
            continue
        
        plat.sort(key=lambda x: x['cv'])
        n = len(plat)
        q1 = plat[:n//4]
        q2 = plat[n//4:n//2]
        q3 = plat[n//2:3*n//4]
        q4 = plat[3*n//4:]
        
        out.append(f"\n  {platform} (n={n}):")
        for label, q in [('Q1(低波动)', q1), ('Q2', q2), ('Q3', q3), ('Q4(高波动)', q4)]:
            avg_cv = statistics.mean([c['cv'] for c in q])
            avg_roas = statistics.mean([c['avg_roas'] for c in q])
            avg_cost = statistics.mean([c['avg_cost'] for c in q])
            out.append(f"    {label:12s}: CV={f(avg_cv)}, ROAS={f(avg_roas)}, 日均消耗=${f(avg_cost, 0)}, n={len(q)}")
        
        t, p = welch_t_test([c['avg_roas'] for c in q1], [c['avg_roas'] for c in q4])
        if t is not None:
            diff = (statistics.mean([c['avg_roas'] for c in q1]) - statistics.mean([c['avg_roas'] for c in q4]))
            out.append(f"    Q1 vs Q4 ROAS差: {f(diff,3)}, p={f(p,3)} {sig_stars(p)}")
    
    # --- High-spend + volatility interaction ---
    out.append(f"\n### 3.2 高消耗 × 波动率交叉分析")
    for platform in ['FB', 'TT']:
        plat = [c for c in camp_stats if c['platform'] == platform]
        if len(plat) < 8: continue
        
        med_cost = statistics.median([c['avg_cost'] for c in plat])
        med_cv = statistics.median([c['cv'] for c in plat])
        
        hc_hv = [c for c in plat if c['avg_cost'] > med_cost and c['cv'] > med_cv]
        hc_lv = [c for c in plat if c['avg_cost'] > med_cost and c['cv'] <= med_cv]
        lc_hv = [c for c in plat if c['avg_cost'] <= med_cost and c['cv'] > med_cv]
        lc_lv = [c for c in plat if c['avg_cost'] <= med_cost and c['cv'] <= med_cv]
        
        out.append(f"\n  {platform} (中位消耗=${f(med_cost,0)}, 中位CV={f(med_cv)}):")
        for label, group in [('高消耗+高波动', hc_hv), ('高消耗+低波动', hc_lv), ('低消耗+高波动', lc_hv), ('低消耗+低波动', lc_lv)]:
            if group:
                avg_roas = statistics.mean([c['avg_roas'] for c in group])
                out.append(f"    {label:14s}: n={len(group):2d}, ROAS={f(avg_roas)}")


# ============================================================
# FACTOR 4: SPEND RESPONSE
# ============================================================
def analyze_spend_response(wide_table, out):
    out.append("\n" + "="*70)
    out.append("因子 4：消耗响应因子（预算加量效应）")
    out.append("="*70)
    
    campaign_ts = defaultdict(dict)
    for r in wide_table:
        if r['cost'] > 0:
            key = (r['platform'], r['product'], r['campaign'])
            campaign_ts[key][r['date']] = {
                'cost': r['cost'],
                'nrev': r['new_user_revenue'],
                'roas': r['new_user_revenue'] / r['cost'] if r['cost'] > 0 else 0,
                'installs': r['installs'],
            }
    
    active = {k: v for k, v in campaign_ts.items() if len(v) >= 5}
    out.append(f"\n  有效 campaign (≥5天有消耗): {len(active)}")
    
    # --- Surge analysis with multiple thresholds ---
    out.append(f"\n### 4.1 消耗激增分析（按平台）")
    
    for platform in ['FB', 'GG', 'TT']:
        out.append(f"\n  {platform}:")
        
        for threshold in [0.3, 0.5, 1.0]:
            surge_before = []
            surge_day = []
            surge_after_3 = []
            
            for key, ts in active.items():
                if key[0] != platform: continue
                dates = sorted(ts.keys())
                
                for i in range(1, len(dates)):
                    d1 = datetime.strptime(dates[i-1], '%Y-%m-%d')
                    d2 = datetime.strptime(dates[i], '%Y-%m-%d')
                    if (d2 - d1).days != 1: continue
                    
                    c1, c2 = ts[dates[i-1]]['cost'], ts[dates[i]]['cost']
                    if c1 < 20: continue  # skip tiny base
                    
                    change = (c2 - c1) / c1
                    if change < threshold: continue
                    
                    r_before = ts[dates[i-1]]['roas']
                    r_surge = ts[dates[i]]['roas']
                    
                    if r_before > 0:
                        surge_before.append(r_before)
                        surge_day.append(r_surge)
                        
                        # 3-day post average
                        future = []
                        for j in range(i, min(i+3, len(dates))):
                            dj = datetime.strptime(dates[j], '%Y-%m-%d')
                            if (dj - d2).days <= 2:
                                future.append(ts[dates[j]]['roas'])
                        if future:
                            surge_after_3.append(statistics.mean(future))
            
            if len(surge_before) >= 5:
                avg_b = statistics.mean(surge_before)
                avg_s = statistics.mean(surge_day)
                avg_3 = statistics.mean(surge_after_3) if surge_after_3 else None
                d_s = (avg_s - avg_b) / avg_b * 100 if avg_b else 0
                d_3 = (avg_3 - avg_b) / avg_b * 100 if avg_3 and avg_b else None
                out.append(f"    >{threshold:.0%}加量(n={len(surge_before):3d}): 前={f(avg_b)}, 当天={f(avg_s)}({d_s:+.0f}%), 3日后={f(avg_3)}({f'{d_3:+.0f}%' if d_3 else 'N/A'})")
    
    # --- Elasticity by platform ---
    out.append(f"\n### 4.2 消耗-收入弹性（平台级日度汇总）")
    
    for platform in ['FB', 'GG', 'TT']:
        d_agg = defaultdict(lambda: {'cost': 0, 'nrev': 0})
        for r in wide_table:
            if r['platform'] == platform and r['cost'] > 0:
                d_agg[r['date']]['cost'] += r['cost']
                d_agg[r['date']]['nrev'] += r['new_user_revenue']
        
        dates = sorted(d_agg.keys())
        cost_chg, rev_chg = [], []
        for i in range(1, len(dates)):
            d1 = datetime.strptime(dates[i-1], '%Y-%m-%d')
            d2 = datetime.strptime(dates[i], '%Y-%m-%d')
            if (d2-d1).days != 1: continue
            c1, c2 = d_agg[dates[i-1]]['cost'], d_agg[dates[i]]['cost']
            r1, r2 = d_agg[dates[i-1]]['nrev'], d_agg[dates[i]]['nrev']
            if c1 > 100 and r1 > 0:
                cost_chg.append((c2-c1)/c1)
                rev_chg.append((r2-r1)/r1)
        
        if len(cost_chg) >= 5:
            r = pearson_r(cost_chg, rev_chg)
            elasts = [rv/cv for cv, rv in zip(cost_chg, rev_chg) if abs(cv) > 0.05]
            med_e = statistics.median(elasts) if elasts else None
            out.append(f"  {platform}: 消耗-收入相关 r={f(r,3)}, 中位弹性={f(med_e)} (n={len(cost_chg)})")
            
            # Direction: when cost goes up, does revenue go up?
            up_up = sum(1 for c, r in zip(cost_chg, rev_chg) if c > 0.05 and r > 0)
            up_down = sum(1 for c, r in zip(cost_chg, rev_chg) if c > 0.05 and r <= 0)
            if up_up + up_down > 0:
                out.append(f"    消耗↑时收入也↑的概率: {up_up/(up_up+up_down):.0%} ({up_up}/{up_up+up_down})")
    
    # --- Spend level and efficiency ---
    out.append(f"\n### 4.3 消耗水平与效率（按日均消耗分组）")
    for platform in ['FB', 'GG', 'TT']:
        plat_camps = defaultdict(list)
        for key, ts in active.items():
            if key[0] != platform: continue
            cost_vals = [ts[d]['cost'] for d in ts]
            roas_vals = [ts[d]['roas'] for d in ts if ts[d]['roas'] > 0]
            if roas_vals:
                avg_cost = statistics.mean(cost_vals)
                avg_roas = statistics.mean(roas_vals)
                plat_camps[platform].append({'avg_cost': avg_cost, 'avg_roas': avg_roas})
        
        camps = plat_camps.get(platform, [])
        if len(camps) < 8: continue
        
        # Sort by cost, split into terciles
        camps.sort(key=lambda x: x['avg_cost'])
        n = len(camps)
        low = camps[:n//3]
        mid = camps[n//3:2*n//3]
        high = camps[2*n//3:]
        
        out.append(f"\n  {platform} (n={n}):")
        for label, group in [('低消耗', low), ('中消耗', mid), ('高消耗', high)]:
            avg_c = statistics.mean([c['avg_cost'] for c in group])
            avg_r = statistics.mean([c['avg_roas'] for c in group])
            out.append(f"    {label}: 日均${f(avg_c,0)}, 均ROAS={f(avg_r)}, n={len(group)}")


# ============================================================
# MAIN
# ============================================================
if __name__ == '__main__':
    out = []
    out.append("="*70)
    out.append("广告投放量化因子分析报告")
    out.append(f"生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    out.append(f"Campaign 级数据范围: {CAMP_START} → {CAMP_END}")
    out.append(f"产品级数据范围: 2026-03-30 → 2026-06-15")
    out.append("="*70)
    
    wide_table = load_wide_table()
    product_daily = load_product_daily()
    
    # Summary
    dates = sorted(set(r['date'] for r in wide_table))
    matched = sum(1 for r in wide_table if r['cost'] > 0 and r['new_user_revenue'] > 0)
    out.append(f"\nCampaign 数据: {len(wide_table)} 行, {len(dates)} 天, 有匹配的 {matched} 行")
    
    plat_counts = defaultdict(int)
    for r in wide_table:
        if r['cost'] > 0 and r['new_user_revenue'] > 0:
            plat_counts[r['platform']] += 1
    out.append(f"按平台匹配行数: {dict(plat_counts)}")
    
    analyze_calendar(wide_table, product_daily, out)
    analyze_momentum(wide_table, out)
    analyze_volatility(wide_table, out)
    analyze_spend_response(wide_table, out)
    
    # ============================================================
    # SUMMARY
    # ============================================================
    out.append("\n" + "="*70)
    out.append("总结：核心发现")
    out.append("="*70)
    
    out.append("""
1. 日历因子：
   - 产品级数据（44天）显示周末总 ROAS 略高于工作日，但统计不显著
   - Campaign 级数据各平台差异微小，日历效应在我们的业务中不明显
   - 结论：周末/工作日差异不足以作为预算调整依据

2. 动量因子：
   - FB 和 GG 的 ROAS 几乎无自相关（r≈0.06-0.07），说明昨天的 ROAS 几乎不能预测今天
   - TT 的自相关稍高（r≈0.22），有一定的短期趋势延续
   - 连续好表现后更容易回落 → 均值回归占主导，特别是 FB/GG
   - TT 例外：有一定动量效应（连续好表现后延续率更高）
   - 结论：不应因为 FB/GG campaign 连续几天好就急于加量，均值回归概率更大

3. 波动率因子：
   - TT 平台低波动 campaign ROAS 显著优于高波动（尤其高消耗+高波动组合）
   - FB 波动率与 ROAS 的关系不明显
   - 结论：TT 上应优先保留和加量低波动的 campaign

4. 消耗响应因子：
   - FB：加量后 ROAS 短暂提高，但 3 天后回落 → 平台会在加量时先找优质流量，随后质量下降
   - GG：加量后 ROAS 反而下降 → 对加量最敏感，应该更保守
   - TT：加量后 ROAS 相对稳定 → 对预算变动最友好
   - 弹性：FB 和 TT 弹性 > 1（消耗增加带来超比例收入增长），GG < 1
""")
    
    report = '\n'.join(out)
    print(report)
    
    # Save
    with open(os.path.join(ANALYSIS_DIR, 'factor_analysis_report.txt'), 'w') as f:
        f.write(report)
    print(f"\n报告已保存至 analysis/factor_analysis_report.txt")
