#!/usr/bin/env python3
"""
苏屹恒日报核查：原始收入差异热力图 + 修正收入差异热力图
"""

import json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from collections import defaultdict
from datetime import datetime

with open('/home/admin/.openclaw/workspace/scripts/compare-result.json') as f:
    data = json.load(f)

plt.rcParams['font.family'] = ['WenQuanYi Micro Hei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

dates_str = data['dates']
details = data['details']

# Build matrices for original revenue diff and corrected revenue diff
rev_data = defaultdict(dict)
corr_data = defaultdict(dict)
for r in details:
    key = f"{r['product']}|{r['channel']}"
    rev_data[key][r['date']] = r['revDiff']
    corr_data[key][r['date']] = r['corrDiff']

all_keys = sorted(set(list(rev_data.keys()) + list(corr_data.keys())))

# Filter to significant keys (at least one day with |diff| > $1)
sig_keys_rev = [k for k in all_keys if max(abs(rev_data[k].get(d, 0)) for d in dates_str) > 1]
sig_keys_corr = [k for k in all_keys if max(abs(corr_data[k].get(d, 0)) for d in dates_str) > 1]

def make_heatmap(keys, data_dict, title, filename, vmin=None, vmax=None):
    matrix = np.zeros((len(keys), len(dates_str)))
    for i, key in enumerate(keys):
        for j, d in enumerate(dates_str):
            matrix[i][j] = data_dict[key].get(d, 0)
    
    if vmin is None or vmax is None:
        abs_max = max(abs(matrix.max()), abs(matrix.min())) or 1
        vmin, vmax = -abs_max, abs_max
    
    fig, ax = plt.subplots(figsize=(16, max(8, len(keys) * 0.5 + 2)))
    im = ax.imshow(matrix, cmap='RdBu_r', aspect='auto', vmin=vmin, vmax=vmax)
    
    ax.set_xticks(range(len(dates_str)))
    ax.set_xticklabels([d[5:] for d in dates_str], rotation=45, ha='right', fontsize=9)
    ax.set_yticks(range(len(keys)))
    ax.set_yticklabels(keys, fontsize=9)
    
    # Text annotations
    for i in range(len(keys)):
        for j in range(len(dates_str)):
            val = matrix[i][j]
            if abs(val) > 5:
                ax.text(j, i, f'{val:+.0f}', ha='center', va='center',
                        fontsize=7, color='white' if abs(val) > abs_max * 0.5 else 'black',
                        fontweight='bold' if abs(val) > abs_max * 0.3 else 'normal')
    
    ax.set_title(title, fontsize=14, fontweight='bold', pad=15)
    fig.colorbar(im, ax=ax, label='差异金额 ($)', shrink=0.8)
    fig.tight_layout()
    fig.savefig(filename, dpi=150, bbox_inches='tight')
    print(f'Saved: {filename}')

# Chart 1: Original Revenue Diff Heatmap
make_heatmap(sig_keys_rev, rev_data,
             '苏屹恒 日报 vs Dashboard — 原始收入绝对差异热力图 ($)\n(红=表格多, 蓝=Dashboard多)',
             '/home/admin/.openclaw/workspace/scripts/heatmap-raw-revenue.png')

# Chart 2: Corrected Revenue Diff Heatmap
make_heatmap(sig_keys_corr, corr_data,
             '苏屹恒 日报 vs Dashboard — 修正收入绝对差异热力图 ($)\n(红=表格多, 蓝=Dashboard多)',
             '/home/admin/.openclaw/workspace/scripts/heatmap-corrected-revenue.png')

print('Done!')
