#!/bin/bash
# auto-deploy.sh - 自动部署脚本
# 在 Codespace Terminal 里运行: bash auto-deploy.sh
# 功能：监测文件变化 → 自动 commit+push → 等待 Actions 构建 → 重启 Sealos

REPO_DIR="/workspaces/document-flow-system"
SEALOS_URL="https://dmtrgpkjqvjw.cloud.sealos.io"
POLL_INTERVAL=30  # 每30秒检查一次

echo "🚀 自动部署已启动！(Ctrl+C 停止)"
echo "📝 改完代码后保存即可，系统会自动推送+部署"
echo ""

cd "$REPO_DIR" || exit 1

last_commit=$(git rev-parse HEAD 2>/dev/null)

while true; do
    # Check for changes
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard)" ]; then
        echo ""
        echo "📦 检测到文件变化，正在推送..."
        
        # Sync public/index.html if root index.html changed
        if [ -f index.html ] && [ -f public/index.html ]; then
            if ! diff -q index.html public/index.html > /dev/null 2>&1; then
                echo "  📋 同步 index.html → public/index.html"
                cp index.html public/index.html
            fi
        fi
        
        git add -A
        timestamp=$(date +"%H:%M:%S")
        git commit -m "auto: 更新 $timestamp" 2>/dev/null
        
        if git push origin main 2>/dev/null; then
            new_commit=$(git rev-parse --short HEAD)
            echo "  ✅ 已推送 ($new_commit)"
            echo "  ⏳ 等待 GitHub Actions 构建..."
            
            # Wait for Actions to complete (check every 15s, max 5min)
            waited=0
            while [ $waited -lt 300 ]; do
                sleep 15
                waited=$((waited + 15))
                # Check if latest run completed
                status=$(gh run list --limit 1 --json status,conclusion -q '.[0].status' 2>/dev/null || echo "unknown")
                if [ "$status" = "completed" ]; then
                    conclusion=$(gh run list --limit 1 --json status,conclusion -q '.[0].conclusion' 2>/dev/null || echo "unknown")
                    if [ "$conclusion" = "success" ]; then
                        echo "  ✅ 构建成功！(${waited}秒)"
                        # Hit the health endpoint to verify
                        sleep 5
                        if curl -s "$SEALOS_URL/health" | grep -q "ok"; then
                            echo "  ✅ 服务运行正常！"
                        else
                            echo "  ⚠️  服务可能需要重启，请去 Sealos 控制台手动重启"
                        fi
                        break
                    else
                        echo "  ❌ 构建失败: $conclusion"
                        break
                    fi
                fi
                echo "  ... ${waited}秒"
            done
        else
            echo "  ❌ 推送失败，稍后重试"
        fi
    fi
    
    sleep $POLL_INTERVAL
done