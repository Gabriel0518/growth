#!/usr/bin/env python3
"""
Audit script: compare Feishu daily report sheets vs dashboard AF/AD corrected revenue.
Reads all operator sheets from Feishu, reads dashboard data via API, and generates a diff report.
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

# Operator spreadsheet tokens
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

# Product name normalization
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

def normalize_channel(name):
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
    """Extract product and channel from sheet title like 'Dora And FB' or '曹永麟Dora And FB'"""
    # Remove operator name prefixes
    for name, _, _ in OPERATORS:
        title = title.replace(name, '').strip()
    
    # Try to find channel suffix
    channel = None
    product_part = title
    for ch in ['FB', 'TT', 'GG', 'fb', 'tt', 'gg']:
        if title.upper().endswith(' ' + ch.upper()) or title.upper().endswith('-' + ch.upper()):
            channel = normalize_channel(ch)
            product_part = title[:-(len(ch))].rstrip(' -')
            break
    
    if not channel:
        # Try matching channel in title
        for ch in ['FB', 'TT', 'GG']:
            if ch in title.upper().split():
                channel = ch
                product_part = title.upper().replace(ch, '').strip()
                break
    
    product = normalize_product(product_part)
    return product, channel

def parse_money(val):
    """Parse money string like '$1,234.56' or '1234.56' or '' to float"""
    if not val:
        return None
    val = str(val).strip()
    if val in ['', '#DIV/0!', '#N/A', '#REF!', '-', 'N/A']:
        return None
    val = val.replace('$', '').replace(',', '').replace(' ', '')
    if val.startswith('(') and val.endswith(')'):
        val = '-' + val[1:-1]
    try:
        return float(val)
    except ValueError:
        return None

def parse_date(val):
    """Parse date like '2026/6/8' or '2026-06-08' to 'YYYY-MM-DD'"""
    if not val:
        return None
    val = str(val).strip()
    # Try various formats
    for fmt in ['%Y/%m/%d', '%Y-%m-%d', '%Y/%m/%d %H:%M:%S']:
        try:
            dt = datetime.strptime(val, fmt)
            return dt.strftime('%Y-%m-%d')
        except ValueError:
            continue
    # Try numeric (Excel serial)
    try:
        serial = float(val)
        if 40000 < serial < 50000:
            dt = datetime(1899, 12, 30) + timedelta(days=serial)
            return dt.strftime('%Y-%m-%d')
    except (ValueError, TypeError):
        pass
    return None

def run_lark_cli(*args, timeout=30):
    """Run lark-cli with args and return parsed JSON"""
    cmd = [LARK_CLI] + list(args) + ['--as', 'user', '--format', 'json']
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = p.communicate(timeout=timeout)
        return json.loads(out.decode('utf-8', errors='replace'))
    except Exception as e:
        print("  [WARN] lark-cli error: {}".format(e), file=sys.stderr)
        return None

def get_sheets(spreadsheet_token):
    """Get all sheets in a spreadsheet"""
    data = run_lark_cli('api', 'GET', f'/open-apis/sheets/v3/spreadsheets/{spreadsheet_token}/sheets/query')
    if not data:
        return []
    return data.get('data', {}).get('sheets', [])

def read_cells(spreadsheet_token, sheet_id, range_str):
    """Read cells from a sheet"""
    data = run_lark_cli('sheets', '+cells-get',
                        '--spreadsheet-token', spreadsheet_token,
                        '--sheet-id', sheet_id,
                        '--range', range_str)
    if not data or not data.get('ok'):
        return []
    rows = []
    for rng in data.get('data', {}).get('ranges', []):
        for row in rng.get('cells', []):
            vals = []
            for c in row:
                if isinstance(c, dict):
                    vals.append(c.get('value', ''))
                else:
                    vals.append('')
            rows.append(vals)
    return rows

def run_cmd(cmd, text_output=False):
    """Python 3.6 compatible subprocess.run"""
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = p.communicate()
    if text_output:
        return out.decode('utf-8', errors='replace')
    return out

def login_dashboard():
    """Login to dashboard and save cookie"""
    run_cmd([
        'curl', '-s', '-c', DASH_COOKIE, '-L',
        'http://localhost:8081/login',
        '-d', f'username=admin&password={os.environ.get("DASHBOARD_ADMIN_PASS", "")}',
        '-o', '/dev/null'
    ])

def get_dashboard_personal(date):
    """Get personal panel data for a single date"""
    out = run_cmd([
        'curl', '-s', '-b', DASH_COOKIE,
        'http://localhost:8081/api/postback/personal?startDate={}&endDate={}'.format(date, date)
    ], text_output=True)
    try:
        return json.loads(out)
    except:
        return None

def get_correction_factors(date):
    """Get correction factors for a date"""
    out = run_cmd([
        'curl', '-s', '-b', DASH_COOKIE,
        'http://localhost:8081/api/correction-factors?startDate={}&endDate={}'.format(date, date)
    ], text_output=True)
    try:
        return json.loads(out)
    except:
        return None

def get_correction_factor(factors, product, channel):
    """Get the correction factor for a product+channel"""
    f = factors.get(product)
    if f is None:
        return 1.0
    if isinstance(f, (int, float)):
        return float(f)
    # iOS: {fb, other}
    if channel in ('FB', 'FB W2A'):
        return float(f.get('fb', 1.0))
    return float(f.get('other', 1.0))

def main():
    print("=" * 60)
    print("投放日报核查脚本")
    print("=" * 60)
    
    # Step 1: Login to dashboard
    print("\n[1/5] 登录 Dashboard...")
    login_dashboard()
    
    # Step 2: Determine date range
    # Check which dates have snapshots (reliable data)
    # Also need correction factors — they were available from around 5/11
    # Let's check from 5/11 to 6/8
    start_date = "2026-05-11"
    end_date = "2026-06-08"
    
    # Generate date list
    dates = []
    d = datetime.strptime(start_date, '%Y-%m-%d')
    end_d = datetime.strptime(end_date, '%Y-%m-%d')
    while d <= end_d:
        dates.append(d.strftime('%Y-%m-%d'))
        d += timedelta(days=1)
    
    print(f"  核查日期范围: {start_date} ~ {end_date} ({len(dates)} 天)")
    
    # Step 3: Fetch dashboard data for all dates
    print("\n[2/5] 获取 Dashboard 数据...")
    dashboard_data = {}  # date -> {operator_code -> {product -> {channel -> {revenue, newUserRevenue, cost}}}}
    correction_data = {}  # date -> factors dict
    
    for i, date in enumerate(dates):
        if (i + 1) % 5 == 0 or i == 0:
            print(f"  获取 {date} ({i+1}/{len(dates)})...")
        
        personal = get_dashboard_personal(date)
        factors_resp = get_correction_factors(date)
        
        if personal and personal.get('operators'):
            day_data = {}
            for op in personal['operators']:
                code = op['operator']
                op_data = {}
                for prod in op.get('products', []):
                    product = prod['product']
                    for ch in prod.get('channels', []):
                        channel = ch['channel']
                        key = f"{product}|{channel}"
                        op_data[key] = {
                            'revenue': ch.get('revenue', 0),
                            'newUserRevenue': ch.get('newUserRevenue', 0),
                            'cost': ch.get('cost', 0),
                        }
                day_data[code] = op_data
            dashboard_data[date] = day_data
        
        if factors_resp and factors_resp.get('factors'):
            correction_data[date] = factors_resp['factors']
    
    print(f"  获取完成: {len(dashboard_data)} 天有数据, {len(correction_data)} 天有修正系数")
    
    # Step 4: Read Feishu sheets for each operator
    print("\n[3/5] 读取飞书日报表格...")
    feishu_data = {}  # operator_code -> {product|channel -> {date -> corrected_revenue}}
    
    for op_name, op_code, token in OPERATORS:
        print(f"\n  === {op_name} ({op_code}) ===")
        sheets = get_sheets(token)
        time.sleep(0.3)
        
        feishu_data[op_code] = {}
        
        for sheet in sheets:
            title = sheet.get('title', '')
            sheet_id = sheet.get('sheet_id', '')
            
            if should_skip_sheet(title):
                continue
            
            product, channel = parse_sheet_title(title)
            if not product or not channel:
                # Try harder — might need to infer from data
                print(f"    [SKIP] 无法解析: {title}")
                continue
            
            key = f"{product}|{channel}"
            print(f"    读取: {title} -> {product} {channel}")
            
            # Read header + data (up to 50 rows should cover ~1 month)
            rows = read_cells(token, sheet_id, 'A1:G50')
            time.sleep(0.3)
            
            if not rows:
                continue
            
            # Detect revenue column from header
            header = rows[0]
            rev_col = None  # Index of the column to use as "corrected/total revenue"
            
            # Strategy: find column with "修正收入" or "总收入" in header
            for ci, h in enumerate(header):
                h_str = str(h).strip()
                if h_str in ('修正收入', '总收入'):
                    rev_col = ci
                    break
            
            # If no "修正" or "总收入" found, check if F is "原始收入" — then revenue might be in F itself (no correction applied by this operator)
            if rev_col is None:
                for ci, h in enumerate(header):
                    h_str = str(h).strip()
                    if h_str == '原始收入':
                        rev_col = ci  # Use raw revenue as-is
                        print(f"      [NOTE] 只有原始收入列 (col {chr(65+ci)}), 没有修正列")
                        break
            
            if rev_col is None:
                print(f"      [SKIP] 无法找到收入列, header: {[str(h) for h in header[:8]]}")
                continue
            
            if key not in feishu_data[op_code]:
                feishu_data[op_code][key] = {}
            
            for row in rows[1:]:  # Skip header
                if len(row) <= rev_col:
                    continue
                date_str = parse_date(row[0])
                if not date_str:
                    continue
                rev_val = parse_money(row[rev_col])
                if rev_val is None:
                    continue
                feishu_data[op_code][key][date_str] = rev_val
    
    # Step 5: Compare
    print("\n[4/5] 对比数据...")
    issues_high = []  # (operator, product, channel, date, feishu_val, dash_val, diff, pct)
    issues_low = []
    total_checked = 0
    total_matched = 0
    total_mismatched = 0
    
    for op_name, op_code, _ in OPERATORS:
        op_feishu = feishu_data.get(op_code, {})
        
        for key, date_vals in op_feishu.items():
            product, channel = key.split('|')
            
            for date, feishu_rev in date_vals.items():
                if date not in dashboard_data:
                    continue
                if date not in correction_data:
                    continue
                
                total_checked += 1
                
                op_dash = dashboard_data[date].get(op_code, {})
                dash_entry = op_dash.get(key)
                
                if not dash_entry:
                    # Dashboard has no data for this operator+product+channel on this date
                    if feishu_rev > 10:
                        issues_high.append({
                            'operator': op_name,
                            'code': op_code,
                            'product': product,
                            'channel': channel,
                            'date': date,
                            'feishu': feishu_rev,
                            'dashboard': 0,
                            'diff': feishu_rev,
                            'pct': 100.0,
                            'note': 'Dashboard 无数据',
                        })
                        total_mismatched += 1
                    continue
                
                # Calculate dashboard corrected revenue
                factors = correction_data[date]
                factor = get_correction_factor(factors, product, channel)
                dash_revenue = dash_entry['revenue']
                dash_corrected = dash_revenue * factor
                
                # Compare
                diff = abs(feishu_rev - dash_corrected)
                pct = (diff / max(abs(feishu_rev), abs(dash_corrected), 1)) * 100
                
                if diff > 10 and pct > 10:
                    total_mismatched += 1
                    issues_high.append({
                        'operator': op_name,
                        'code': op_code,
                        'product': product,
                        'channel': channel,
                        'date': date,
                        'feishu': feishu_rev,
                        'dashboard': round(dash_corrected, 2),
                        'dash_raw': round(dash_revenue, 2),
                        'factor': round(factor, 4),
                        'diff': round(diff, 2),
                        'pct': round(pct, 1),
                        'note': '',
                    })
                else:
                    total_matched += 1
    
    # Step 5b: Restricted data analysis
    print("\n[4b/5] 分析 restricted 数据...")
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
    
    restricted_data = []
    try:
        db = sqlite3.connect(DB_PATH)
        for table in ['records_202605', 'records_202606']:
            try:
                rows = db.execute(f'''
                    SELECT app_id, media_source, campaign, COUNT(*) as cnt, SUM(revenue) as total_rev
                    FROM {table}
                    WHERE event_name = 'af_purchase'
                      AND (media_source IN ('restricted', 'Restricted')
                           OR campaign LIKE '%restricted%'
                           OR campaign LIKE '%unknown%'
                           OR campaign LIKE '%Unknown%')
                      AND date(event_time, '+8 hours') BETWEEN '2026-05-11' AND '2026-06-08'
                    GROUP BY app_id, media_source
                ''').fetchall()
                for r in rows:
                    app_id, ms, camp, cnt, rev = r
                    product = APP_ID_MAP.get(app_id, app_id)
                    restricted_data.append({
                        'product': product,
                        'media_source': ms,
                        'count': cnt,
                        'revenue': round(rev, 2),
                        'table': table,
                    })
            except Exception as e:
                print(f"  [WARN] {table}: {e}", file=sys.stderr)
        db.close()
    except Exception as e:
        print(f"  [WARN] DB error: {e}", file=sys.stderr)
    
    # Sort issues
    issues_high.sort(key=lambda x: -abs(x['diff']))
    
    # Output results
    print("\n" + "=" * 60)
    print(f"核查完成!")
    print(f"  总数据点: {total_checked}")
    print(f"  匹配 (diff < $10 或 < 10%): {total_matched}")
    print(f"  差异显著: {total_mismatched}")
    print(f"  高优问题: {len(issues_high)}")
    print(f"  restricted 记录: {len(restricted_data)}")
    
    # Save results to JSON for report generation
    report = {
        'summary': {
            'date_range': f'{start_date} ~ {end_date}',
            'total_dates': len(dates),
            'total_checked': total_checked,
            'total_matched': total_matched,
            'total_mismatched': total_mismatched,
        },
        'issues_high': issues_high,
        'restricted': restricted_data,
    }
    
    output_path = '/home/admin/.openclaw/workspace/scripts/audit-report.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    
    print(f"\n报告数据已保存到: {output_path}")
    
    # Print top issues for quick review
    if issues_high:
        print(f"\n{'='*80}")
        print(f"Top 20 差异项:")
        print(f"{'投手':6s} {'产品':12s} {'渠道':5s} {'日期':12s} {'飞书':>10s} {'Dashboard':>12s} {'差额':>10s} {'偏差%':>6s}")
        print("-" * 80)
        for issue in issues_high[:20]:
            print(f"{issue['operator']:6s} {issue['product']:12s} {issue['channel']:5s} {issue['date']:12s} "
                  f"${issue['feishu']:>9.2f} ${issue['dashboard']:>11.2f} ${issue['diff']:>9.2f} {issue['pct']:>5.1f}%")

if __name__ == '__main__':
    main()
