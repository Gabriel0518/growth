#!/usr/bin/env bash
# memory-guard.sh — 内存守护脚本
# 当系统已用内存超过阈值（默认 3200MB）时，按优先级杀掉非关键进程释放内存
# 设计为 cron 每分钟执行一次
#
# 优先级（先杀低优先级的）：
#   1. tracker-miner-fs（GNOME 索引，完全没用）
#   2. Chrome 浏览器进程（OpenClaw 自带 headless，可随时重启）
#   3. SearXNG Docker 容器（stop，不 rm）
#
# 绝对不杀：openclaw、node.*server.js、sshd、systemd、caddy、dataserver
#
# 用法：
#   bash scripts/memory-guard.sh              # 正常运行
#   bash scripts/memory-guard.sh --dry-run    # 只打印，不杀
#   THRESHOLD_MB=3000 bash scripts/memory-guard.sh  # 自定义阈值

set -euo pipefail

THRESHOLD_MB="${THRESHOLD_MB:-3200}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

LOG_TAG="memory-guard"
log() { logger -t "$LOG_TAG" "$*"; echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# 获取已用内存（MB）—— 用 MemTotal - MemAvailable，和 free 输出一致
get_used_mb() {
  awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{printf "%d", (t-a)/1024}' /proc/meminfo
}

used=$(get_used_mb)
log "Used: ${used}MB / Threshold: ${THRESHOLD_MB}MB"

if (( used <= THRESHOLD_MB )); then
  log "Memory OK, nothing to do."
  exit 0
fi

log "⚠️  Memory ${used}MB exceeds ${THRESHOLD_MB}MB, starting cleanup..."

# ── 第 1 级：杀 tracker-miner-fs ──
if (( $(get_used_mb) > THRESHOLD_MB )); then
  pids=$(pgrep -f 'tracker-miner-f' 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    rss=$(ps -o rss= -p $(echo "$pids" | head -1) 2>/dev/null | awk '{printf "%.0f", $1/1024}')
    log "Level 1: Killing tracker-miner-fs (${rss}MB)..."
    if ! $DRY_RUN; then
      kill $pids 2>/dev/null || true
      sleep 2
    fi
    log "Level 1: Done. Used now: $(get_used_mb)MB"
  fi
fi

# ── 第 2 级：杀 Chrome 浏览器（所有用户） ──
if (( $(get_used_mb) > THRESHOLD_MB )); then
  chrome_pids=$(pgrep -f '/opt/google/chrome/chrome' 2>/dev/null || true)
  if [[ -n "$chrome_pids" ]]; then
    chrome_rss=$(echo "$chrome_pids" | xargs ps -o rss= -p 2>/dev/null | awk '{s+=$1} END{printf "%.0f", s/1024}')
    log "Level 2: Killing Chrome processes (${chrome_rss}MB across $(echo "$chrome_pids" | wc -w) pids)..."
    if ! $DRY_RUN; then
      # 先 SIGTERM 优雅退出
      kill $chrome_pids 2>/dev/null || true
      sleep 3
      # 仍然存活的 SIGKILL
      for p in $chrome_pids; do
        kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
      done
      sleep 1
    fi
    log "Level 2: Done. Used now: $(get_used_mb)MB"
  fi
fi

# ── 第 3 级：停止 SearXNG Docker 容器 ──
if (( $(get_used_mb) > THRESHOLD_MB )); then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^searxng$'; then
    searxng_rss=$(ps -eo rss,comm 2>/dev/null | grep searxng | awk '{s+=$1} END{printf "%.0f", s/1024}')
    log "Level 3: Stopping SearXNG Docker container (${searxng_rss}MB)..."
    if ! $DRY_RUN; then
      docker stop searxng 2>/dev/null || true
      sleep 2
    fi
    log "Level 3: Done. Used now: $(get_used_mb)MB"
  fi
fi

final_used=$(get_used_mb)
if (( final_used <= THRESHOLD_MB )); then
  log "✅ Cleanup successful: ${used}MB → ${final_used}MB (threshold: ${THRESHOLD_MB}MB)"
else
  log "⚠️  Cleanup done but still at ${final_used}MB (threshold: ${THRESHOLD_MB}MB). May need manual intervention."
fi
