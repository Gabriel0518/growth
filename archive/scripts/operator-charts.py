#!/usr/bin/env python3
"""
Operator charts: revenue and profit margin line charts
Reads JSON from stdin (output of operator-multiday-data.js)
Outputs two PNG files
"""

import json
import sys
import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime

# Chinese font support
plt.rcParams['font.sans-serif'] = ['WenQuanYi Micro Hei', 'Noto Sans CJK SC', 'SimHei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'output')

# Distinct colors for operators
COLORS = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
    '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
    '#dcbeff', '#800000',
]

def main():
    data = json.load(sys.stdin)
    dates = data['dates']
    operators = data['operators']
    
    date_objs = [datetime.strptime(d, '%Y-%m-%d') for d in dates]
    
    # Sort operators by total revenue (descending) for legend order
    op_total_rev = {}
    for code, info in operators.items():
        total = sum(info['daily'].get(d, {}).get('revenue', 0) for d in dates)
        op_total_rev[code] = total
    sorted_ops = sorted(operators.keys(), key=lambda x: -op_total_rev[x])
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # ── Chart 1: Revenue ──
    fig, ax = plt.subplots(figsize=(12, 6))
    for i, code in enumerate(sorted_ops):
        info = operators[code]
        revenues = [info['daily'].get(d, {}).get('revenue', 0) for d in dates]
        color = COLORS[i % len(COLORS)]
        ax.plot(date_objs, revenues, marker='o', markersize=4, linewidth=2, 
                label=info['name'], color=color)
    
    ax.set_title(f'投手收入趋势 ({dates[0]} ~ {dates[-1]})', fontsize=14, fontweight='bold')
    ax.set_xlabel('日期', fontsize=11)
    ax.set_ylabel('收入 ($)', fontsize=11)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    ax.xaxis.set_major_locator(mdates.DayLocator())
    ax.legend(loc='upper left', bbox_to_anchor=(1.01, 1), fontsize=9)
    ax.grid(True, alpha=0.3)
    ax.set_xlim(date_objs[0], date_objs[-1])
    fig.tight_layout()
    
    rev_path = os.path.join(OUTPUT_DIR, 'operator-revenue.png')
    fig.savefig(rev_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'Revenue chart: {rev_path}', file=sys.stderr)
    
    # ── Chart 2: Profit Margin ──
    fig, ax = plt.subplots(figsize=(12, 6))
    for i, code in enumerate(sorted_ops):
        info = operators[code]
        margins_raw = [info['daily'].get(d, {}).get('profitMargin', 0) * 100 for d in dates]
        # Clamp to -20% floor
        margins = [max(min(m, 30), -20) for m in margins_raw]
        color = COLORS[i % len(COLORS)]
        ax.plot(date_objs, margins, marker='o', markersize=4, linewidth=2,
                label=info['name'], color=color)
    
    ax.axhline(y=0, color='black', linewidth=0.8, linestyle='--', alpha=0.5)
    ax.set_ylim(bottom=-20, top=30)
    ax.set_title(f'投手纯利润率趋势 ({dates[0]} ~ {dates[-1]})', fontsize=14, fontweight='bold')
    ax.set_xlabel('日期', fontsize=11)
    ax.set_ylabel('纯利润率 (%)', fontsize=11)
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
    ax.xaxis.set_major_locator(mdates.DayLocator())
    ax.legend(loc='upper left', bbox_to_anchor=(1.01, 1), fontsize=9)
    ax.grid(True, alpha=0.3)
    ax.set_xlim(date_objs[0], date_objs[-1])
    fig.tight_layout()
    
    margin_path = os.path.join(OUTPUT_DIR, 'operator-margin.png')
    fig.savefig(margin_path, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'Margin chart: {margin_path}', file=sys.stderr)
    
    # Print paths to stdout for caller
    print(rev_path)
    print(margin_path)

if __name__ == '__main__':
    main()
