#!/bin/bash
# Fetch AppsFlyer data
# Usage: bash scripts/fetch-af.sh [start_date] [end_date]
# Default: today's data

set -euo pipefail
cd "$(dirname "$0")/.."

# Load environment
export $(grep -E '^AF_' /etc/environment | xargs)

if [ $# -ge 2 ]; then
  node scripts/af-dashboard.js "$1" "$2"
else
  node scripts/af-dashboard.js
fi
