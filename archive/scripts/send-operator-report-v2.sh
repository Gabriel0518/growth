#!/bin/bash
# Operator Daily Report v2 — runs daily at 13:30
# Reads data from Feishu sheet, generates text + charts + rankings, sends to group
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(dirname "$SCRIPT_DIR")"

export PATH=~/.npm-global/bin:$PATH
export OPENCLAW_HOME=/home/admin/.openclaw

echo "[OpReport-v2] $(date '+%Y-%m-%d %H:%M:%S') Starting..."

cd "$WORKSPACE"
node scripts/operator-report-v2.js

echo "[OpReport-v2] $(date '+%Y-%m-%d %H:%M:%S') Done!"
