#!/usr/bin/env python3
"""
Campaign Factor Analysis - Data Preparation & Analysis
Builds the unified wide table from SQLite revenue + XMP cost data,
then runs factor analyses.
"""

import json, csv, os, glob, sys
from datetime import datetime, timedelta
from collections import defaultdict
import statistics

ANALYSIS_DIR = '/home/admin/.openclaw/workspace/analysis'
DASHBOARD_DATA = '/home/admin/.openclaw/workspace/dashboard/data'

# app_id → product name mapping
APP_ID_MAP = {
    'com.doramatch.app': 'Dora And',
    'id6630480270': 'Dora iOS',
    'id6746109957': 'Dora iOS',
    '6746109957': 'Dora iOS',
    'com.romiandroid.appmatch': 'Romi And',
    'id6746782904': 'Romi iOS',
    '6746782904': 'Romi iOS',
    'com.doni.matchmingle': 'Doni',
    'com.doni.appa': 'Doni',
    'id6718753063': 'Luma',
    'com.jovia.findlove': 'Jovia And',
    'com.qiga.vio': 'Jovia And',
    'id6553669498': 'GraceChat',
    'id1658972379': 'GraceChat',
    'com.kiraromance.app': 'Kira And',
    'com.meraki.kira': 'Kira And',
    'id6740478498': 'Kira iOS',
    'com.naloandroid.app': 'Nalo And',
    'com.cavalier.nalo': 'Nalo And',
    'id6746466099': 'Luma',
    '6746466099': 'Luma',
}

# Platform normalization
PLATFORM_MAP = {
    'Facebook Ads': 'FB',
    'Facebook+Installs': 'FB',
    'Instagram+Installs': 'FB',
    'Off-Facebook+Installs': 'FB',
    'Luma+ios+FB+W2A': 'FB',
    'Dora+ios+FB+W2A': 'FB',
    'Facebook+web': 'FB',
    'googleadwords_int': 'GG',
    'tiktokglobal_int': 'TT',
    'TikTok+SAN': 'TT',
}

# Product → system
def get_system(product):
    if not product:
        return 'Unknown'
    if 'iOS' in product or product in ('Luma', 'GraceChat'):
        return 'iOS'
    elif 'And' in product or product in ('Doni',):
        return 'Android'
    return 'Unknown'


def load_revenue_data():
    """Load revenue CSVs from SQLite extraction"""
    revenue = defaultdict(lambda: {'revenue': 0, 'new_user_revenue': 0, 'installs': 0, 'purchase_events': 0})
    
    # AF data
    af_file = os.path.join(ANALYSIS_DIR, 'revenue_by_campaign_day.csv')
    with open(af_file) as f:
        reader = csv.DictReader(f)
        for row in reader:
            platform = PLATFORM_MAP.get(row['platform'])
            if not platform:
                continue
            product = APP_ID_MAP.get(row['app_id'], row['app_id'])
            campaign = row['campaign'].strip()
            date = row['install_date']
            if not date or date < '2026-03-30':
                continue
            
            key = (date, platform, product, campaign)
            revenue[key]['revenue'] += float(row['revenue'] or 0)
            revenue[key]['new_user_revenue'] += float(row['new_user_revenue'] or 0)
            revenue[key]['installs'] += int(row['installs'] or 0)
            revenue[key]['purchase_events'] += int(row['purchase_events'] or 0)
    
    # AD data (Adjust - iOS)
    ad_file = os.path.join(ANALYSIS_DIR, 'revenue_ad_by_campaign_day.csv')
    if os.path.exists(ad_file) and os.path.getsize(ad_file) > 0:
        with open(ad_file) as f:
            reader = csv.DictReader(f)
            for row in reader:
                platform_raw = row['platform']
                platform = PLATFORM_MAP.get(platform_raw)
                if not platform:
                    continue
                product = APP_ID_MAP.get(row['app_id'], row['app_id'])
                # AD campaign names have URL encoding and (id) suffix - clean them
                campaign = row['campaign'].strip()
                # Remove the (campaign_id) suffix
                import re
                campaign = re.sub(r'\+?\(%[0-9A-Fa-f]+\)$', '', campaign)
                campaign = re.sub(r'\+\(\d+\)$', '', campaign)
                from urllib.parse import unquote_plus
                campaign = unquote_plus(campaign).strip()
                
                date = row['install_date']
                if not date or date < '2026-03-30':
                    continue
                
                key = (date, platform, product, campaign)
                revenue[key]['revenue'] += float(row['revenue'] or 0)
                revenue[key]['new_user_revenue'] += float(row['new_user_revenue'] or 0)
                revenue[key]['installs'] += int(row['installs'] or 0)
                revenue[key]['purchase_events'] += int(row['purchase_events'] or 0)
    
    print(f"Revenue data: {len(revenue)} date×campaign entries")
    return dict(revenue)


def load_xmp_data():
    """Load XMP campaign cost data from both history and dashboard cache"""
    cost = defaultdict(lambda: {'cost': 0, 'impressions': 0, 'clicks': 0})
    
    sources = []
    
    # 1. Our fetched history
    hist_dir = os.path.join(ANALYSIS_DIR, 'xmp-history')
    if os.path.exists(hist_dir):
        for f in glob.glob(os.path.join(hist_dir, '*.json')):
            sources.append(f)
    
    # 2. Dashboard XMP cache
    cache_dir = os.path.join(DASHBOARD_DATA, 'xmp-cache')
    if os.path.exists(cache_dir):
        for f in glob.glob(os.path.join(cache_dir, 'xmp-campaigns-*.json')):
            sources.append(f)
    
    dates_loaded = set()
    for filepath in sources:
        try:
            with open(filepath) as f:
                d = json.load(f)
            
            # Extract date
            date = d.get('date')
            if not date:
                basename = os.path.basename(filepath)
                # xmp-campaigns-2026-05-20.json or 2026-05-20.json
                import re
                m = re.search(r'(\d{4}-\d{2}-\d{2})', basename)
                if m:
                    date = m.group(1)
            
            if not date or date in dates_loaded:
                continue
            
            data = d.get('data', [])
            if not data:
                continue
            
            dates_loaded.add(date)
            
            for row in data:
                product = row.get('product', '')
                campaign = (row.get('campaign', '') or '').strip()
                channel = row.get('channel', '')
                
                if not campaign or not channel:
                    continue
                
                key = (date, channel, product, campaign)
                cost[key]['cost'] += float(row.get('cost', 0))
                cost[key]['impressions'] += int(row.get('impressions', 0))
                cost[key]['clicks'] += int(row.get('clicks', 0))
        except Exception as e:
            print(f"  Warning: {filepath}: {e}")
    
    print(f"XMP cost data: {len(cost)} date×campaign entries from {len(dates_loaded)} dates")
    print(f"  Date range: {min(dates_loaded) if dates_loaded else 'N/A'} → {max(dates_loaded) if dates_loaded else 'N/A'}")
    return dict(cost), dates_loaded


def merge_data(revenue, cost_data, xmp_dates):
    """Merge revenue + cost into unified wide table"""
    # All keys we know about
    all_keys = set(revenue.keys()) | set(cost_data.keys())
    
    rows = []
    matched = 0
    revenue_only = 0
    cost_only = 0
    
    # Deduplicate by (date, platform, product, campaign)
    seen = set()
    
    for key in all_keys:
        if key in seen:
            continue
        seen.add(key)
        
        date, platform, product, campaign = key
        system = get_system(product)
        
        rev = revenue.get(key, {})
        cst = cost_data.get(key, {})
        
        row = {
            'date': date,
            'platform': platform,
            'product': product,
            'system': system,
            'campaign': campaign,
            'cost': cst.get('cost', 0),
            'impressions': cst.get('impressions', 0),
            'clicks': cst.get('clicks', 0),
            'revenue': rev.get('revenue', 0),
            'new_user_revenue': rev.get('new_user_revenue', 0),
            'installs': rev.get('installs', 0),
            'purchase_events': rev.get('purchase_events', 0),
        }
        
        if rev and cst:
            matched += 1
        elif rev:
            revenue_only += 1
        else:
            cost_only += 1
        
        rows.append(row)
    
    rows.sort(key=lambda r: (r['date'] or '', r['platform'] or '', r['product'] or '', r['campaign'] or ''))
    
    print(f"\nMerge results:")
    print(f"  Matched (revenue + cost): {matched}")
    print(f"  Revenue only: {revenue_only}")
    print(f"  Cost only: {cost_only}")
    print(f"  Total rows: {len(rows)}")
    
    # Save
    outfile = os.path.join(ANALYSIS_DIR, 'campaign_wide_table.csv')
    fields = ['date', 'platform', 'product', 'system', 'campaign', 
              'cost', 'impressions', 'clicks', 'revenue', 'new_user_revenue', 
              'installs', 'purchase_events']
    with open(outfile, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    
    print(f"  Saved to: {outfile}")
    return rows


def load_product_daily():
    """Load product-level daily summary (athena + xmp totals)"""
    rows = []
    pfile = os.path.join(ANALYSIS_DIR, 'product_daily_summary.csv')
    with open(pfile) as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({
                'date': row['date'],
                'product': row['product'],
                'system': get_system(row['product']),
                'athena_revenue': float(row['athena_total_revenue'] or 0),
                'athena_new_user_revenue': float(row['athena_new_user_revenue'] or 0),
                'xmp_cost': float(row['xmp_cost'] or 0),
            })
    print(f"\nProduct daily summary: {len(rows)} rows")
    return rows


if __name__ == '__main__':
    print("=" * 60)
    print("Campaign Factor Analysis - Data Preparation")
    print("=" * 60)
    
    print("\n--- Loading Revenue Data ---")
    revenue = load_revenue_data()
    
    print("\n--- Loading XMP Cost Data ---")
    cost_data, xmp_dates = load_xmp_data()
    
    print("\n--- Merging ---")
    wide_table = merge_data(revenue, cost_data, xmp_dates)
    
    print("\n--- Product Daily Summary ---")
    product_daily = load_product_daily()
    
    print("\n✅ Data preparation complete!")
    print(f"   Wide table: {len(wide_table)} rows → analysis/campaign_wide_table.csv")
    print(f"   Product summary: {len(product_daily)} rows → analysis/product_daily_summary.csv")
