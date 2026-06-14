# ⚠️ 在 Sealos 的 Cloud Terminal 中运行，不是在本地
# 使用 GitHub Actions 构建的 GHCR 镜像，一键更新 Sealos

# 设置变量
NAMESPACE="document-flow"
DEPLOYMENT="document-flow-system"
IMAGE="ghcr.io/lichenyang-maker/document-flow-system:latest"

echo "🚀 拉取最新镜像并重启..."
kubectl set image deployment/$DEPLOYMENT $DEPLOYMENT=$IMAGE -n $NAMESPACE

# 等待部署完成
kubectl rollout status deployment/$DEPLOYMENT -n $NAMESPACE --timeout=300s

echo "✅ 部署完成！"
echo "📋 查看最新日志：kubectl logs -f deployment/$DEPLOYMENT -n $NAMESPACE"
