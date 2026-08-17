#!/usr/bin/env python3
"""
Audit v3: Compare Feishu daily report raw revenue (F col) vs AF/AD SQLite raw revenue.
No correction factors needed — we compare raw-to-raw.
If a sheet only has corrected revenue (G col), we note it and skip raw comparison for that sheet,
but still report the ratio vs AF raw for sanity check.
"""
import json, subprocess, re, time, sys, sqlite3, os
from collections import defaultdict
from datetime import datetime, timedelta

LARK_CLI = "/home/admin/.npm-global/bin/lark-cli"
DB_PATH = "/home/admin/dataserver/data.db"

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
    'id1658972379': 'GraceChat', 'id6759697686': 'Kira iOS',
    'com.doramatch.app': 'Dora And', 'com.qiga.vio': 'Jovia And',
    'com.doni.appa': 'Doni', 'com.romiandroid.appmatch': 'Romi And',
    'com.meraki.kira': 'Kira And', 'com.cavalier.nalo': 'Nalo And',
}

MEDIA_SOURCE_MAP = {
    'Facebook Ads': 'FB', 'Facebook+Installs': 'FB', 'Facebook Installs': 'FB',
    'Instagram+Installs': 'FB', 'Instagram Installs': 'FB',
    'Off-Facebook+Installs': 'FB', 'Social_facebook': 'FB', 'facebook': 'FB',
    'Facebook+web': 'FB W2A', 'Facebook web': 'FB W2A',
    'googleadwords_int': 'GG', 'Google Ads ACI': 'GG', 'Google+Ads+ACI': 'GG',
    'tiktokglobal_int': 'TT', 'TikTok+SAN': 'TT', 'TikTok SAN': 'TT',
}
AD_ORGANIC = {'Organic', 'Unattributed', 'organic', 'restricted', 'Untrusted Devices'}

def match_operator(campaign):
    if not campaign: return None
    lower = campaign.lower()
    for code in OPERATOR_CODES:
        if code in lower: return code
    if 'liuh' in lower: return 'lh'
    if 'zm' in lower and 'zmf' not in lower: return 'zm1'
    if 'Oc' in campaign: return 'cyl'
    return None

def normalize_product(name):
    low = name.strip().lower()
    if 'gc' in low or 'gracechat' in low: return 'GraceChat'
    if 'dora' in low and 'and' in low: return 'Dora And'
    if 'dora' in low and 'ios' in low: return 'Dora iOS'
    if 'doni' in low: return 'Doni'
    if 'romi' in low and 'and' in low: return 'Romi And'
    if 'romi' in low and 'ios' in low: return 'Romi iOS'
    if 'luma' in low: return 'Luma'
    if 'jovia' in low: return 'Jovia And'
    if 'kira' in low and 'and' in low: return 'Kira And'
    if 'kira' in low and 'ios' in low: return 'Kira iOS'
    if 'nalo' in low: return 'Nalo And'
    return None

def should_skip(title):
    for w in ['汇总', '测新', 'PWA', '赠款', 'Unity', 'Elara', '下架', '主播', 'W2A', 'w2a', 'YSN']:
        if w in title: return True
    return False

def parse_sheet_title(title):
    for name, _, _ in OPERATORS:
        title = title.replace(name, '').strip()
    m = re.match(r'^(.+?)\s*[-]?\s*(FB|TT|GG|fb|tt|gg)\s*$', title)
    if m:
        product = normalize_product(m.group(1))
        ch = m.group(2).upper()
        return product, ch
    for ch in ['FB', 'TT', 'GG']:
        if ch in title.upper():
            product_part = re.sub(r'\s*[-]?\s*' + ch, '', title, flags=re.IGNORECASE).strip()
            product = normalize_product(product_part)
            if product: return product, ch
    return None, None

def parse_money(val):
    if not val: return None
    val = str(val).strip()
    if val in ('', '#DIV/0!', '#N/A', '#REF!', '-', 'N/A'): return None
    neg = val.startswith('-') or val.startswith('($') or val.startswith('-$')
    val = val.replace('$','').replace(',','').replace(' ','').replace('(','').replace(')','')
    if val.startswith('-'): val = val[1:]; neg = True
    try: v = float(val); return -v if neg else v
    except: return None

def parse_date(val):
    if not val: return None
    val = str(val).strip()
    for fmt in ['%Y/%m/%d', '%Y-%m-%d']:
        try: return datetime.strptime(val, fmt).strftime('%Y-%m-%d')
        except: pass
    try:
        s = float(val)
        if 40000 < s < 50000:
            return (datetime(1899,12,30) + timedelta(days=s)).strftime('%Y-%m-%d')
    except: pass
    return None

def run_lark(*args):
    cmd = [LARK_CLI] + list(args) + ['--as','user','--format','json']
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, _ = p.communicate(timeout=30)
        return json.loads(out.decode('utf-8','replace'))
    except: return None

def main():
    P = lambda s: (sys.stdout.write(s + '\n'), sys.stdout.flush())
    P("=" * 60)
    P("投放日报核查脚本 v3")
    P("=" * 60)

    start, end = "2026-05-20", "2026-06-08"  # Narrower range to be practical
    dates = []
    d = datetime.strptime(start, '%Y-%m-%d')
    while d <= datetime.strptime(end, '%Y-%m-%d'):
        dates.append(d.strftime('%Y-%m-%d'))
        d += timedelta(days=1)
    P("  范围: {} ~ {} ({} 天)".format(start, end, len(dates)))

    # Step 1: Build AF/AD revenue from SQLite (fast, <10s)
    P("\n[1/3] 从 SQLite 构建 AF/AD 收入...")
    db = sqlite3.connect(DB_PATH)
    # revenue[date][operator][product|channel] = total event_time revenue
    revenue = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    
    for table in ['records_202605', 'records_202606']:
        try:
            rows = db.execute("""
                SELECT date(event_time, '+8 hours') as d, campaign, app_id, media_source, SUM(revenue)
                FROM {} WHERE event_name = 'af_purchase'
                AND date(event_time, '+8 hours') BETWEEN ? AND ?
                AND media_source NOT IN ('organic','Organic','restricted','Restricted','Unattributed','Untrusted Devices')
                GROUP BY d, campaign, app_id, media_source
            """.format(table), (start, end)).fetchall()
            for d, camp, app_id, ms, rev in rows:
                if not camp or not app_id or not ms: continue
                op = match_operator(camp.strip()) or 'other'
                product = APP_ID_MAP.get(app_id)
                channel = MEDIA_SOURCE_MAP.get(ms)
                if not product or not channel: continue
                revenue[d][op]["{}|{}".format(product, channel)] += (rev or 0)
            P("  {}: {} AF groups".format(table, len(rows)))
        except Exception as e: P("  [WARN] {}: {}".format(table, e))
    
    # AD data
    for table in ['records_202605', 'records_202606']:
        try:
            rows = db.execute("""
                SELECT date(event_time, '+8 hours') as d, campaign, app_id, media_source, SUM(revenue)
                FROM {} WHERE event_name = 'ad_purchase'
                AND date(event_time, '+8 hours') BETWEEN ? AND ?
                GROUP BY d, campaign, app_id, media_source
            """.format(table), (start, end)).fetchall()
            ad_ct = 0
            for d, camp, app_id, ms, rev in rows:
                if ms in AD_ORGANIC:
                    if ms == 'Unattributed': channel = 'FB'
                    else: continue
                else:
                    channel = MEDIA_SOURCE_MAP.get(ms)
                    if not channel: continue
                if camp:
                    try:
                        import urllib.parse
                        camp = urllib.parse.unquote(camp.replace('+', ' '))
                    except: pass
                    camp = re.sub(r'\s*\(.*?\)\s*$', '', camp).strip()
                op = match_operator(camp) or 'other'
                product = APP_ID_MAP.get(app_id) or APP_ID_MAP.get('id' + str(app_id) if app_id else '')
                if not product: continue
                revenue[d][op]["{}|{}".format(product, channel)] += (rev or 0)
                ad_ct += 1
            P("  {}: {} AD groups".format(table, ad_ct))
        except Exception as e: P("  [WARN] AD {}: {}".format(table, e))

    # Restricted analysis
    P("\n  分析 restricted...")
    restricted = defaultdict(lambda: {'count': 0, 'revenue': 0.0})
    for table in ['records_202605', 'records_202606']:
        try:
            rows = db.execute("""
                SELECT app_id, COUNT(*), SUM(revenue)
                FROM {} WHERE event_name = 'af_purchase'
                AND (media_source IN ('restricted','Restricted') OR LOWER(campaign) LIKE '%%restricted%%' OR LOWER(campaign) LIKE '%%unknown%%')
                AND date(event_time, '+8 hours') BETWEEN ? AND ?
                GROUP BY app_id
            """.format(table), (start, end)).fetchall()
            for app_id, cnt, rev in rows:
                product = APP_ID_MAP.get(app_id, app_id)
                restricted[product]['count'] += cnt
                restricted[product]['revenue'] += (rev or 0)
        except: pass
    db.close()
    P("  {} 天有 AF/AD 数据".format(len(revenue)))

    # Step 2: Read Feishu sheets
    P("\n[2/3] 读取飞书日报表格...")
    feishu = {}  # op_code -> {product|channel -> {date -> {raw, corrected, col_used}}}
    
    for op_name, op_code, token in OPERATORS:
        P("\n  === {} ({}) ===".format(op_name, op_code))
        sheets_resp = run_lark('api', 'GET', '/open-apis/sheets/v3/spreadsheets/{}/sheets/query'.format(token))
        time.sleep(0.5)
        if not sheets_resp: P("    [ERROR] sheet列表获取失败"); continue
        feishu[op_code] = {}
        
        for sheet in sheets_resp.get('data', {}).get('sheets', []):
            title = sheet.get('title', '')
            sid = sheet.get('sheet_id', '')
            if should_skip(title): continue
            product, channel = parse_sheet_title(title)
            if not product or not channel:
                P("    [SKIP] {}".format(title)); continue
            key = "{}|{}".format(product, channel)
            
            data = run_lark('sheets', '+cells-get', '--spreadsheet-token', token, '--sheet-id', sid, '--range', 'A1:G50')
            time.sleep(0.5)
            if not data or not data.get('ok'): continue
            
            rows = []
            for rng in data.get('data', {}).get('ranges', []):
                for row in rng.get('cells', []):
                    rows.append([c.get('value', '') if isinstance(c, dict) else '' for c in row])
            if len(rows) < 2: continue
            
            hdr = [str(h).strip() for h in rows[0]]
            # Find columns: raw=原始收入, corrected=修正收入 or 总收入
            raw_col = corrected_col = None
            for i, h in enumerate(hdr):
                if h == '原始收入': raw_col = i
                elif h in ('修正收入', '总收入'): corrected_col = i
            
            # Decide which column to use for comparison
            use_col = None
            use_type = None
            if raw_col is not None:
                use_col = raw_col
                use_type = 'raw'
            elif corrected_col is not None:
                use_col = corrected_col
                use_type = 'corrected'
            else:
                P("    [SKIP] {} - 无收入列: {}".format(title, hdr[:8])); continue
            
            P("    {} -> {} {} ({}=col{})".format(title, product, channel, use_type, chr(65+use_col)))
            if key not in feishu[op_code]: feishu[op_code][key] = {}
            
            for row in rows[1:]:
                if len(row) <= use_col: continue
                date_str = parse_date(row[0])
                if not date_str or date_str < start or date_str > end: continue
                val = parse_money(row[use_col])
                if val is None: continue
                # Also try to get both columns if available
                raw_val = parse_money(row[raw_col]) if raw_col is not None and len(row) > raw_col else None
                corr_val = parse_money(row[corrected_col]) if corrected_col is not None and len(row) > corrected_col else None
                feishu[op_code][key][date_str] = {
                    'raw': raw_val,
                    'corrected': corr_val,
                    'used': val,
                    'col_type': use_type,
                }

    # Step 3: Compare
    P("\n[3/3] 对比...")
    issues = []
    total = matched = 0
    
    for op_name, op_code, _ in OPERATORS:
        for key, dv in feishu.get(op_code, {}).items():
            product, channel = key.split('|')
            for date, info in dv.items():
                af_raw = revenue.get(date, {}).get(op_code, {}).get(key, 0)
                total += 1
                
                feishu_raw = info.get('raw')
                feishu_corr = info.get('corrected')
                col_type = info['col_type']
                
                # Compare strategy:
                # If feishu has raw, compare raw vs AF raw
                # If feishu only has corrected/total, note ratio vs AF raw
                if feishu_raw is not None:
                    diff = feishu_raw - af_raw
                    abs_diff = abs(diff)
                    base = max(abs(feishu_raw), abs(af_raw), 1)
                    pct = abs_diff / base * 100
                    if abs_diff > 10 and pct > 10:
                        issues.append({
                            'op': op_name, 'code': op_code,
                            'product': product, 'channel': channel, 'date': date,
                            'feishu_raw': round(feishu_raw, 2),
                            'feishu_corr': round(feishu_corr, 2) if feishu_corr else None,
                            'af_raw': round(af_raw, 2),
                            'diff': round(diff, 2), 'pct': round(pct, 1),
                            'type': 'raw_vs_raw',
                        })
                    else: matched += 1
                elif feishu_corr is not None:
                    # Only corrected available — compare corrected vs AF raw (expect ratio ~ correction factor)
                    if af_raw > 0:
                        ratio = feishu_corr / af_raw
                        # Expected ratio is usually 0.9 ~ 3.0 (correction factors range)
                        # Flag if ratio < 0.5 or > 5.0 (very suspicious)
                        if ratio < 0.5 or ratio > 5.0:
                            issues.append({
                                'op': op_name, 'code': op_code,
                                'product': product, 'channel': channel, 'date': date,
                                'feishu_raw': None,
                                'feishu_corr': round(feishu_corr, 2),
                                'af_raw': round(af_raw, 2),
                                'diff': round(feishu_corr - af_raw, 2),
                                'pct': round(abs(feishu_corr - af_raw) / max(feishu_corr, af_raw, 1) * 100, 1),
                                'type': 'ratio_suspicious (x{:.2f})'.format(ratio),
                            })
                        else: matched += 1
                    elif feishu_corr > 50:
                        issues.append({
                            'op': op_name, 'code': op_code,
                            'product': product, 'channel': channel, 'date': date,
                            'feishu_raw': None, 'feishu_corr': round(feishu_corr, 2),
                            'af_raw': 0, 'diff': round(feishu_corr, 2),
                            'pct': 100.0, 'type': 'AF无数据',
                        })
                    else: matched += 1
    
    issues.sort(key=lambda x: -abs(x['diff']))
    
    # Group by operator
    by_op = defaultdict(list)
    for i in issues: by_op[i['op']].append(i)
    
    P("\n" + "=" * 80)
    P("核查完成!")
    P("  数据点: {}  匹配: {}  差异: {}".format(total, matched, len(issues)))
    
    if by_op:
        P("\n  按投手统计:")
        for name in sorted(by_op):
            iss = by_op[name]
            P("    {}: {} 条, 总偏差 ${:.0f}".format(name, len(iss), sum(abs(i['diff']) for i in iss)))
    
    if issues:
        P("\n  Top 30:")
        P("  {:<6s} {:<10s} {:<4s} {:<12s} {:>10s} {:>10s} {:>10s} {:>6s} {}".format(
            '投手','产品','渠道','日期','飞书原始','AF原始','差额','偏差%','类型'))
        P("  " + "-" * 90)
        for i in issues[:30]:
            fr = '${:.2f}'.format(i['feishu_raw']) if i['feishu_raw'] is not None else '(修正${:.0f})'.format(i['feishu_corr'] or 0)
            P("  {:<6s} {:<10s} {:<4s} {:<12s} {:>10s} ${:>9.2f} ${:>9.2f} {:>5.1f}% {}".format(
                i['op'], i['product'], i['channel'], i['date'], fr, i['af_raw'], i['diff'], i['pct'], i['type']))
    
    if restricted:
        P("\n  Restricted 收入:")
        for p in sorted(restricted, key=lambda x: -restricted[x]['revenue']):
            d = restricted[p]
            P("    {:<12s} {} 笔 ${:.2f}".format(p, d['count'], d['revenue']))
    
    # Save JSON
    report = {
        'summary': {'range': '{} ~ {}'.format(start, end), 'total': total, 'matched': matched, 'issues': len(issues)},
        'issues': issues,
        'restricted': {k: v for k, v in restricted.items()},
    }
    with open('/home/admin/.openclaw/workspace/scripts/audit-report.json', 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    P("\n保存到 scripts/audit-report.json")

if __name__ == '__main__':
    main()
