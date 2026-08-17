#!/usr/bin/env python3
"""
补充分析 1：日历因子深挖（逐日 + 每周 + 均值/中位数）
补充分析 2：正常加预算（>=15%）响应
基于现有 campaign_wide_table.csv + product_daily_summary.csv，区间 5.10~7.05。
"""
import csv, os, statistics, math, json
from datetime import datetime
from collections import defaultdict

AD = '/home/admin/.openclaw/workspace/analysis'
CAMP_START, CAMP_END = '2026-05-10', '2026-07-05'
DOW = ['周一','周二','周三','周四','周五','周六','周日']

def dow(d): return datetime.strptime(d,'%Y-%m-%d').weekday()
def is_we(d): return dow(d) >= 5
def iso_week(d):
    dt = datetime.strptime(d,'%Y-%m-%d'); y,w,_ = dt.isocalendar(); return f"{y}-W{w:02d}"
def med(x): return statistics.median(x) if x else None
def mean(x): return statistics.mean(x) if x else None

def welch(a,b):
    if len(a)<2 or len(b)<2: return None,None
    ma,mb=statistics.mean(a),statistics.mean(b)
    va,vb=statistics.variance(a),statistics.variance(b)
    na,nb=len(a),len(b)
    se=math.sqrt(va/na+vb/nb)
    if se==0: return 0,1.0
    t=(ma-mb)/se
    df=(va/na+vb/nb)**2/((va/na)**2/(na-1)+(vb/nb)**2/(nb-1))
    # two-tailed p via normal approx
    z=abs(t); p=math.exp(-0.5*z*z)*(0.4361836/(1+0.3326*z)-0.1201676/(1+0.3326*z)**2+0.9372980/(1+0.3326*z)**3)*2
    return t,min(p,1.0)

# ---------- Load ----------
def load_product_daily():
    """product-level daily: athena revenue + xmp cost, aggregated across products per day"""
    day = defaultdict(lambda: {'rev':0.0,'nrev':0.0,'cost':0.0})
    with open(os.path.join(AD,'product_daily_summary.csv')) as f:
        for r in csv.DictReader(f):
            d=r['date']
            day[d]['rev']+=float(r['athena_total_revenue'] or 0)
            day[d]['nrev']+=float(r['athena_new_user_revenue'] or 0)
            day[d]['cost']+=float(r['xmp_cost'] or 0)
    return day

def load_wide():
    rows=[]
    with open(os.path.join(AD,'campaign_wide_table.csv')) as f:
        for r in csv.DictReader(f):
            if not (CAMP_START<=r['date']<=CAMP_END): continue
            r['cost']=float(r['cost']); r['new_user_revenue']=float(r['new_user_revenue'])
            rows.append(r)
    return rows

out=[]
def w(s=''): out.append(s)

# ============================================================
# 分析 1：日历因子深挖
# ============================================================
w("="*70); w("补充分析 1：日历因子深挖（逐日 + 每周 + 均值/中位数）"); w("="*70)

pd = load_product_daily()
# restrict to campaign reliable range for consistency with campaign analysis, but also show full product range
days = sorted(d for d in pd if CAMP_START<=d<=CAMP_END and pd[d]['cost']>1000)

# 1.1 逐日明细表
w("\n### 1.1 逐日明细（5.10~7.05，产品级：雅典娜收入/XMP消耗）")
w(f"{'日期':<12}{'周几':<6}{'消耗$':>10}{'总收入$':>12}{'新用户收入$':>13}{'总ROAS':>9}{'新用户ROAS':>11}")
for d in days:
    a=pd[d]; troas=a['rev']/a['cost'] if a['cost'] else 0; nroas=a['nrev']/a['cost'] if a['cost'] else 0
    w(f"{d:<12}{DOW[dow(d)]:<6}{a['cost']:>10.0f}{a['rev']:>12.0f}{a['nrev']:>13.0f}{troas:>9.2f}{nroas:>11.3f}")

# 1.2 按星期几聚合（均值 + 中位数）
w("\n### 1.2 按星期几聚合（新用户 ROAS 为主）")
w(f"{'周几':<6}{'天数':>5}{'新ROAS均值':>11}{'新ROAS中位':>11}{'总ROAS均值':>11}{'总ROAS中位':>11}{'均消耗$':>10}")
byd=defaultdict(lambda:{'nroas':[],'troas':[],'cost':[]})
for d in days:
    a=pd[d]
    byd[dow(d)]['nroas'].append(a['nrev']/a['cost'] if a['cost'] else 0)
    byd[dow(d)]['troas'].append(a['rev']/a['cost'] if a['cost'] else 0)
    byd[dow(d)]['cost'].append(a['cost'])
for i in range(7):
    v=byd[i]
    w(f"{DOW[i]:<6}{len(v['nroas']):>5}{mean(v['nroas']):>11.3f}{med(v['nroas']):>11.3f}{mean(v['troas']):>11.2f}{med(v['troas']):>11.2f}{mean(v['cost']):>10.0f}")

# 1.3 周末 vs 周中（均值 + 中位数 + p）
w("\n### 1.3 周末 vs 周中汇总")
we_n=[pd[d]['nrev']/pd[d]['cost'] for d in days if is_we(d) and pd[d]['cost']]
wd_n=[pd[d]['nrev']/pd[d]['cost'] for d in days if not is_we(d) and pd[d]['cost']]
we_t=[pd[d]['rev']/pd[d]['cost'] for d in days if is_we(d) and pd[d]['cost']]
wd_t=[pd[d]['rev']/pd[d]['cost'] for d in days if not is_we(d) and pd[d]['cost']]
_,pn=welch(we_n,wd_n); _,pt=welch(we_t,wd_t)
w(f"新用户ROAS  周末: 均值={mean(we_n):.3f} 中位={med(we_n):.3f} (n={len(we_n)}) | 周中: 均值={mean(wd_n):.3f} 中位={med(wd_n):.3f} (n={len(wd_n)})")
w(f"           均值Δ={(mean(we_n)-mean(wd_n))/mean(wd_n)*100:+.1f}%  中位Δ={(med(we_n)-med(wd_n))/med(wd_n)*100:+.1f}%  p={pn:.3f}")
w(f"总ROAS      周末: 均值={mean(we_t):.3f} 中位={med(we_t):.3f} | 周中: 均值={mean(wd_t):.3f} 中位={med(wd_t):.3f}")
w(f"           均值Δ={(mean(we_t)-mean(wd_t))/mean(wd_t)*100:+.1f}%  中位Δ={(med(we_t)-med(wd_t))/med(wd_t)*100:+.1f}%  p={pt:.3f}")

# 1.4 每周对照（周末均值 vs 该周周中均值，看方向一致性）
w("\n### 1.4 每周周末 vs 周中对照（新用户ROAS，看方向是否一致）")
w(f"{'周':<10}{'周末均值':>10}{'周中均值':>10}{'周末优势':>10}{'方向':>6}")
byw=defaultdict(lambda:{'we':[],'wd':[]})
for d in days:
    if pd[d]['cost']:
        nr=pd[d]['nrev']/pd[d]['cost']
        (byw[iso_week(d)]['we'] if is_we(d) else byw[iso_week(d)]['wd']).append(nr)
we_wins=0; total_w=0
for wk in sorted(byw):
    v=byw[wk]
    if v['we'] and v['wd']:
        mwe,mwd=mean(v['we']),mean(v['wd']); adv=(mwe-mwd)/mwd*100
        total_w+=1; 
        if mwe>mwd: we_wins+=1
        w(f"{wk:<10}{mwe:>10.3f}{mwd:>10.3f}{adv:>9.1f}%{'  周末↑' if mwe>mwd else '  周中↑':>6}")
w(f"\n方向一致性：{we_wins}/{total_w} 周周末新用户ROAS高于周中")

# 1.5 campaign 级平台分解（周末 vs 周中，均值+中位数）
w("\n### 1.5 Campaign 级：各平台周末 vs 周中新用户ROAS（均值/中位数）")
wide=load_wide()
w(f"{'平台':<6}{'周末均值':>9}{'周末中位':>9}{'周中均值':>9}{'周中中位':>9}{'均值Δ':>8}{'p':>7}")
for plat in ['FB','GG','TT']:
    dayagg=defaultdict(lambda:{'cost':0.0,'nrev':0.0})
    for r in wide:
        if r['platform']==plat:
            dayagg[r['date']]['cost']+=r['cost']; dayagg[r['date']]['nrev']+=r['new_user_revenue']
    we=[v['nrev']/v['cost'] for d,v in dayagg.items() if is_we(d) and v['cost']>500]
    wd=[v['nrev']/v['cost'] for d,v in dayagg.items() if not is_we(d) and v['cost']>500]
    if we and wd:
        _,p=welch(we,wd); dpct=(mean(we)-mean(wd))/mean(wd)*100
        w(f"{plat:<6}{mean(we):>9.3f}{med(we):>9.3f}{mean(wd):>9.3f}{med(wd):>9.3f}{dpct:>7.1f}%{p:>7.3f}")

# ============================================================
# 分析 2：正常加预算（>=15%）响应
# ============================================================
w("\n"+"="*70); w("补充分析 2：正常加预算响应（幅度 ≥15% / 对比 30%）"); w("="*70)

# build per-campaign daily time series
ts=defaultdict(dict)
for r in wide:
    key=(r['platform'],r['product'],r['campaign'])
    if r['cost']>0:
        ts[key][r['date']]={'cost':r['cost'],'roas':(r['new_user_revenue']/r['cost'] if r['cost'] else 0),'nrev':r['new_user_revenue']}
active={k:v for k,v in ts.items() if len(v)>=5}
w(f"\n有效 campaign（≥5天有消耗）：{len(active)}")

for plat in ['FB','GG','TT']:
    w(f"\n  {plat}:")
    for thr in [0.15, 0.30]:
        before,day_,after3=[],[],[]
        for key,series in active.items():
            if key[0]!=plat: continue
            ds=sorted(series.keys())
            for i in range(1,len(ds)):
                d1=datetime.strptime(ds[i-1],'%Y-%m-%d'); d2=datetime.strptime(ds[i],'%Y-%m-%d')
                if (d2-d1).days!=1: continue
                c1,c2=series[ds[i-1]]['cost'],series[ds[i]]['cost']
                if c1<20: continue
                chg=(c2-c1)/c1
                if chg<thr: continue
                rb=series[ds[i-1]]['roas']; rs=series[ds[i]]['roas']
                if rb>0:
                    before.append(rb); day_.append(rs)
                    fut=[]
                    for j in range(i,min(i+3,len(ds))):
                        dj=datetime.strptime(ds[j],'%Y-%m-%d')
                        if (dj-d2).days<=2: fut.append(series[ds[j]]['roas'])
                    if fut: after3.append(mean(fut))
        if len(before)>=5:
            ab,asd=mean(before),mean(day_); a3=mean(after3) if after3 else None
            ds_pct=(asd-ab)/ab*100; d3_pct=(a3-ab)/ab*100 if a3 else None
            a3_s = f"{a3:.2f}" if a3 else "N/A"
            d3_s = f"({d3_pct:+.0f}%)" if d3_pct is not None else "(N/A)"
            w(f"    ≥{thr:.0%}加量(n={len(before):3d}): 前={ab:.2f} 当天={asd:.2f}({ds_pct:+.0f}%) 3日后={a3_s}{d3_s}")

# 2.2 细分区间：15-30% vs 30%+ 对比
w("\n### 2.2 加量幅度分档对比（15~30% 正常加量 vs ≥30% 大幅加量）")
for plat in ['FB','GG','TT']:
    buckets={'15~30%':(0.15,0.30),'≥30%':(0.30,999)}
    line=f"  {plat}: "
    parts=[]
    for name,(lo,hi) in buckets.items():
        before,after3=[],[]
        for key,series in active.items():
            if key[0]!=plat: continue
            ds=sorted(series.keys())
            for i in range(1,len(ds)):
                d1=datetime.strptime(ds[i-1],'%Y-%m-%d'); d2=datetime.strptime(ds[i],'%Y-%m-%d')
                if (d2-d1).days!=1: continue
                c1,c2=series[ds[i-1]]['cost'],series[ds[i]]['cost']
                if c1<20: continue
                chg=(c2-c1)/c1
                if not (lo<=chg<hi): continue
                rb=series[ds[i-1]]['roas']
                if rb>0:
                    fut=[]
                    for j in range(i,min(i+3,len(ds))):
                        dj=datetime.strptime(ds[j],'%Y-%m-%d')
                        if (dj-d2).days<=2: fut.append(series[ds[j]]['roas'])
                    if fut: before.append(rb); after3.append(mean(fut))
        if len(before)>=5:
            d3=(mean(after3)-mean(before))/mean(before)*100
            parts.append(f"{name}(n={len(before)}) 3日后{d3:+.0f}%")
        else:
            parts.append(f"{name}(n={len(before)}) 样本不足")
    w(line+" | ".join(parts))

report='\n'.join(out)
open(os.path.join(AD,'supplementary_analysis.txt'),'w').write(report)
print(report)
