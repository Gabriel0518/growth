#!/usr/bin/env python3
"""
飞书表格 vs Dashboard 数据对比折线图（重跑版）
着重展示绝对值差异，相对差异作为辅助参考
"""

import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime

with open('/home/admin/.openclaw/workspace/scripts/compare-result.json') as f:
    data = json.load(f)

dates = [datetime.strptime(d, '%Y-%m-%d') for d in data['dates']]
daily = data['dailyAgg']

cost_abs = [daily[d.strftime('%Y-%m-%d')]['cost']['absDiff'] for d in dates]
rev_abs = [daily[d.strftime('%Y-%m-%d')]['originalRevenue']['absDiff'] for d in dates]
corr_abs = [daily[d.strftime('%Y-%m-%d')]['correctedRevenue']['absDiff'] for d in dates]

cost_dash = [daily[d.strftime('%Y-%m-%d')]['cost']['dashTotal'] for d in dates]
rev_dash = [daily[d.strftime('%Y-%m-%d')]['originalRevenue']['dashTotal'] for d in dates]
corr_dash = [daily[d.strftime('%Y-%m-%d')]['correctedRevenue']['dashTotal'] for d in dates]

cost_rel = [c / abs(d) * 100 if d != 0 else 0 for c, d in zip(cost_abs, cost_dash)]
rev_rel = [r / abs(d) * 100 if d != 0 else 0 for r, d in zip(rev_abs, rev_dash)]
corr_rel = [cr / abs(d) * 100 if d != 0 else 0 for cr, d in zip(corr_abs, corr_dash)]

plt.rcParams['font.family'] = ['WenQuanYi Micro Hei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

# ============ Chart 1: 绝对差异总览 ============
fig1, ax1 = plt.subplots(figsize=(14, 7))

ax1.bar(dates, cost_abs, width=0.8, color='#2196F3', alpha=0.7, label='消耗绝对差')
ax1.bar(dates, rev_abs, width=0.5, color='#FF9800', alpha=0.7, label='原始收入绝对差')
ax1.bar(dates, corr_abs, width=0.3, color='#4CAF50', alpha=0.7, label='修正收入绝对差')
ax1.axhline(y=0, color='gray', linewidth=0.8, linestyle='--')

# Value labels
for i, d in enumerate(dates):
    if abs(cost_abs[i]) > 10:
        ax1.annotate(f'${cost_abs[i]:+.0f}', (d, cost_abs[i]),
                     textcoords='offset points', xytext=(0, -18 if cost_abs[i] > 0 else 8),
                     fontsize=7, color='#1565C0', ha='center', fontweight='bold')
    if abs(rev_abs[i]) > 10:
        ax1.annotate(f'${rev_abs[i]:+.0f}', (d, rev_abs[i]),
                     textcoords='offset points', xytext=(0, 10 if rev_abs[i] > 0 else -18),
                     fontsize=7, color='#E65100', ha='center', fontweight='bold')

ax1.set_title('飞书表格 vs Dashboard — 全产品渠道汇总 绝对差异', fontsize=14, fontweight='bold')
ax1.set_ylabel('绝对差异 ($)', fontsize=12)
ax1.legend(fontsize=10, loc='upper left')
ax1.grid(True, alpha=0.3, axis='y')
ax1.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
ax1.xaxis.set_major_locator(mdates.DayLocator())
plt.setp(ax1.xaxis.get_majorticklabels(), rotation=45, ha='right')
fig1.tight_layout()
fig1.savefig('/home/admin/.openclaw/workspace/scripts/compare-chart-v2-abs.png', dpi=150, bbox_inches='tight')
print('Chart 1 saved: compare-chart-v2-abs.png')

# ============ Chart 2: 三指标双轴（绝对+相对） ============
fig2, axes2 = plt.subplots(3, 1, figsize=(14, 13), gridspec_kw={'hspace': 0.4})

metrics = [
    ('消耗', '#2196F3', cost_abs, cost_rel, cost_dash),
    ('原始收入', '#FF9800', rev_abs, rev_rel, rev_dash),
    ('修正收入', '#4CAF50', corr_abs, corr_rel, corr_dash),
]

for idx, (name, color, abs_v, rel_v, dash_v) in enumerate(metrics):
    ax = axes2[idx]
    ax_r = ax.twinx()

    # Bar for absolute diff
    bars = ax.bar(dates, abs_v, width=0.6, color=color, alpha=0.6, label=f'{name}绝对差 ($)')
    # Line for relative diff
    line = ax_r.plot(dates, rel_v, 'o-', color='#D32F2F', linewidth=2, markersize=5, label=f'{name}相对差 (%)')

    ax.axhline(y=0, color='gray', linewidth=0.8, linestyle='--')
    ax.set_title(f'{name}差异趋势（柱=绝对差，线=相对差）', fontsize=13, fontweight='bold')
    ax.set_ylabel('绝对差异 ($)', fontsize=11, color=color)
    ax_r.set_ylabel('相对差异 (%)', fontsize=11, color='#D32F2F')

    # Value labels on bars
    for i, d in enumerate(dates):
        if abs(abs_v[i]) > 5:
            ax.annotate(f'${abs_v[i]:+.0f}', (d, abs_v[i]),
                        textcoords='offset points', xytext=(0, 8 if abs_v[i] >= 0 else -14),
                        fontsize=7, color=color, ha='center', fontweight='bold')
        if abs(rel_v[i]) > 0.05:
            ax_r.annotate(f'{rel_v[i]:+.1f}%', (d, rel_v[i]),
                          textcoords='offset points', xytext=(15, 0),
                          fontsize=7, color='#D32F2F', ha='left')

    # Combined legend
    lines_bars = [bars]
    lines_line = line
    labels = [f'{name}绝对差 ($)', f'{name}相对差 (%)']
    ax.legend(lines_bars + lines_line, labels, fontsize=9, loc='upper left')

    ax.grid(True, alpha=0.3, axis='y')
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    ax.xaxis.set_major_locator(mdates.DayLocator())
    plt.setp(ax.xaxis.get_majorticklabels(), rotation=45, ha='right')

    if idx == 2:
        ax.set_xlabel('日期', fontsize=12)

fig2.tight_layout()
fig2.savefig('/home/admin/.openclaw/workspace/scripts/compare-chart-v2-detail.png', dpi=150, bbox_inches='tight')
print('Chart 2 saved: compare-chart-v2-detail.png')

# ============ Chart 3: 逐产品×渠道绝对差异热力图 ============
fig3, ax3 = plt.subplots(figsize=(16, 10))

# Build matrix: rows = product×channel, cols = dates
from collections import defaultdict
pc_data = defaultdict(dict)
for r in data['details']:
    key = f"{r['product']}|{r['channel']}"
    pc_data[key][r['date']] = r['revDiff']  # original revenue diff

# Add zero entries for missing dates
all_keys = sorted(pc_data.keys())
date_strs = data['dates']

# Filter to only keys with meaningful diffs
significant_keys = []
for key in all_keys:
    max_diff = max(abs(pc_data[key].get(d, 0)) for d in date_strs)
    if max_diff > 1:
        significant_keys.append(key)

import numpy as np
matrix = np.zeros((len(significant_keys), len(date_strs)))
for i, key in enumerate(significant_keys):
    for j, d in enumerate(date_strs):
        matrix[i][j] = pc_data[key].get(d, 0)

im = ax3.imshow(matrix, cmap='RdBu_r', aspect='auto', vmin=-max(abs(matrix.max()), abs(matrix.min())), vmax=max(abs(matrix.max()), abs(matrix.min())))
ax3.set_xticks(range(len(date_strs)))
ax3.set_xticklabels([d[5:] for d in date_strs], rotation=45, ha='right', fontsize=9)
ax3.set_yticks(range(len(significant_keys)))
ax3.set_yticklabels(significant_keys, fontsize=9)

# Add text annotations
for i in range(len(significant_keys)):
    for j in range(len(date_strs)):
        val = matrix[i][j]
        if abs(val) > 5:
            ax3.text(j, i, f'{val:+.0f}', ha='center', va='center',
                     fontsize=7, color='white' if abs(val) > 150 else 'black',
                     fontweight='bold' if abs(val) > 100 else 'normal')

ax3.set_title('逐产品×渠道 原始收入绝对差异热力图 ($)', fontsize=14, fontweight='bold')
fig3.colorbar(im, ax=ax3, label='差异金额 ($)', shrink=0.8)
fig3.tight_layout()
fig3.savefig('/home/admin/.openclaw/workspace/scripts/compare-chart-v2-heatmap.png', dpi=150, bbox_inches='tight')
print('Chart 3 saved: compare-chart-v2-heatmap.png')
