#!/usr/bin/env python3
"""
Audit v2: compare Feishu daily report sheets vs AF/AD corrected revenue.
Uses SQLite directly for speed (no dashboard API dependency for revenue).
Uses dashboard API only for correction factors.
"""

import json
import subprocess
import re
import time
import sys
import sqlite3
import os
from collections import defaultdict
from datetime import datetime, timedelta

LARK_CLI = "/home/admin/.npm-global/bin/lark-cli"
DASH_COOKIE = "/tmp/dash_cookie"
DB_PATH = "/home/admin/dataserver/data.db"
SNAPSHOT_DIR = "/home/admin/.openclaw/workspace/dashboard/data/personal-snapshots"

OPERATORS = [
    ("曹永麟", "cyl", "LGHJspBWEhKs38tM5iJc86bPnEe"),
    ("张苗", "zm1", "YKYpsFMrQhaFAAtpw03cspgRnFc"),
    ("苏屹恒", "syh", "V7nysbQd3huZvStpd6Tcv7HUnJc"),
    ("武春香", "wcx", "FrkussvQEhZlMctf9LVck3stnge"),
    ("张梦凡", "zmf", "GjYNsCeKch1FG0t2U2hciYp0nTf"),
    ("刘欢", "lh", "AfF3s1VBOhZMXttnpi3cpSCvnxb"),
    ("马崇岩", "mcy", "CV5PsNbc2hSjr6teVUHcU5EpnJb"),
    ("王维维", "wvv", "CLEzsnKnkhU3JlthFSqctRa9n1b"),
    ("杨梅亭", "ymt", "PBoxsyZJ5hdBjNtRp7bcN9cfnsh"),
    ("张嘉铖", "zjc", "RJ1ys66ZbhG3dLtAgd4cZTnWnee"),
    ("吴天越", "wty", "ROcJs2IIfh57J2tucStcdvR2nJf"),
    ("陈祎", "cy1", "UuRysIekvhJgJEtQzxNceYRUnEb"),
]

OPERATOR_CODES = [code for _, code, _ in OPERATORS]

APP_ID_MAP = {
    'id6746109957': 'Dora iOS', 'com.circleconnect.dora': 'Dora iOS',
    'id6746782904': 'Romi iOS', 'com.chatsbridgeconnect.romi': 'Romi iOS',
    'id6746466099': 'Luma', 'com.odyssey.luma': 'Luma',
    'id1658972379': 'GraceChat',
    'id6759697686': 'Kira iOS',
    'com.doramatch.app': 'Dora And',
    'com.qiga.vio': 'Jovia And',
    'com.doni.appa': 'Doni',
    'com.romiandroid.appmatch': 'Romi And',
    'com.meraki.kira': 'Kira And',
    'com.cavalier.nalo': 'Nalo And',
}

# Reverse: product -> set of app_ids
PRODUCT_APP_IDS = defaultdict(set)
for aid, pname in APP_ID_MAP.items():
    PRODUCT_APP_IDS[pname].add(aid)

MEDIA_SOURCE_MAP = {
    'Facebook Ads': 'FB', 'Facebook+Installs': 'FB', 'Facebook Installs': 'FB',
    'Instagram+Installs': 'FB', 'Instagram Installs': 'FB',
    'Off-Facebook+Installs': 'FB', 'Social_facebook': 'FB', 'facebook': 'FB',
    'Facebook+web': 'FB W2A', 'Facebook web': 'FB W2A',
    'googleadwords_int': 'GG', 'Google Ads ACI': 'GG', 'Google+Ads+ACI': 'GG',
    'tiktokglobal_int': 'TT', 'TikTok+SAN': 'TT', 'TikTok SAN': 'TT',
}

ORGANIC_SOURCES = {'organic', 'Organic', 'restricted', 'Restricted', 'Unattributed', 'Untrusted Devices'}

def match_operator(campaign):
    if not campaign:
        return None
    lower = campaign.lower()
    for code in OPERATOR_CODES:
        if code in lower:
            return code
    if 'liuh' in lower:
        return 'lh'
    if 'zm' in lower and 'zmf' not in lower:
        return 'zm1'
    if 'Oc' in campaign:
        return 'cyl'
    return None

def map_media_source(ms):
    if not ms:
        return None
    return MEDIA_SOURCE_MAP.get(ms)

def normalize_product(name):
    name = name.strip()
    low = name.lower()
    if 'gc' in low or 'gracechat' in low:
        return 'GraceChat'
    if 'dora' in low and ('and' in low or 'android' in low):
        return 'Dora And'
    if 'dora' in low and ('ios' in low or 'iphone' in low):
        return 'Dora iOS'
    if 'doni' in low:
        return 'Doni'
    if 'romi' in low and ('and' in low or 'android' in low):
        return 'Romi And'
    if 'romi' in low and ('ios' in low or 'iphone' in low):
        return 'Romi iOS'
    if 'luma' in low:
        return 'Luma'
    if 'jovia' in low:
        return 'Jovia And'
    if 'kira' in low and ('and' in low or 'android' in low):
        return 'Kira And'
    if 'kira' in low and ('ios' in low or 'iphone' in low):
        return 'Kira iOS'
    if 'nalo' in low:
        return 'Nalo And'
    return None

def normalize_channel_from_title(name):
    name = name.strip().upper()
    if 'W2A' in name:
        return 'FB W2A'
    if 'FB' in name:
        return 'FB'
    if 'TT' in name:
        return 'TT'
    if 'GG' in name or 'GOOGLE' in name:
        return 'GG'
    return None

def should_skip_sheet(title):
    skip_words = ['汇总', '测新', 'PWA', '赠款', 'Unity', 'Elara', '下架', '主播', 'W2A', 'w2a', 'YSN']
    for w in skip_words:
        if w in title:
            return True
    return False

def parse_sheet_title(title):
    for name, _, _ in OPERATORS:
        title = title.replace(name, '').strip()
    # Extract channel from end
    channel = None
    product_part = title
    # Match patterns like "Dora And FB", "Romi ios TT"
    m = re.match(r'^(.+?)\s+(FB|TT|GG|fb|tt|gg)\s*$', title)
    if m:
        product_part = m.group(1)
        channel = normalize_channel_from_title(m.group(2))
    elif re.search(r'\b(FB|TT|GG)\b', title.upper()):
        for ch in ['FB', 'TT', 'GG']:
            if ch in title.upper():
                channel = ch
                product_part = re.sub(r'\s*[-]?\s*' + ch, '', title, flags=re.IGNORECASE).strip()
                break
    product = normalize_product(product_part)
    return product, channel

def parse_money(val):
    if not val:
        return None
    val = str(val).strip()
    if val in ('', '#DIV/0!', '#N/A', '#REF!', '-', 'N/A'):
        return None
    neg = False
    if val.startswith('-') or val.startswith('($') or val.startswith('-$'):
        neg = True
    val = val.replace('$', '').replace(',', '').replace(' ', '').replace('(', '').replace(')', '')
    if val.startswith('-'):
        val = val[1:]
        neg = True
    try:
        v = float(val)
        return -v if neg else v
    except ValueError:
        return None

def parse_date(val):
    if not val:
        return None
    val = str(val).strip()
    for fmt in ['%Y/%m/%d', '%Y-%m-%d']:
        try:
            dt = datetime.strptime(val, fmt)
            return dt.strftime('%Y-%m-%d')
        except ValueError:
            continue
    try:
        serial = float(val)
        if 40000 < serial < 50000:
            dt = datetime(1899, 12, 30) + timedelta(days=serial)
            return dt.strftime('%Y-%m-%d')
    except (ValueError, TypeError):
        pass
    return None

def run_lark_cli(*args, timeout=30):
    cmd = [LARK_CLI] + list(args) + ['--as', 'user', '--format', 'json']
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = p.communicate(timeout=timeout)
        return json.loads(out.decode('utf-8', errors='replace'))
    except Exception as e:
        print("  [WARN] lark-cli error: {}".format(e), file=sys.stderr)
        return None

def run_cmd(cmd, text_output=False):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = p.communicate()
    if text_output:
        return out.decode('utf-8', errors='replace')
    return out

def login_dashboard():
    run_cmd(['curl', '-s', '-c', DASH_COOKIE, '-L',
             'http://localhost:8081/login',
             '-d', f'username=admin&password={os.environ.get("DASHBOARD_ADMIN_PASS", "")}',
             '-o', '/dev/null'])

def get_correction_factors(date):
    out = run_cmd(['curl', '-s', '-b', DASH_COOKIE,
                   'http://localhost:8081/api/correction-factors?startDate={}&endDate={}'.format(date, date)],
                  text_output=True)
    try:
        return json.loads(out)
    except:
        return None

def get_factor(factors, product, channel):
    f = factors.get(product)
    if f is None:
        return 1.0
    if isinstance(f, (int, float)):
        return float(f)
    if channel in ('FB', 'FB W2A'):
        return float(f.get('fb', 1.0))
    return float(f.get('other', 1.0))

def table_for_month(date_str):
    return 'records_' + date_str[:7].replace('-', '')

def main():
    print("=" * 60)
    print("投放日报核查脚本 v2 (SQLite 直查)")
    print("=" * 60)
    sys.stdout.flush()

    # Date range
    start_date = "2026-05-11"
    end_date = "2026-06-08"
    dates = []
    d = datetime.strptime(start_date, '%Y-%m-%d')
    end_d = datetime.strptime(end_date, '%Y-%m-%d')
    while d <= end_d:
        dates.append(d.strftime('%Y-%m-%d'))
        d += timedelta(days=1)
    print("  核查范围: {} ~ {} ({} 天)".format(start_date, end_date, len(dates)))
    sys.stdout.flush()

    # Step 1: Get correction factors from dashboard API
    print("\n[1/4] 获取修正系数...")
    sys.stdout.flush()
    login_dashboard()
    correction_data = {}
    for i, date in enumerate(dates):
        resp = get_correction_factors(date)
        if resp and resp.get('factors'):
            correction_data[date] = resp['factors']
        if (i + 1) % 10 == 0:
            print("  {} / {}".format(i + 1, len(dates)))
            sys.stdout.flush()
    print("  获取完成: {} 天有修正系数".format(len(correction_data)))
    sys.stdout.flush()

    # Step 2: Build dashboard revenue from SQLite
    print("\n[2/4] 从 SQLite 构建 AF/AD 收入数据...")
    sys.stdout.flush()
    db = sqlite3.connect(DB_PATH)
    
    # dash_revenue[date][operator_code][product|channel] = total_revenue (event_time based)
    dash_revenue = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    
    # Query AF purchase data
    for table in ['records_202605', 'records_202606']:
        try:
            rows = db.execute("""
                SELECT date(event_time, '+8 hours') as d, campaign, app_id, media_source, revenue
                FROM {}
                WHERE event_name = 'af_purchase'
                  AND date(event_time, '+8 hours') BETWEEN ? AND ?
                  AND media_source NOT IN ('organic', 'Organic', 'restricted', 'Restricted', 'Unattributed', 'Untrusted Devices')
            """.format(table), (start_date, end_date)).fetchall()
            for d, campaign, app_id, ms, rev in rows:
                if not campaign or not app_id or not ms:
                    continue
                operator = match_operator(campaign.strip()) or 'other'
                product = APP_ID_MAP.get(app_id)
                channel = map_media_source(ms)
                if not product or not channel:
                    continue
                key = "{}|{}".format(product, channel)
                dash_revenue[d][operator][key] += (rev or 0)
            print("  {}: {} 条 AF 记录".format(table, len(rows)))
        except Exception as e:
            print("  [WARN] {}: {}".format(table, e))
        sys.stdout.flush()
    
    # Query AD (Adjust) purchase data for iOS
    AD_PAID_SOURCES = {
        'Facebook+Installs', 'Facebook Installs',
        'Instagram+Installs', 'Instagram Installs',
        'Facebook+web', 'Facebook web',
        'TikTok+SAN', 'TikTok SAN',
        'Google+Ads+ACI', 'Google Ads ACI',
    }
    AD_ORGANIC = {'Organic', 'Unattributed', 'organic', 'restricted', 'Untrusted Devices'}
    
    for table in ['records_202605', 'records_202606']:
        try:
            rows = db.execute("""
                SELECT date(event_time, '+8 hours') as d, campaign, app_id, media_source, revenue
                FROM {}
                WHERE event_name = 'ad_purchase'
                  AND date(event_time, '+8 hours') BETWEEN ? AND ?
            """.format(table), (start_date, end_date)).fetchall()
            ad_count = 0
            for d, campaign, app_id, ms, rev in rows:
                if not ms or ms in AD_ORGANIC:
                    # AD Unattributed -> FB
                    if ms == 'Unattributed':
                        channel = 'FB'
                    else:
                        continue
                else:
                    if ms not in AD_PAID_SOURCES:
                        continue
                    channel = map_media_source(ms)
                    if not channel:
                        continue
                
                # Decode AD campaign (URL-encoded with (id) suffix)
                if campaign:
                    try:
                        import urllib.parse
                        campaign = urllib.parse.unquote(campaign.replace('+', ' '))
                    except:
                        pass
                    campaign = re.sub(r'\s*\(.*?\)\s*$', '', campaign).strip()
                
                operator = match_operator(campaign) or 'other'
                product = APP_ID_MAP.get(app_id)
                if not product:
                    # AD uses numeric app_id without 'id' prefix
                    product = APP_ID_MAP.get('id' + str(app_id)) if app_id else None
                if not product:
                    continue
                key = "{}|{}".format(product, channel)
                dash_revenue[d][operator][key] += (rev or 0)
                ad_count += 1
            print("  {}: {} 条 AD 记录 (paid)".format(table, ad_count))
        except Exception as e:
            print("  [WARN] AD {}: {}".format(table, e))
        sys.stdout.flush()
    
    print("  共 {} 天有收入数据".format(len(dash_revenue)))
    sys.stdout.flush()

    # Step 3: Read Feishu sheets
    print("\n[3/4] 读取飞书日报表格...")
    sys.stdout.flush()
    feishu_data = {}  # op_code -> {product|channel -> {date -> revenue}}
    
    for op_name, op_code, token in OPERATORS:
        print("\n  === {} ({}) ===".format(op_name, op_code))
        sys.stdout.flush()
        sheets = run_lark_cli('api', 'GET', '/open-apis/sheets/v3/spreadsheets/{}/sheets/query'.format(token))
        time.sleep(0.5)
        if not sheets:
            print("    [ERROR] 无法获取 sheet 列表")
            continue
        
        feishu_data[op_code] = {}
        
        for sheet in sheets.get('data', {}).get('sheets', []):
            title = sheet.get('title', '')
            sheet_id = sheet.get('sheet_id', '')
            
            if should_skip_sheet(title):
                continue
            
            product, channel = parse_sheet_title(title)
            if not product or not channel:
                print("    [SKIP] 无法解析: {}".format(title))
                continue
            
            key = "{}|{}".format(product, channel)
            
            # Read header + data rows
            rows = []
            try:
                data = run_lark_cli('sheets', '+cells-get',
                                    '--spreadsheet-token', token,
                                    '--sheet-id', sheet_id,
                                    '--range', 'A1:G50')
                time.sleep(0.5)
                if data and data.get('ok'):
                    for rng in data.get('data', {}).get('ranges', []):
                        for row in rng.get('cells', []):
                            vals = []
                            for c in row:
                                if isinstance(c, dict):
                                    vals.append(c.get('value', ''))
                                else:
                                    vals.append('')
                            rows.append(vals)
            except Exception as e:
                print("    [ERROR] 读取失败 {}: {}".format(title, e))
                continue
            
            if not rows or len(rows) < 2:
                continue
            
            header = rows[0]
            
            # Detect revenue column: find 修正收入 or 总收入
            rev_col = None
            rev_col_name = None
            for ci, h in enumerate(header):
                h_str = str(h).strip()
                if h_str == '修正收入':
                    rev_col = ci
                    rev_col_name = '修正收入'
                    break
                elif h_str == '总收入':
                    rev_col = ci
                    rev_col_name = '总收入'
                    break
            
            # Fallback: if only 原始收入, use that
            if rev_col is None:
                for ci, h in enumerate(header):
                    h_str = str(h).strip()
                    if h_str == '原始收入':
                        rev_col = ci
                        rev_col_name = '原始收入(无修正)'
                        break
            
            if rev_col is None:
                print("    [SKIP] {} - 无法找到收入列, header: {}".format(title, [str(h) for h in header[:8]]))
                continue
            
            print("    {} -> {} {} (col {}={})".format(title, product, channel, chr(65 + rev_col), rev_col_name))
            
            if key not in feishu_data[op_code]:
                feishu_data[op_code][key] = {}
            
            for row in rows[1:]:
                if len(row) <= rev_col:
                    continue
                date_str = parse_date(row[0])
                if not date_str or date_str < start_date or date_str > end_date:
                    continue
                rev_val = parse_money(row[rev_col])
                if rev_val is None:
                    continue
                feishu_data[op_code][key][date_str] = {
                    'value': rev_val,
                    'col_name': rev_col_name,
                }
        sys.stdout.flush()
    
    # Step 4: Compare
    print("\n[4/4] 对比数据...")
    sys.stdout.flush()
    
    issues = []
    total_checked = 0
    total_matched = 0
    
    for op_name, op_code, _ in OPERATORS:
        op_feishu = feishu_data.get(op_code, {})
        
        for key, date_vals in op_feishu.items():
            product, channel = key.split('|')
            
            for date, feishu_info in date_vals.items():
                feishu_rev = feishu_info['value']
                col_name = feishu_info['col_name']
                
                if date not in correction_data:
                    continue
                
                total_checked += 1
                
                # Get dashboard AF/AD raw revenue
                raw_rev = dash_revenue.get(date, {}).get(op_code, {}).get(key, 0)
                
                # Calculate corrected revenue
                factors = correction_data[date]
                factor = get_factor(factors, product, channel)
                corrected_rev = raw_rev * factor
                
                # Compare
                diff = feishu_rev - corrected_rev
                abs_diff = abs(diff)
                base = max(abs(feishu_rev), abs(corrected_rev), 1)
                pct = (abs_diff / base) * 100
                
                if abs_diff > 10 and pct > 10:
                    issues.append({
                        'operator': op_name,
                        'code': op_code,
                        'product': product,
                        'channel': channel,
                        'date': date,
                        'feishu': round(feishu_rev, 2),
                        'dashboard_raw': round(raw_rev, 2),
                        'factor': round(factor, 4),
                        'dashboard_corrected': round(corrected_rev, 2),
                        'diff': round(diff, 2),
                        'abs_diff': round(abs_diff, 2),
                        'pct': round(pct, 1),
                        'col_name': col_name,
                    })
                else:
                    total_matched += 1
    
    # Restricted analysis
    print("\n  分析 restricted 数据...")
    sys.stdout.flush()
    restricted_data = []
    for table in ['records_202605', 'records_202606']:
        try:
            rows = db.execute("""
                SELECT app_id, media_source, COUNT(*) as cnt, SUM(revenue) as total_rev
                FROM {}
                WHERE event_name = 'af_purchase'
                  AND (media_source IN ('restricted', 'Restricted')
                       OR LOWER(campaign) LIKE '%restricted%'
                       OR LOWER(campaign) LIKE '%unknown%')
                  AND date(event_time, '+8 hours') BETWEEN ? AND ?
                GROUP BY app_id, media_source
            """.format(table), (start_date, end_date)).fetchall()
            for app_id, ms, cnt, rev in rows:
                product = APP_ID_MAP.get(app_id, app_id)
                restricted_data.append({
                    'product': product,
                    'media_source': ms or '(null)',
                    'count': cnt,
                    'revenue': round(rev or 0, 2),
                })
        except Exception as e:
            print("  [WARN] restricted {}: {}".format(table, e))
    
    # Aggregate restricted by product
    restricted_by_product = defaultdict(lambda: {'count': 0, 'revenue': 0.0})
    for r in restricted_data:
        p = r['product']
        restricted_by_product[p]['count'] += r['count']
        restricted_by_product[p]['revenue'] += r['revenue']
    
    db.close()
    
    # Sort issues by abs_diff descending
    issues.sort(key=lambda x: -x['abs_diff'])
    
    # Output
    print("\n" + "=" * 80)
    print("核查完成!")
    print("  总数据点: {}".format(total_checked))
    print("  匹配 (diff < $10 或 < 10%): {}".format(total_matched))
    print("  差异显著 (diff > $10 且 > 10%): {}".format(len(issues)))
    print("  restricted 产品: {}".format(len(restricted_by_product)))
    sys.stdout.flush()

    # Group issues by operator
    issues_by_op = defaultdict(list)
    for issue in issues:
        issues_by_op[issue['operator']].append(issue)
    
    # Print summary
    if issues:
        print("\n  差异按投手统计:")
        for op_name in sorted(issues_by_op.keys()):
            op_issues = issues_by_op[op_name]
            total_abs = sum(i['abs_diff'] for i in op_issues)
            print("    {}: {} 条差异, 总绝对偏差 ${:.2f}".format(op_name, len(op_issues), total_abs))
    
    # Print top issues
    if issues:
        print("\n  Top 30 差异项:")
        print("  {:<6s} {:<10s} {:<4s} {:<12s} {:>10s} {:>10s} {:>10s} {:>6s}".format(
            '投手', '产品', '渠道', '日期', '飞书', 'Dashboard', '差额', '偏差%'))
        print("  " + "-" * 70)
        for issue in issues[:30]:
            print("  {:<6s} {:<10s} {:<4s} {:<12s} ${:>9.2f} ${:>9.2f} ${:>9.2f} {:>5.1f}%".format(
                issue['operator'], issue['product'], issue['channel'], issue['date'],
                issue['feishu'], issue['dashboard_corrected'], issue['diff'], issue['pct']))
    
    # Print restricted
    if restricted_by_product:
        print("\n  Restricted 收入按产品:")
        for p in sorted(restricted_by_product.keys(), key=lambda x: -restricted_by_product[x]['revenue']):
            d = restricted_by_product[p]
            print("    {:<12s} {} 笔  ${:.2f}".format(p, d['count'], d['revenue']))
    
    # Save full report JSON
    report = {
        'summary': {
            'date_range': '{} ~ {}'.format(start_date, end_date),
            'total_dates': len(dates),
            'total_checked': total_checked,
            'total_matched': total_matched,
            'total_issues': len(issues),
        },
        'issues': issues,
        'issues_by_operator': {k: v for k, v in issues_by_op.items()},
        'restricted_by_product': dict(restricted_by_product),
        'restricted_detail': restricted_data,
    }
    
    output_path = '/home/admin/.openclaw/workspace/scripts/audit-report.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("\n报告 JSON 已保存到: {}".format(output_path))
    sys.stdout.flush()

if __name__ == '__main__':
    main()
