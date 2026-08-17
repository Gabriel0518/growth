#!/bin/bash
# Operator Rank Report — runs daily at 14:30
# Reads rank table from Feishu wiki sheet and sends summary to group
# @mentions operators with no data
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(dirname "$SCRIPT_DIR")"
CHAT_ID="oc_15b383a83d008af776490affcd889b40"

export PATH=~/.npm-global/bin:$PATH
export OPENCLAW_HOME=/home/admin/.openclaw

echo "[RankReport] $(date '+%Y-%m-%d %H:%M:%S') Starting..."

cd "$WORKSPACE"
node scripts/operator-rank-report.js

echo "[RankReport] Done!"
