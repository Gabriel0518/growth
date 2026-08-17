#!/usr/bin/env python3
"""
Campaign Factor Analysis - Core Analysis
Runs all four factor analyses on the wide table data.
"""

import csv, os, json, sys
from datetime import datetime, timedelta
from collections import defaultdict
import statistics
import math

ANALYSIS_DIR = '/home/admin/.openclaw/workspace/analysis'

def load_wide_table():
    """Load the campaign-level wide table"""
    rows = []
    with open(os.path.join(ANALYSIS_DIR, 'campaign_wide_table.csv')) as f:
        for row in csv.DictReader(f):
            row['cost'] = float(row['cost'])
            row['revenue'] = float(row['revenue'])
            row['new_user_revenue'] = float(row['new_user_revenue'])
            row['impressions'] = int(row['impressions'])
            row['clicks'] = int(row['clicks'])
            row['installs'] = int(row['installs'])
            row['purchase_events'] = int(row['purchase_events'])
            rows.append(row)
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

def weekday_name(date_str):
    d = datetime.strptime(date_str, '%Y-%m-%d')
    return d.strftime('%A')

def is_weekend(date_str):
    d = datetime.strptime(date_str, '%Y-%m-%d')
    return d.weekday() >= 5

def safe_roas(revenue, cost):
    if cost <= 0:
        return None
    return revenue / cost

def safe_cpi(cost, installs):
    if installs <= 0:
        return None
    return cost / installs

def welch_t_test(group1, group2):
    """Simple Welch's t-test implementation"""
    n1, n2 = len(group1), len(group2)
    if n1 < 3 or n2 < 3:
        return None, None
    
    m1, m2 = statistics.mean(group1), statistics.mean(group2)
    v1, v2 = statistics.variance(group1), statistics.variance(group2)
    
    se = math.sqrt(v1/n1 + v2/n2) if (v1/n1 + v2/n2) > 0 else 0
    if se == 0:
        return 0, 1.0
    
    t = (m1 - m2) / se
    # Approximate p-value using normal distribution for large samples
    # (good enough for n > 10)
    z = abs(t)
    # Simple approximation
    p = math.exp(-0.5 * z * z) * (0.4361836 * (1/(1+0.3326*z)) - 0.1201676 * (1/(1+0.3326*z))**2 + 0.9372980 * (1/(1+0.3326*z))**3) * 2
    p = max(0, min(1, p))
    
    return t, p

def mann_whitney_approx(group1, group2):
    """Approximate Mann-Whitney U test for large samples"""
    n1, n2 = len(group1), len(group2)
    if n1 < 5 or n2 < 5:
        return None, None
    
    # Rank all values
    combined = [(v, 0) for v in group1] + [(v, 1) for v in group2]
    combined.sort(key=lambda x: x[0])
    
    rank_sum_1 = 0
    for i, (v, g) in enumerate(combined):
        if g == 0:
            rank_sum_1 += i + 1
    
    U1 = rank_sum_1 - n1 * (n1 + 1) / 2
    mu = n1 * n2 / 2
    sigma = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12)
    
    if sigma == 0:
        return 0, 1.0
    
    z = (U1 - mu) / sigma
    # Normal approximation for p-value
    p = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
    
    return z, p

def fmt_pct(v, digits=1):
    if v is None: return 'N/A'
    return f"{v*100:.{digits}f}%"

def fmt_num(v, digits=2):
    if v is None: return 'N/A'
    return f"{v:.{digits}f}"


# ============================================================
# FACTOR 1: Calendar Factor (Weekend vs Weekday)
# ============================================================
def analyze_calendar_factor(wide_table, product_daily):
    print("\n" + "=" * 70)
    print("FACTOR 1: CALENDAR FACTOR (Weekend vs Weekday)")
    print("=" * 70)
    
    # --- Product level analysis (60 days, more reliable) ---
    print("\n### 1.1 Product-Level Analysis (Athena Revenue + XMP Cost)")
    
    # Group by date → aggregate
    date_agg = defaultdict(lambda: {'revenue': 0, 'new_revenue': 0, 'cost': 0})
    for row in product_daily:
        d = row['date']
        date_agg[d]['revenue'] += row['athena_revenue']
        date_agg[d]['new_revenue'] += row['athena_new_user_revenue']
        date_agg[d]['cost'] += row['xmp_cost']
    
    weekend_roas = []
    weekday_roas = []
    weekend_cost = []
    weekday_cost = []
    
    for date, agg in sorted(date_agg.items()):
        roas = safe_roas(agg['new_revenue'], agg['cost'])
        if roas is not None and agg['cost'] > 100:  # minimum cost threshold
            if is_weekend(date):
                weekend_roas.append(roas)
                weekend_cost.append(agg['cost'])
            else:
                weekday_roas.append(roas)
                weekday_cost.append(agg['cost'])
    
    print(f"\n  All Products Combined (min daily cost > $100):")
    print(f"  Weekend: n={len(weekend_roas)}, avg ROAS={fmt_num(statistics.mean(weekend_roas) if weekend_roas else None)}, avg cost=${fmt_num(statistics.mean(weekend_cost) if weekend_cost else None)}")
    print(f"  Weekday: n={len(weekday_roas)}, avg ROAS={fmt_num(statistics.mean(weekday_roas) if weekday_roas else None)}, avg cost=${fmt_num(statistics.mean(weekday_cost) if weekday_cost else None)}")
    
    if weekend_roas and weekday_roas:
        t, p = welch_t_test(weekend_roas, weekday_roas)
        diff = statistics.mean(weekend_roas) - statistics.mean(weekday_roas)
        pct_diff = diff / statistics.mean(weekday_roas) * 100 if statistics.mean(weekday_roas) != 0 else 0
        print(f"  Δ ROAS: {fmt_num(diff, 4)} ({pct_diff:+.1f}%), t={fmt_num(t, 3)}, p={fmt_num(p, 4)}")
        
        t2, p2 = welch_t_test(weekend_cost, weekday_cost)
        diff2 = statistics.mean(weekend_cost) - statistics.mean(weekday_cost)
        pct_diff2 = diff2 / statistics.mean(weekday_cost) * 100 if statistics.mean(weekday_cost) != 0 else 0
        print(f"  Δ Cost: ${fmt_num(diff2)} ({pct_diff2:+.1f}%), t={fmt_num(t2, 3)}, p={fmt_num(p2, 4)}")
    
    # --- By platform ---
    print("\n### 1.2 By Platform (Campaign Level)")
    
    for platform in ['FB', 'GG', 'TT']:
        # Filter to rows with both cost and revenue
        plat_rows = [r for r in wide_table if r['platform'] == platform and r['cost'] > 0]
        
        # Aggregate by date
        date_plat = defaultdict(lambda: {'cost': 0, 'revenue': 0, 'new_revenue': 0, 'installs': 0})
        for r in plat_rows:
            d = r['date']
            date_plat[d]['cost'] += r['cost']
            date_plat[d]['revenue'] += r['revenue']
            date_plat[d]['new_revenue'] += r['new_user_revenue']
            date_plat[d]['installs'] += r['installs']
        
        we_roas, wd_roas = [], []
        we_cpi, wd_cpi = [], []
        we_cost, wd_cost = [], []
        
        for date, agg in date_plat.items():
            roas = safe_roas(agg['new_revenue'], agg['cost'])
            cpi = safe_cpi(agg['cost'], agg['installs'])
            if roas is not None:
                if is_weekend(date):
                    we_roas.append(roas)
                    we_cost.append(agg['cost'])
                    if cpi: we_cpi.append(cpi)
                else:
                    wd_roas.append(roas)
                    wd_cost.append(agg['cost'])
                    if cpi: wd_cpi.append(cpi)
        
        print(f"\n  {platform}:")
        if we_roas and wd_roas:
            print(f"    Weekend: n={len(we_roas)}, avg ROAS={fmt_num(statistics.mean(we_roas))}, avg cost=${fmt_num(statistics.mean(we_cost))}")
            print(f"    Weekday: n={len(wd_roas)}, avg ROAS={fmt_num(statistics.mean(wd_roas))}, avg cost=${fmt_num(statistics.mean(wd_cost))}")
            t, p = welch_t_test(we_roas, wd_roas)
            diff = statistics.mean(we_roas) - statistics.mean(wd_roas)
            pct = diff / statistics.mean(wd_roas) * 100 if statistics.mean(wd_roas) else 0
            print(f"    Δ ROAS: {pct:+.1f}%, p={fmt_num(p, 4)}")
            if we_cpi and wd_cpi:
                t2, p2 = welch_t_test(we_cpi, wd_cpi)
                diff2 = statistics.mean(we_cpi) - statistics.mean(wd_cpi)
                pct2 = diff2 / statistics.mean(wd_cpi) * 100 if statistics.mean(wd_cpi) else 0
                print(f"    Δ CPI: {pct2:+.1f}%, p={fmt_num(p2, 4)}")
        else:
            print(f"    Insufficient data")
    
    # --- By platform × system ---
    print("\n### 1.3 By Platform × System")
    for platform in ['FB', 'GG', 'TT']:
        for system in ['iOS', 'Android']:
            plat_rows = [r for r in wide_table if r['platform'] == platform and r['system'] == system and r['cost'] > 0]
            date_agg = defaultdict(lambda: {'cost': 0, 'new_revenue': 0})
            for r in plat_rows:
                date_agg[r['date']]['cost'] += r['cost']
                date_agg[r['date']]['new_revenue'] += r['new_user_revenue']
            
            we, wd = [], []
            for date, agg in date_agg.items():
                roas = safe_roas(agg['new_revenue'], agg['cost'])
                if roas is not None:
                    (we if is_weekend(date) else wd).append(roas)
            
            if len(we) >= 3 and len(wd) >= 3:
                t, p = welch_t_test(we, wd)
                diff_pct = (statistics.mean(we) - statistics.mean(wd)) / statistics.mean(wd) * 100 if statistics.mean(wd) else 0
                sig = "***" if p and p < 0.01 else "**" if p and p < 0.05 else "*" if p and p < 0.1 else ""
                print(f"  {platform} {system}: WE avg={fmt_num(statistics.mean(we))}, WD avg={fmt_num(statistics.mean(wd))}, Δ={diff_pct:+.1f}% p={fmt_num(p, 3)} {sig}")
    
    # --- Day of week breakdown ---
    print("\n### 1.4 Day-of-Week Breakdown (Product Level)")
    dow_data = defaultdict(list)
    for date, agg in sorted(date_agg.items()):
        roas = safe_roas(agg['new_revenue'], agg['cost'])
        if roas is not None and agg['cost'] > 100:
            dow = datetime.strptime(date, '%Y-%m-%d').strftime('%A')
            dow_data[dow].append(roas)
    
    dow_order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    for dow in dow_order:
        vals = dow_data.get(dow, [])
        if vals:
            print(f"  {dow:10s}: n={len(vals):2d}, avg ROAS={fmt_num(statistics.mean(vals))}, median={fmt_num(statistics.median(vals))}")


# ============================================================
# FACTOR 2: Momentum Factor
# ============================================================
def analyze_momentum_factor(wide_table):
    print("\n" + "=" * 70)
    print("FACTOR 2: MOMENTUM FACTOR")
    print("=" * 70)
    
    # Build time series per campaign
    campaign_ts = defaultdict(dict)
    for r in wide_table:
        if r['cost'] > 0 and r['new_user_revenue'] > 0:
            camp_key = (r['platform'], r['product'], r['campaign'])
            campaign_ts[camp_key][r['date']] = {
                'roas': r['new_user_revenue'] / r['cost'],
                'cost': r['cost'],
                'revenue': r['new_user_revenue']
            }
    
    print(f"\n  Campaigns with cost+revenue data: {len(campaign_ts)}")
    
    # Filter to campaigns with >= 5 days of data
    active_camps = {k: v for k, v in campaign_ts.items() if len(v) >= 5}
    print(f"  Campaigns with >= 5 days: {len(active_camps)}")
    
    # Momentum test: if ROAS was above median for past N days, does it stay above?
    for lookback in [3, 5]:
        print(f"\n### 2.1 Lookback={lookback} days: If ROAS > campaign median for {lookback} consecutive days, what happens next?")
        
        for platform in ['FB', 'GG', 'TT', 'ALL']:
            momentum_next = []   # ROAS next day after momentum signal
            no_momentum_next = [] # ROAS next day without signal
            
            for camp_key, ts in active_camps.items():
                if platform != 'ALL' and camp_key[0] != platform:
                    continue
                
                dates = sorted(ts.keys())
                if len(dates) < lookback + 1:
                    continue
                
                # Campaign median ROAS
                all_roas = [ts[d]['roas'] for d in dates]
                med_roas = statistics.median(all_roas)
                
                for i in range(lookback, len(dates)):
                    prev_days = dates[i-lookback:i]
                    # Check if all lookback days are consecutive
                    is_consecutive = True
                    for j in range(1, len(prev_days)):
                        d1 = datetime.strptime(prev_days[j-1], '%Y-%m-%d')
                        d2 = datetime.strptime(prev_days[j], '%Y-%m-%d')
                        if (d2 - d1).days != 1:
                            is_consecutive = False
                            break
                    
                    # Check gap between last lookback day and target day
                    d_last = datetime.strptime(prev_days[-1], '%Y-%m-%d')
                    d_target = datetime.strptime(dates[i], '%Y-%m-%d')
                    if (d_target - d_last).days != 1:
                        continue
                    
                    if not is_consecutive:
                        continue
                    
                    above = all(ts[d]['roas'] > med_roas for d in prev_days)
                    current_roas = ts[dates[i]]['roas']
                    
                    if above:
                        momentum_next.append(current_roas > med_roas)
                    else:
                        no_momentum_next.append(current_roas > med_roas)
            
            if momentum_next and no_momentum_next:
                mom_rate = sum(momentum_next) / len(momentum_next)
                no_mom_rate = sum(no_momentum_next) / len(no_momentum_next)
                print(f"    {platform:3s}: After momentum signal: {mom_rate:.1%} above median (n={len(momentum_next)})")
                print(f"         Without signal:        {no_mom_rate:.1%} above median (n={len(no_momentum_next)})")
                print(f"         Lift: {(mom_rate - no_mom_rate):.1%}")
    
    # Autocorrelation of ROAS
    print(f"\n### 2.2 ROAS Autocorrelation (lag-1)")
    for platform in ['FB', 'GG', 'TT']:
        lag1_pairs = []
        for camp_key, ts in active_camps.items():
            if camp_key[0] != platform:
                continue
            dates = sorted(ts.keys())
            for i in range(1, len(dates)):
                d1 = datetime.strptime(dates[i-1], '%Y-%m-%d')
                d2 = datetime.strptime(dates[i], '%Y-%m-%d')
                if (d2 - d1).days == 1:
                    lag1_pairs.append((ts[dates[i-1]]['roas'], ts[dates[i]]['roas']))
        
        if len(lag1_pairs) >= 10:
            x = [p[0] for p in lag1_pairs]
            y = [p[1] for p in lag1_pairs]
            # Pearson correlation
            mx, my = statistics.mean(x), statistics.mean(y)
            sx, sy = statistics.stdev(x), statistics.stdev(y)
            if sx > 0 and sy > 0:
                cov = sum((xi - mx) * (yi - my) for xi, yi in zip(x, y)) / (len(x) - 1)
                r = cov / (sx * sy)
                print(f"  {platform}: lag-1 autocorrelation r={r:.3f} (n={len(lag1_pairs)} day-pairs)")


# ============================================================
# FACTOR 3: Volatility Factor
# ============================================================
def analyze_volatility_factor(wide_table):
    print("\n" + "=" * 70)
    print("FACTOR 3: VOLATILITY FACTOR")
    print("=" * 70)
    
    # Build campaign time series
    campaign_ts = defaultdict(list)
    for r in wide_table:
        if r['cost'] > 0 and r['new_user_revenue'] > 0:
            camp_key = (r['platform'], r['product'], r['campaign'])
            campaign_ts[camp_key].append({
                'date': r['date'],
                'roas': r['new_user_revenue'] / r['cost'],
                'cost': r['cost']
            })
    
    # Filter to campaigns with >= 7 days
    active_camps = {k: sorted(v, key=lambda x: x['date']) for k, v in campaign_ts.items() if len(v) >= 7}
    print(f"\n  Campaigns with >= 7 days of data: {len(active_camps)}")
    
    # Calculate volatility (CV of ROAS) and average ROAS for each campaign
    camp_stats = []
    for camp_key, ts in active_camps.items():
        roas_series = [d['roas'] for d in ts]
        cost_series = [d['cost'] for d in ts]
        
        avg_roas = statistics.mean(roas_series)
        std_roas = statistics.stdev(roas_series) if len(roas_series) > 1 else 0
        cv = std_roas / avg_roas if avg_roas > 0 else 0
        avg_cost = statistics.mean(cost_series)
        total_cost = sum(cost_series)
        
        camp_stats.append({
            'platform': camp_key[0],
            'product': camp_key[1],
            'campaign': camp_key[2],
            'days': len(ts),
            'avg_roas': avg_roas,
            'std_roas': std_roas,
            'cv': cv,
            'avg_cost': avg_cost,
            'total_cost': total_cost,
        })
    
    if not camp_stats:
        print("  Insufficient data for volatility analysis")
        return
    
    print(f"\n### 3.1 Volatility Quartile Analysis (by platform)")
    for platform in ['FB', 'GG', 'TT']:
        plat = [c for c in camp_stats if c['platform'] == platform]
        if len(plat) < 8:
            print(f"\n  {platform}: insufficient campaigns ({len(plat)})")
            continue
        
        plat.sort(key=lambda x: x['cv'])
        n = len(plat)
        q1 = plat[:n//4]
        q4 = plat[3*n//4:]
        
        print(f"\n  {platform} (n={n} campaigns):")
        print(f"    Low volatility  (Q1): avg CV={fmt_num(statistics.mean([c['cv'] for c in q1]))}, avg ROAS={fmt_num(statistics.mean([c['avg_roas'] for c in q1]))}, avg daily cost=${fmt_num(statistics.mean([c['avg_cost'] for c in q1]))}")
        print(f"    High volatility (Q4): avg CV={fmt_num(statistics.mean([c['cv'] for c in q4]))}, avg ROAS={fmt_num(statistics.mean([c['avg_roas'] for c in q4]))}, avg daily cost=${fmt_num(statistics.mean([c['avg_cost'] for c in q4]))}")
        
        # Test
        t, p = welch_t_test([c['avg_roas'] for c in q1], [c['avg_roas'] for c in q4])
        if t is not None:
            diff_pct = (statistics.mean([c['avg_roas'] for c in q1]) - statistics.mean([c['avg_roas'] for c in q4])) / statistics.mean([c['avg_roas'] for c in q4]) * 100 if statistics.mean([c['avg_roas'] for c in q4]) else 0
            print(f"    Q1 vs Q4 ROAS: Δ={diff_pct:+.1f}%, p={fmt_num(p, 4)}")
    
    print(f"\n### 3.2 High-Spend + High-Volatility Risk Analysis")
    for platform in ['FB', 'GG', 'TT']:
        plat = [c for c in camp_stats if c['platform'] == platform]
        if len(plat) < 8:
            continue
        
        med_cost = statistics.median([c['avg_cost'] for c in plat])
        med_cv = statistics.median([c['cv'] for c in plat])
        
        high_cost_high_vol = [c for c in plat if c['avg_cost'] > med_cost and c['cv'] > med_cv]
        high_cost_low_vol = [c for c in plat if c['avg_cost'] > med_cost and c['cv'] <= med_cv]
        
        if high_cost_high_vol and high_cost_low_vol:
            avg_roas_hv = statistics.mean([c['avg_roas'] for c in high_cost_high_vol])
            avg_roas_lv = statistics.mean([c['avg_roas'] for c in high_cost_low_vol])
            print(f"\n  {platform}:")
            print(f"    High-spend + High-vol: n={len(high_cost_high_vol)}, avg ROAS={fmt_num(avg_roas_hv)}")
            print(f"    High-spend + Low-vol:  n={len(high_cost_low_vol)}, avg ROAS={fmt_num(avg_roas_lv)}")
            t, p = welch_t_test([c['avg_roas'] for c in high_cost_high_vol], [c['avg_roas'] for c in high_cost_low_vol])
            if t is not None:
                print(f"    Δ ROAS: {(avg_roas_hv - avg_roas_lv)/avg_roas_lv*100:+.1f}%, p={fmt_num(p, 4)}")


# ============================================================
# FACTOR 4: Spend Response Factor
# ============================================================
def analyze_spend_response(wide_table):
    print("\n" + "=" * 70)
    print("FACTOR 4: SPEND RESPONSE FACTOR (Cost as Budget Proxy)")
    print("=" * 70)
    
    # Build time series
    campaign_ts = defaultdict(dict)
    for r in wide_table:
        if r['cost'] > 0:
            camp_key = (r['platform'], r['product'], r['campaign'])
            campaign_ts[camp_key][r['date']] = {
                'cost': r['cost'],
                'revenue': r['revenue'],
                'new_revenue': r['new_user_revenue'],
                'installs': r['installs'],
                'roas': r['new_user_revenue'] / r['cost'] if r['cost'] > 0 else 0,
            }
    
    active_camps = {k: v for k, v in campaign_ts.items() if len(v) >= 5}
    print(f"\n  Campaigns with >= 5 days of cost data: {len(active_camps)}")
    
    # Define "spend surge" as day-over-day cost increase > 30%
    SURGE_THRESHOLD = 0.30
    
    print(f"\n### 4.1 Spend Surge Analysis (>{SURGE_THRESHOLD:.0%} DoD cost increase)")
    
    for platform in ['FB', 'GG', 'TT']:
        surge_roas_before = []   # ROAS on the day before surge
        surge_roas_after_1 = []  # ROAS 1 day after surge
        surge_roas_after_3 = []  # avg ROAS 3 days after surge
        normal_roas = []
        
        for camp_key, ts in active_camps.items():
            if camp_key[0] != platform:
                continue
            
            dates = sorted(ts.keys())
            for i in range(1, len(dates)):
                d_prev = datetime.strptime(dates[i-1], '%Y-%m-%d')
                d_curr = datetime.strptime(dates[i], '%Y-%m-%d')
                if (d_curr - d_prev).days != 1:
                    continue
                
                cost_prev = ts[dates[i-1]]['cost']
                cost_curr = ts[dates[i]]['cost']
                
                if cost_prev <= 10:  # skip tiny base
                    continue
                
                change = (cost_curr - cost_prev) / cost_prev
                
                if change > SURGE_THRESHOLD:
                    # This is a surge day
                    roas_before = ts[dates[i-1]]['roas']
                    roas_surge = ts[dates[i]]['roas']
                    
                    surge_roas_before.append(roas_before)
                    surge_roas_after_1.append(roas_surge)
                    
                    # 3-day average after surge
                    future_roas = []
                    for j in range(i, min(i+3, len(dates))):
                        d_j = datetime.strptime(dates[j], '%Y-%m-%d')
                        if (d_j - d_curr).days <= 2:
                            future_roas.append(ts[dates[j]]['roas'])
                    if future_roas:
                        surge_roas_after_3.append(statistics.mean(future_roas))
                else:
                    normal_roas.append(ts[dates[i]]['roas'])
        
        print(f"\n  {platform}:")
        if surge_roas_before and surge_roas_after_1:
            print(f"    Surge events: {len(surge_roas_before)}")
            print(f"    Avg ROAS before surge: {fmt_num(statistics.mean(surge_roas_before))}")
            print(f"    Avg ROAS on surge day: {fmt_num(statistics.mean(surge_roas_after_1))}")
            diff = statistics.mean(surge_roas_after_1) - statistics.mean(surge_roas_before)
            pct = diff / statistics.mean(surge_roas_before) * 100 if statistics.mean(surge_roas_before) else 0
            print(f"    Δ ROAS (surge vs pre): {pct:+.1f}%")
            
            if surge_roas_after_3:
                diff3 = statistics.mean(surge_roas_after_3) - statistics.mean(surge_roas_before)
                pct3 = diff3 / statistics.mean(surge_roas_before) * 100 if statistics.mean(surge_roas_before) else 0
                print(f"    Avg ROAS 3-day post surge: {fmt_num(statistics.mean(surge_roas_after_3))} (Δ={pct3:+.1f}%)")
            
            if normal_roas:
                print(f"    Normal days avg ROAS: {fmt_num(statistics.mean(normal_roas))} (n={len(normal_roas)})")
        else:
            print(f"    Insufficient surge events")
    
    # Elasticity analysis
    print(f"\n### 4.2 Spend-Revenue Elasticity (by platform)")
    for platform in ['FB', 'GG', 'TT']:
        # Aggregate by date
        date_agg = defaultdict(lambda: {'cost': 0, 'new_revenue': 0})
        for r in wide_table:
            if r['platform'] == platform and r['cost'] > 0:
                date_agg[r['date']]['cost'] += r['cost']
                date_agg[r['date']]['new_revenue'] += r['new_user_revenue']
        
        dates = sorted(date_agg.keys())
        if len(dates) < 5:
            continue
        
        # Calculate day-over-day changes
        cost_changes = []
        rev_changes = []
        for i in range(1, len(dates)):
            d1 = datetime.strptime(dates[i-1], '%Y-%m-%d')
            d2 = datetime.strptime(dates[i], '%Y-%m-%d')
            if (d2 - d1).days != 1:
                continue
            c1, c2 = date_agg[dates[i-1]]['cost'], date_agg[dates[i]]['cost']
            r1, r2 = date_agg[dates[i-1]]['new_revenue'], date_agg[dates[i]]['new_revenue']
            if c1 > 100 and r1 > 0:
                cost_changes.append((c2 - c1) / c1)
                rev_changes.append((r2 - r1) / r1)
        
        if len(cost_changes) >= 5:
            # Correlation between cost change and revenue change
            mx = statistics.mean(cost_changes)
            my = statistics.mean(rev_changes)
            sx = statistics.stdev(cost_changes)
            sy = statistics.stdev(rev_changes)
            if sx > 0 and sy > 0:
                cov = sum((x-mx)*(y-my) for x,y in zip(cost_changes, rev_changes)) / (len(cost_changes)-1)
                r = cov / (sx * sy)
                # Simple elasticity = avg(Δrev%/Δcost%)
                elasticities = [rv/cv for cv, rv in zip(cost_changes, rev_changes) if abs(cv) > 0.05]
                med_elast = statistics.median(elasticities) if elasticities else None
                print(f"  {platform}: cost-revenue correlation r={r:.3f} (n={len(cost_changes)}), median elasticity={fmt_num(med_elast)}")


# ============================================================
# MAIN
# ============================================================
if __name__ == '__main__':
    print("=" * 70)
    print("CAMPAIGN FACTOR ANALYSIS")
    print(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 70)
    
    wide_table = load_wide_table()
    product_daily = load_product_daily()
    
    # Data summary
    dates = sorted(set(r['date'] for r in wide_table))
    print(f"\nData: {len(wide_table)} rows, {len(dates)} dates ({dates[0]} → {dates[-1]})")
    matched = sum(1 for r in wide_table if r['cost'] > 0 and r['revenue'] > 0)
    print(f"Rows with both cost and revenue: {matched}")
    
    platforms = defaultdict(int)
    for r in wide_table:
        platforms[r['platform']] += 1
    print(f"By platform: {dict(platforms)}")
    
    analyze_calendar_factor(wide_table, product_daily)
    analyze_momentum_factor(wide_table)
    analyze_volatility_factor(wide_table)
    analyze_spend_response(wide_table)
    
    print("\n" + "=" * 70)
    print("ANALYSIS COMPLETE")
    print("=" * 70)
