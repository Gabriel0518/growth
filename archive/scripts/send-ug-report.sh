#!/bin/bash
# send-ug-report.sh — Generate UG早报 and send via lark-cli (bot identity) to group chat
set -euo pipefail

export PATH="$HOME/.npm-global/bin:$PATH"

WORKSPACE="$HOME/.openclaw/workspace"
LOG_DIR="$WORKSPACE/output"
CHAT_ID="oc_07e9c151b9b8bc8c1b4090f6880d7dcd"

mkdir -p "$LOG_DIR"

REPORT_DATE=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/ug-report-${REPORT_DATE}.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Generating UG早报 for $REPORT_DATE" | tee -a "$LOG_FILE"

# Generate report
REPORT=$(python3 "$WORKSPACE/scripts/gen-ug-report.py" --date "$REPORT_DATE" 2>>"$LOG_FILE")
if [ $? -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ Report generation failed" | tee -a "$LOG_FILE"
    exit 1
fi

echo "$REPORT" >> "$LOG_FILE"

# Send via lark-cli bot identity to UG早报 group chat
SEND_OUTPUT=$(lark-cli im +messages-send \
    --as bot \
    --chat-id "$CHAT_ID" \
    --text "$REPORT" 2>&1) || true

if echo "$SEND_OUTPUT" | grep -q '"message_id"'; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Report sent to group $CHAT_ID" | tee -a "$LOG_FILE"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ Send may have failed: $SEND_OUTPUT" | tee -a "$LOG_FILE"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Done" | tee -a "$LOG_FILE"
