#!/bin/bash
# XMP Dashboard Cost Fetcher
# Usage: bash scripts/fetch-xmp-cost.sh [startDate] [endDate]
# Date format: YYYY-MM-DD (omit for today's data)
# NOTE: Date range is inclusive. For a single day, use same date twice.

export $(cat /etc/environment | xargs) 2>/dev/null
cd "$(dirname "$0")/.."
node scripts/xmp-dashboard.js "$@" 2>&1 | grep -A 100 "RESULTS_JSON" | tail -n +2
