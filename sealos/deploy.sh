#!/bin/bash
set -e

echo "=========================================="
echo "  部署到 sealos"
echo "=========================================="
echo ""

echo "步骤 1: 创建命名空间..."
kubectl apply -f sealos/namespace.yaml
echo "[OK] 命名空间已创建"
echo ""

echo "步骤 2: 创建持久化卷声明..."
kubectl apply -f sealos/pvc.yaml
echo "[OK] PVC 已创建"
echo ""

echo "步骤 3: 等待 PVC 绑定..."
kubectl wait --for=condition=Bound pvc/document-flow-data -n document-flow --timeout=120s
echo "[OK] PVC 已绑定"
echo ""

echo "步骤 4: 部署应用..."
kubectl apply -f sealos/deployment.yaml
echo "[OK] Deployment 已创建"
echo ""

echo "步骤 5: 创建服务..."
kubectl apply -f sealos/service.yaml
echo "[OK] Service 已创建"
echo ""

echo "步骤 6: 创建 Ingress..."
kubectl apply -f sealos/ingress.yaml
echo "[OK] Ingress 已创建"
echo ""

echo "=========================================="
echo "  等待部署完成"
echo "=========================================="
echo ""

kubectl rollout status deployment/document-flow-system -n document-flow --timeout=300s

echo ""
echo "=========================================="
echo "  部署完成！"
echo "=========================================="
echo ""

echo "查看 Pod 状态:"
kubectl get pods -n document-flow
echo ""

echo "查看服务:"
kubectl get svc -n document-flow
echo ""

echo "查看 Ingress:"
kubectl get ingress -n document-flow
echo ""

echo "查看日志:"
echo "kubectl logs -f deployment/document-flow-system -n document-flow"
echo ""
