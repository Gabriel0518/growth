#!/usr/bin/env python3
"""
Rebuild analysis/product_daily_summary.csv from dashboard/data/YYYY-MM-DD.json.
Takes the LAST snapshot per day (most complete), reads athena[] (revenue) and
xmp[] (cost), aggregates per product.
Output columns: date,product,athena_total_revenue,athena_new_user_revenue,xmp_cost
"""
import json, csv, os, glob, re
from collections import defaultdict

WS = '/home/admin/.openclaw/workspace'
DATA_DIR = os.path.join(WS, 'dashboard', 'data')
OUT = os.path.join(WS, 'analysis', 'product_daily_summary.csv')

def main():
    rows = []
    files = sorted(glob.glob(os.path.join(DATA_DIR, '2026-*.json')))
    for fp in files:
        base = os.path.basename(fp)
        m = re.match(r'(\d{4}-\d{2}-\d{2})\.json$', base)
        if not m:
            continue  # skip personal-*.json, warehouse-tasks.json, etc.
        date = m.group(1)
        try:
            d = json.load(open(fp))
        except Exception as e:
            print(f"  skip {base}: {e}")
            continue
        snaps = d.get('snapshots', [])
        if not snaps:
            continue
        last = snaps[-1]
        athena = last.get('athena') or []
        xmp = last.get('xmp') or []

        agg = defaultdict(lambda: {'rev': 0.0, 'nrev': 0.0, 'cost': 0.0})
        for a in athena:
            p = a.get('product')
            if not p:
                continue
            agg[p]['rev'] += float(a.get('totalRevenue') or 0)
            agg[p]['nrev'] += float(a.get('newUserRevenue') or 0)
        for x in xmp:
            p = x.get('product')
            if not p:
                continue
            agg[p]['cost'] += float(x.get('cost') or 0)

        for p, v in agg.items():
            rows.append([date, p, v['rev'], v['nrev'], v['cost']])

    rows.sort(key=lambda r: (r[0], r[1]))
    with open(OUT, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['date', 'product', 'athena_total_revenue', 'athena_new_user_revenue', 'xmp_cost'])
        w.writerows(rows)

    dates = sorted(set(r[0] for r in rows))
    print(f"Wrote {len(rows)} rows, {len(dates)} days: {dates[0]} -> {dates[-1]}")

if __name__ == '__main__':
    main()
