#!/bin/bash
# 双端同步（对象 + 材料文件）。由 LaunchAgent 每 15 分钟调一次。
# 设计要点：
#   · **对端不在线就安静退出**（0），不报错、不堆积 —— 笔记本出门时 mini 可能不可达
#   · 日志追加到一个文件，出问题可回看
#   · 不用管道吞退出码（用户铁律）
set -uo pipefail
cd "$(dirname "$0")" || exit 1
LOG="$HOME/.dsh/workstation-sync.log"
REMOTE="simmon@100.103.17.44"
REMOTE_DIR="/Users/simmon/DSH/飞书工作区"
DB="$HOME/Desktop/DSH/飞书工作区/workstation-data/workstation.sqlite"
{
  echo "──── $(date '+%Y-%m-%d %H:%M:%S') ────"
  if ! ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 "$REMOTE" true 2>/dev/null; then
    echo "对端不可达，跳过这次（不算失败）"
    exit 0
  fi
  node sync-engine.mjs --local "$DB" --remote "$REMOTE" --remote-db "$REMOTE_DIR/workstation-data/workstation.sqlite" \
    --apply --force --files --local-root "$HOME/Desktop/DSH/飞书工作区" --remote-root "$REMOTE_DIR"
  echo "退出码 $?"
} >> "$LOG" 2>&1
