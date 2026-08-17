#!/usr/bin/env bash
# 日报数据 → 日报数据汇总(wiki) 同步
# 每天 08:40 执行（源表 08:30 写入，留 10 分钟缓冲）
# 首跑用 --first-run 触发"无论成败都发报告"；首跑成功后自动清除该标记。
set -uo pipefail
cd /home/admin/.openclaw/workspace

FLAG_FILE="output/.sync-wiki-first-run-done"
ARGS=""
if [ ! -f "$FLAG_FILE" ]; then
  ARGS="--first-run"
fi

/usr/bin/node scripts/sync-daily-report-to-wiki.js $ARGS
RC=$?

# 首跑成功后写标记，之后不再带 --first-run
if [ "$ARGS" = "--first-run" ] && [ $RC -eq 0 ]; then
  mkdir -p output
  date > "$FLAG_FILE"
fi

exit $RC
