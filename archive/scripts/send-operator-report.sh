#!/bin/bash
# Operator Daily Report — runs daily at 07:30
# Generates text report + charts and sends to Feishu group
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$WORKSPACE/output"
CHAT_ID="oc_15b383a83d008af776490affcd889b40"

export PATH=~/.npm-global/bin:$PATH

echo "[OpReport] $(date '+%Y-%m-%d %H:%M:%S') Starting..."

# 1. Generate text report (captures message between ---MESSAGE--- markers)
REPORT_OUTPUT=$(cd "$WORKSPACE" && node scripts/operator-daily-report.js 2>&1)
MESSAGE=$(echo "$REPORT_OUTPUT" | sed -n '/^---MESSAGE---$/,/^---END---$/p' | sed '1d;$d')

if [ -z "$MESSAGE" ]; then
  echo "[OpReport] ERROR: No message generated"
  exit 1
fi

echo "[OpReport] Text report generated"

# 1.5. XMP cache backfill now runs as separate cron at 13:20 (before this script)
# Keeping a lightweight check: if any date in range is missing, warn but continue

# 2. Generate charts (node outputs JSON, python draws charts)
cd "$WORKSPACE"
node scripts/operator-multiday-data.js 2>/dev/null | python3 scripts/operator-charts.py 2>&1
echo "[OpReport] Charts generated"

# 3. Send to Feishu group
lark-cli im +messages-send --as bot --chat-id "$CHAT_ID" --text "$MESSAGE"
echo "[OpReport] Text sent"

cd "$OUTPUT_DIR"
lark-cli im +messages-send --as bot --chat-id "$CHAT_ID" --image ./operator-revenue.png
echo "[OpReport] Revenue chart sent"

lark-cli im +messages-send --as bot --chat-id "$CHAT_ID" --image ./operator-margin.png
echo "[OpReport] Margin chart sent"

echo "[OpReport] Done!"
