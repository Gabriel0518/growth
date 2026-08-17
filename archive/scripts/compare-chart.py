#!/usr/bin/env python3
"""
生成飞书表格 vs Dashboard 数据对比折线图
- 绝对差异随日期变化
- 相对差异随日期变化
"""

import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime

# Load data
with open('/home/admin/.openclaw/workspace/scripts/compare-result.json') as f:
    data = json.load(f)

dates = [datetime.strptime(d, '%Y-%m-%d') for d in data['dates']]
daily = data['dailyAgg']

# Extract metrics
cost_abs = [daily[d.strftime('%Y-%m-%d')]['cost']['absDiff'] for d in dates]
rev_abs = [daily[d.strftime('%Y-%m-%d')]['originalRevenue']['absDiff'] for d in dates]
corr_abs = [daily[d.strftime('%Y-%m-%d')]['correctedRevenue']['absDiff'] for d in dates]

cost_rel = []
rev_rel = []
corr_rel = []
for d in dates:
    ds = d.strftime('%Y-%m-%d')
    c = daily[ds]['cost']
    r = daily[ds]['originalRevenue']
    cr = daily[ds]['correctedRevenue']
    cost_rel.append(c['absDiff'] / abs(c['dashTotal']) * 100 if c['dashTotal'] != 0 else 0)
    rev_rel.append(r['absDiff'] / abs(r['dashTotal']) * 100 if r['dashTotal'] != 0 else 0)
    corr_rel.append(cr['absDiff'] / abs(cr['dashTotal']) * 100 if cr['dashTotal'] != 0 else 0)

# Set style
plt.rcParams['font.family'] = ['WenQuanYi Micro Hei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False
plt.rcParams['figure.dpi'] = 150

fig, axes = plt.subplots(2, 1, figsize=(14, 10), gridspec_kw={'hspace': 0.35})

# --- Plot 1: Absolute differences ---
ax1 = axes[0]
ax1.plot(dates, cost_abs, 'o-', color='#2196F3', linewidth=2, markersize=5, label='消耗绝对差')
ax1.plot(dates, rev_abs, 's-', color='#FF9800', linewidth=2, markersize=5, label='原始收入绝对差')
ax1.plot(dates, corr_abs, '^-', color='#4CAF50', linewidth=2, markersize=5, label='修正收入绝对差')
ax1.axhline(y=0, color='gray', linewidth=0.8, linestyle='--')
ax1.set_title('飞书表格 vs Dashboard — 全产品渠道汇总绝对差异', fontsize=14, fontweight='bold')
ax1.set_ylabel('绝对差异 ($)', fontsize=12)
ax1.legend(fontsize=10, loc='upper left')
ax1.grid(True, alpha=0.3)
ax1.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
ax1.xaxis.set_major_locator(mdates.DayLocator())
plt.setp(ax1.xaxis.get_majorticklabels(), rotation=45, ha='right')

# Add value labels for abs diff
for i, d in enumerate(dates):
    ax1.annotate(f'${cost_abs[i]:+.0f}', (d, cost_abs[i]), 
                 textcoords='offset points', xytext=(0, -15), fontsize=7, color='#2196F3', ha='center')
    if i % 2 == 0:  # Only label every other point to avoid clutter
        ax1.annotate(f'${rev_abs[i]:+.0f}', (d, rev_abs[i]),
                     textcoords='offset points', xytext=(0, 10), fontsize=7, color='#FF9800', ha='center')

# --- Plot 2: Relative differences ---
ax2 = axes[1]
ax2.plot(dates, cost_rel, 'o-', color='#2196F3', linewidth=2, markersize=5, label='消耗相对差')
ax2.plot(dates, rev_rel, 's-', color='#FF9800', linewidth=2, markersize=5, label='原始收入相对差')
ax2.plot(dates, corr_rel, '^-', color='#4CAF50', linewidth=2, markersize=5, label='修正收入相对差')
ax2.axhline(y=0, color='gray', linewidth=0.8, linestyle='--')
ax2.set_title('飞书表格 vs Dashboard — 全产品渠道汇总相对差异', fontsize=14, fontweight='bold')
ax2.set_ylabel('相对差异 (%)', fontsize=12)
ax2.set_xlabel('日期', fontsize=12)
ax2.legend(fontsize=10, loc='upper left')
ax2.grid(True, alpha=0.3)
ax2.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
ax2.xaxis.set_major_locator(mdates.DayLocator())
plt.setp(ax2.xaxis.get_majorticklabels(), rotation=45, ha='right')

# Add value labels for rel diff
for i, d in enumerate(dates):
    ax2.annotate(f'{cost_rel[i]:+.2f}%', (d, cost_rel[i]),
                 textcoords='offset points', xytext=(0, -15), fontsize=7, color='#2196F3', ha='center')
    if i % 2 == 0:
        ax2.annotate(f'{rev_rel[i]:+.2f}%', (d, rev_rel[i]),
                     textcoords='offset points', xytext=(0, 10), fontsize=7, color='#FF9800', ha='center')

# Save
out_path = '/home/admin/.openclaw/workspace/scripts/compare-chart.png'
plt.tight_layout()
plt.savefig(out_path, dpi=150, bbox_inches='tight')
print(f'Chart saved: {out_path}')

# Also generate a per-metric breakdown chart
fig2, axes2 = plt.subplots(3, 1, figsize=(14, 14), gridspec_kw={'hspace': 0.4})

metrics = [
    ('cost', '消耗', '#2196F3', cost_abs, cost_rel),
    ('originalRevenue', '原始收入', '#FF9800', rev_abs, rev_rel),
    ('correctedRevenue', '修正收入', '#4CAF50', corr_abs, corr_rel),
]

for idx, (key, name, color, abs_vals, rel_vals) in enumerate(metrics):
    ax = axes2[idx]
    
    # Twin axes: left=abs, right=rel
    ax_r = ax.twinx()
    
    line1 = ax.plot(dates, abs_vals, 'o-', color=color, linewidth=2, markersize=5, label=f'{name}绝对差 ($)')
    line2 = ax_r.plot(dates, rel_vals, 's--', color=color, linewidth=1.5, markersize=4, alpha=0.6, label=f'{name}相对差 (%)')
    
    ax.axhline(y=0, color='gray', linewidth=0.8, linestyle='--')
    ax.set_title(f'{name}差异趋势', fontsize=13, fontweight='bold')
    ax.set_ylabel('绝对差异 ($)', fontsize=11, color=color)
    ax_r.set_ylabel('相对差异 (%)', fontsize=11, color=color, alpha=0.6)
    
    lines = line1 + line2
    labels = [l.get_label() for l in lines]
    ax.legend(lines, labels, fontsize=9, loc='upper left')
    ax.grid(True, alpha=0.3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    ax.xaxis.set_major_locator(mdates.DayLocator())
    plt.setp(ax.xaxis.get_majorticklabels(), rotation=45, ha='right')
    
    if idx == 2:
        ax.set_xlabel('日期', fontsize=12)

out_path2 = '/home/admin/.openclaw/workspace/scripts/compare-chart-detail.png'
plt.tight_layout()
plt.savefig(out_path2, dpi=150, bbox_inches='tight')
print(f'Detail chart saved: {out_path2}')
