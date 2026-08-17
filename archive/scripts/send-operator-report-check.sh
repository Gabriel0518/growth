#!/bin/bash
# Operator Daily Report — 5 PM Double-Check (runs daily at 17:00)
# Re-checks which operators still have no data for yesterday.
#  - Some missing  -> @mention them again in the group
#  - All filled in -> send "投手日报全部完成 [撒花][撒花]"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(dirname "$SCRIPT_DIR")"

export PATH=~/.npm-global/bin:$PATH
export OPENCLAW_HOME=/home/admin/.openclaw

echo "[OpCheck] $(date '+%Y-%m-%d %H:%M:%S') Starting..."

cd "$WORKSPACE"
node scripts/operator-report-check.js

echo "[OpCheck] $(date '+%Y-%m-%d %H:%M:%S') Done!"
