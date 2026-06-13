#!/bin/bash
# 自动推送脚本 - 每30秒检测文件变更并自动commit+push
cd /workspaces/document-flow-system
echo "🚀 自动推送已启动（每30秒检测一次）"
while true; do
  git add .
  if ! git diff --cached --quiet; then
    CHANGES=$(git diff --cached --stat)
    git commit -m "auto: $CHANGES"
    git push origin main
    echo "[$(date +'%H:%M:%S')] ✅ 已自动推送"
  fi
  sleep 30
done