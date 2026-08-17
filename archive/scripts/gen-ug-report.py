#!/usr/bin/env python3
"""Generate UG早报 - fully dynamic, queries data from DB + cache"""
import json, os, sys, sqlite3, subprocess, urllib.request
from datetime import datetime, timedelta

def parse_args():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', default=None, help='Report date (YYYY-MM-DD), default=today')
    return parser.parse_args()

args = parse_args()
if args.date:
    report_date = datetime.strptime(args.date, '%Y-%m-%d')
else:
    report_date = datetime.now()

yesterday = report_date - timedelta(days=1)
dates_7d = [(yesterday - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(6, -1, -1)]
yesterday_str = yesterday.strftime('%Y-%m-%d')

APP_MAP = {
    'id6746109957': 'Dora iOS', 'id6746782904': 'Romi iOS', 'id6746466099': 'Luma',
    'id1658972379': 'GraceChat', 'id6759697686': 'Kira iOS',
    'com.doramatch.app': 'Dora And', 'com.qiga.vio': 'Jovia And',
    'com.doni.appa': 'Doni', 'com.romiandroid.appmatch': 'Romi And',
    'com.meraki.kira': 'Kira And', 'com.cavalier.nalo': 'Nalo And',
}
AD_APP_MAP = {'6746109957': 'Dora iOS', '6746782904': 'Romi iOS', '6746466099': 'Luma'}
XMP_NAME_MAP = {'Nalo: Meet, Swipe & Chat': 'Nalo And'}
REV_APP_MAP = {v: k for k, v in APP_MAP.items()}
products_display = ['Dora iOS', 'Romi iOS', 'Doni', 'Luma', 'Dora And', 'Kira And',
                    'Jovia And', 'GraceChat', 'Romi And', 'Nalo And', 'Kira iOS']

base = '/home/admin/.openclaw/workspace/dashboard/data'

# ── 1. Athena + XMP from cache ──
athena_7d, xmp_7d = {}, {}
missing_dates = []
for dt in dates_7d:
    athena_7d[dt], xmp_7d[dt] = {}, {}
    fpath = f'{base}/{dt}.json'
    if not os.path.exists(fpath):
        missing_dates.append(dt)
        continue
    with open(fpath) as f:
        d = json.load(f)
    last = d['snapshots'][-1]
    for p in (last.get('athena') or []):
        athena_7d[dt][p['product']] = p['totalRevenue']
    for x in (last.get('xmp') or []):
        pname = x.get('product')
        if pname is None: continue
        pname = XMP_NAME_MAP.get(pname, pname)
        xmp_7d[dt][pname] = xmp_7d[dt].get(pname, 0) + x.get('cost', 0)

athena_ytd = sum(athena_7d[yesterday_str].values()) if athena_7d[yesterday_str] else 0
athena_7d_avg = sum(sum(athena_7d[d].values()) for d in dates_7d) / 7
xmp_ytd = sum(xmp_7d[yesterday_str].values()) if xmp_7d[yesterday_str] else 0
xmp_7d_avg = sum(sum(xmp_7d[d].values()) for d in dates_7d) / 7

# ── 2. AF registration from SQLite ──
db_path = '/home/admin/dataserver/data.db'
af_reg = {dt: {} for dt in dates_7d}
af_reg_products = set()

if os.path.exists(db_path):
    db = sqlite3.connect(db_path)
    # Get current month table name
    table = f'records_{yesterday.strftime("%Y%m")}'
    try:
        rows = db.execute(f"""
            SELECT DATE(datetime(event_time, '+8 hours')) as dt, app_id, COUNT(*) as cnt
            FROM {table}
            WHERE event_name='af_complete_registration'
              AND DATE(datetime(event_time, '+8 hours')) BETWEEN ? AND ?
            GROUP BY dt, app_id
            ORDER BY dt, app_id
        """, (dates_7d[0], dates_7d[-1])).fetchall()
        for dt, aid, cnt in rows:
            pname = APP_MAP.get(aid)
            if pname:
                af_reg[dt][pname] = cnt
                af_reg_products.add(pname)
    finally:
        db.close()

products_cpi = sorted([p for p in af_reg_products], key=lambda p: (
    xmp_7d[yesterday_str].get(p, 0) / af_reg[yesterday_str].get(p, 1) 
    if af_reg[yesterday_str].get(p, 0) > 0 and xmp_7d[yesterday_str].get(p, 0) > 0 
    else 999))

# CPI calculations
cpi_ytd, cpi_7d = {}, {}
cpi_products_valid = []  # has both reg and cost
cpi_products_nocost = []  # has reg but no cost
for p in af_reg_products:
    inst_y = af_reg[yesterday_str].get(p, 0)
    cost_y = xmp_7d[yesterday_str].get(p, 0)
    if inst_y > 0 and cost_y > 0:
        cpi_ytd[p] = cost_y / inst_y
        inst_7 = sum(af_reg[d].get(p, 0) for d in dates_7d)
        cost_7 = sum(xmp_7d[d].get(p, 0) for d in dates_7d)
        cpi_7d[p] = cost_7 / inst_7 if inst_7 else 0
        cpi_products_valid.append(p)
    elif inst_y > 0 and cost_y == 0:
        cpi_products_nocost.append(p)

cpi_products_valid.sort(key=lambda p: cpi_ytd[p])

tc_y = sum(xmp_7d[yesterday_str].get(p,0) for p in cpi_products_valid)
ti_y = sum(af_reg[yesterday_str].get(p,0) for p in cpi_products_valid)
tc_7 = sum(sum(xmp_7d[d].get(p,0) for p in cpi_products_valid) for d in dates_7d)
ti_7 = sum(sum(af_reg[d].get(p,0) for p in cpi_products_valid) for d in dates_7d)

# ── 3. AF new user revenue from SQLite ──
nu_7d = {dt: {} for dt in dates_7d}

if os.path.exists(db_path):
    db = sqlite3.connect(db_path)
    table = f'records_{yesterday.strftime("%Y%m")}'
    try:
        af_rows = db.execute(f"""
            SELECT DATE(datetime(install_time, '+8 hours')) as dt, app_id,
                   ROUND(SUM(revenue), 2) as new_user_rev
            FROM {table}
            WHERE event_name='af_purchase'
              AND DATE(datetime(install_time, '+8 hours')) BETWEEN ? AND ?
              AND (julianday(event_time) - julianday(install_time)) * 24 < 24
              AND (julianday(event_time) - julianday(install_time)) >= 0
            GROUP BY dt, app_id
        """, (dates_7d[0], dates_7d[-1])).fetchall()
        for dt, aid, rev in af_rows:
            pname = APP_MAP.get(aid)
            if pname:
                nu_7d[dt][pname] = nu_7d[dt].get(pname, 0) + rev
    finally:
        db.close()

# ── 4. eLTV D180 multipliers from API ──
eltv_d180 = {}
try:
    # Login first using cookie jar
    cookie_path = '/tmp/ug_report_dash_cookie'
    login_url = 'http://localhost:8081/login'
    login_data = ('username=admin&password=' + os.environ.get('DASHBOARD_ADMIN_PASS','')).encode()

    import http.cookiejar
    cj = http.cookiejar.MozillaCookieJar(cookie_path)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    # Perform login
    req = urllib.request.Request(login_url, data=login_data)
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    resp = opener.open(req)
    resp.read()
    cj.save(ignore_discard=True, ignore_expires=True)

    # Get eLTV
    req2 = urllib.request.Request(f'http://localhost:8081/api/eltv-multipliers?date={yesterday_str}')
    resp2 = opener.open(req2)
    eltv_data = json.loads(resp2.read())
    
    for pname, info in eltv_data.get('multipliers', {}).items():
        d180 = info.get('d180')
        d1span = info.get('d1Span', 0)
        records = info.get('records', 0)
        # Skip unreliable products
        if d180 is None or d180 <= 0 or d1span < 10 or records < 1000:
            continue
        eltv_d180[pname] = round(d180, 2)
except Exception as e:
    print(f"⚠️ eLTV API failed: {e}", file=sys.stderr)
    # Fallback static values
    eltv_d180 = {
        'Dora iOS': 3.20, 'Romi iOS': 3.40, 'Luma': 2.95, 'GraceChat': 6.29,
        'Dora And': 17.81, 'Jovia And': 12.29, 'Doni': 6.52, 'Kira And': 5.26,
    }

eltv_ytd, eltv_7davg = {}, {}
for p, m in eltv_d180.items():
    eltv_ytd[p] = nu_7d[yesterday_str].get(p, 0) * m
    nu_7d_total = sum(nu_7d[d].get(p, 0) for d in dates_7d)
    eltv_7davg[p] = (nu_7d_total / 7) * m
eltv_total_ytd = sum(eltv_ytd.values())
eltv_total_7davg = sum(eltv_7davg.values())

# ── Output ──
lines = []
lines.append(f"📊 UG早报 {report_date.strftime('%Y.%m.%d')}")
lines.append("")
lines.append("━━━━━━━━━━━━━━━━━━━━━━")
lines.append("")
lines.append("💰 营收（雅典娜口径）")
lines.append("  产品 · 昨日 / 7日均：")
for p in products_display:
    y = athena_7d[yesterday_str].get(p, 0)
    avg = sum(athena_7d[d].get(p, 0) for d in dates_7d) / 7
    if y > 0:
        lines.append(f"    {p}：${y:,.0f} / ${avg:,.0f}")
lines.append(f"  【合计：${athena_ytd:,.0f} / ${athena_7d_avg:,.0f}】")
lines.append("")

lines.append("💸 消耗（XMP口径）")
lines.append("  产品 · 昨日 / 7日均：")
xmp_products = sorted([p for p in set(sum([list(x.keys()) for x in xmp_7d.values()], [])) 
                        if xmp_7d[yesterday_str].get(p, 0) > 0],
                       key=lambda p: xmp_7d[yesterday_str][p], reverse=True)
for p in xmp_products:
    y = xmp_7d[yesterday_str][p]
    avg = sum(xmp_7d[d].get(p, 0) for d in dates_7d) / 7
    lines.append(f"    {p}：${y:,.0f} / ${avg:,.0f}")
lines.append(f"  【合计：${xmp_ytd:,.0f} / ${xmp_7d_avg:,.0f}】")
lines.append("")

lines.append("📈 CPI（XMP消耗 ÷ af_complete_registration）")
if cpi_products_valid:
    lines.append("  昨日 / 7日均：")
    for p in cpi_products_valid:
        lines.append(f"    {p}：${cpi_ytd[p]:.2f} / ${cpi_7d[p]:.2f}")
    lines.append(f"  【整体：${tc_y/ti_y:.2f} / ${tc_7/ti_7:.2f}】")
    if cpi_products_nocost:
        lines.append(f"  ⚠️ 有注册无消耗（已停投）：{', '.join(cpi_products_nocost)}")
else:
    lines.append("  ⚠️ 无数据（AF注册事件缺失）")
lines.append("")

lines.append("🔮 eLTV收入（AF新用户收入 × D180倍数）")
if eltv_d180:
    lines.append("  昨日 / 7日均：")
    for p in sorted(eltv_d180.keys(), key=lambda x: eltv_ytd[x], reverse=True):
        nu = nu_7d[yesterday_str].get(p, 0)
        m = eltv_d180[p]
        e = eltv_ytd[p]
        e_avg = eltv_7davg[p]
        lines.append(f"    {p}：${nu:,.0f} × {m:.1f}x = ${e:,.0f} / ${e_avg:,.0f}")
    lines.append(f"  【全产品eLTV合计：${eltv_total_ytd:,.0f} / ${eltv_total_7davg:,.0f}】")
else:
    lines.append("  ⚠️ 无eLTV数据")
lines.append("")

if missing_dates:
    lines.append(f"  ⚠️ 缺少缓存数据：{', '.join(missing_dates)}")
    lines.append("")

lines.append("━━━━━━━━━━━━━━━━━━━━━━")
lines.append("")
lines.append("📎 备注：")
lines.append("1. CPI = XMP消耗 ÷ af_complete_registration（含全渠道注册含自然量，已去重，含user ID可溯源查用户）。部分安卓产品（Romi And、Jovia And、Kira And）暂未接入该埋点，研发已修复，等待发版更新。")
lines.append("2. eLTV收入为预估值，基于三指数衰减模型拟合D180衰减曲线。数据量不足或倍数不可靠的产品已自动排除。")
lines.append("3. 新用户收入仅使用AF回传数据（AF和AD均包含全量应用内事件，仅归因不同，合并会重复计算）。")

print("\n".join(lines))
