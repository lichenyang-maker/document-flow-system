#!/bin/bash
set -e

IMAGE_REGISTRY=${1:-"your-registry"}
IMAGE_NAME=${2:-"document-flow-system"}
IMAGE_TAG=${3:-"latest"}

echo "=========================================="
echo "  构建 Docker 镜像"
echo "=========================================="
echo ""
echo "镜像仓库: ${IMAGE_REGISTRY}"
echo "镜像名称: ${IMAGE_NAME}"
echo "镜像标签: ${IMAGE_TAG}"
echo ""

FULL_IMAGE="${IMAGE_REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "步骤 1: 构建镜像..."
docker build -t ${FULL_IMAGE} .
echo ""
echo "[OK] 镜像构建完成: ${FULL_IMAGE}"
echo ""

echo "步骤 2: 测试镜像本地运行..."
docker run -d --name docflow-test -p 3000:3000 ${FULL_IMAGE}
sleep 5

if curl -s http://localhost:3000/health | grep -q "ok"; then
    echo "[OK] 健康检查通过"
else
    echo "[WARN] 健康检查失败，请检查镜像"
fi

echo ""
echo "步骤 3: 停止测试容器..."
docker stop docflow-test
docker rm docflow-test
echo ""

echo "步骤 4: 推送镜像到仓库..."
docker push ${FULL_IMAGE}
echo ""
echo "[OK] 镜像推送完成: ${FULL_IMAGE}"
echo ""

echo "=========================================="
echo "  镜像准备完成"
echo "=========================================="
echo ""
echo "下一步: 部署到 sealos"
echo "请更新 sealos/deployment.yaml 中的 image 字段为: ${FULL_IMAGE}"
echo ""
