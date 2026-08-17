#!/bin/bash
# Sitin Dashboard Revenue Fetcher
# Usage: bash scripts/fetch-revenue.sh [startDate] [endDate]
# Date format: YYYY-MM-DD (omit for today's data)
# NOTE: Date range is inclusive. For a single day, use same date twice:
#   bash scripts/fetch-revenue.sh 2026-03-24 2026-03-24
# Output: JSON array with 8 products' totalRevenue and newUserRevenue

export $(cat /etc/environment | xargs) 2>/dev/null
cd "$(dirname "$0")/.."
node scripts/sitin-dashboard.js "$@" 2>&1 | grep -A 100 "RESULTS_JSON" | tail -n +2
