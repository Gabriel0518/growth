#!/bin/bash
# Write revenue data to Feishu Sheet
# Usage: bash scripts/write-sheet.sh <json_data> <time_label>
# Example: bash scripts/write-sheet.sh '[{"product":"GraceChat","totalRevenue":"$1234","newUserRevenue":"$456"},...]' "3月25日 16:00"

set -e

JSON_DATA="$1"
TIME_LABEL="$2"

if [ -z "$JSON_DATA" ] || [ -z "$TIME_LABEL" ]; then
  echo "Usage: bash scripts/write-sheet.sh <json_data> <time_label>"
  exit 1
fi

export $(cat /etc/environment | xargs) 2>/dev/null
cd "$(dirname "$0")/.."
node scripts/write-sheet.js "$JSON_DATA" "$TIME_LABEL"
