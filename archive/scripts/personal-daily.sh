#!/usr/bin/env bash
# 苏屹恒个人日报 每日全链路（08:50 cron）
# 顺序（后步依赖前步产物）：
#   1) fill-personal-daily-report.js  : 填「投放日报模板」苏屹恒模版 C/D/F（刷新最近3天）
#   2) backfill-personal-report-subtabs.js : 模板 → 20 个产品×渠道分表（insert before + 写数字，幂等）
#   3) sync-personal-summary.js       : 同步「苏屹恒汇总」顶部到昨天（幂等）
# 任一步失败：停止后续 + 飞书私信通知屹恒。
set -uo pipefail
cd /home/admin/.openclaw/workspace
export OPENCLAW_HOME=/home/admin/.openclaw
# cron 精简 PATH 不含 .npm-global/bin，lark-cli 在那里
export PATH="/home/admin/.npm-global/bin:$PATH"

TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo "===== [personal-daily] start $TS ====="

run_step () {
  local name="$1"; shift
  echo "----- step: $name -----"
  if ! "$@"; then
    local rc=$?
    echo "[personal-daily] STEP FAILED: $name (rc=$rc)"
    /usr/bin/node scripts/feishu-notify.js "❌ 个人日报自动填写失败 · $(date '+%m-%d %H:%M')
失败步骤：$name
请查看 output/personal-daily.log" || true
    exit $rc
  fi
}

run_step "1/3 填模板(fill-personal)"        /usr/bin/node scripts/fill-personal-daily-report.js
sleep 3
run_step "2/3 补分表(backfill-subtabs)"     /usr/bin/node scripts/backfill-personal-report-subtabs.js
sleep 3
run_step "3/3 同步汇总(sync-summary)"       /usr/bin/node scripts/sync-personal-summary.js

echo "===== [personal-daily] done $(date '+%Y-%m-%d %H:%M:%S') ====="
