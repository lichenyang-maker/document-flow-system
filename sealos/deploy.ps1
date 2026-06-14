param(
    [switch]$AllInOne = $true
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  部署到 sealos" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

if ($AllInOne) {
    Write-Host "使用 all-in-one 配置文件部署..." -ForegroundColor Yellow
    kubectl apply -f sealos/all-in-one.yaml
    if ($LASTEXITCODE -ne 0) { throw "部署失败" }
} else {
    Write-Host "步骤 1: 创建命名空间..." -ForegroundColor Yellow
    kubectl apply -f sealos/namespace.yaml
    Write-Host "[OK] 命名空间已创建" -ForegroundColor Green
    Write-Host ""

    Write-Host "步骤 2: 创建持久化卷声明..." -ForegroundColor Yellow
    kubectl apply -f sealos/pvc.yaml
    Write-Host "[OK] PVC 已创建" -ForegroundColor Green
    Write-Host ""

    Write-Host "步骤 3: 等待 PVC 绑定..." -ForegroundColor Yellow
    kubectl wait --for=condition=Bound pvc/document-flow-data -n document-flow --timeout=120s
    Write-Host "[OK] PVC 已绑定" -ForegroundColor Green
    Write-Host ""

    Write-Host "步骤 4: 部署应用..." -ForegroundColor Yellow
    kubectl apply -f sealos/deployment.yaml
    Write-Host "[OK] Deployment 已创建" -ForegroundColor Green
    Write-Host ""

    Write-Host "步骤 5: 创建服务..." -ForegroundColor Yellow
    kubectl apply -f sealos/service.yaml
    Write-Host "[OK] Service 已创建" -ForegroundColor Green
    Write-Host ""

    Write-Host "步骤 6: 创建 Ingress..." -ForegroundColor Yellow
    kubectl apply -f sealos/ingress.yaml
    Write-Host "[OK] Ingress 已创建" -ForegroundColor Green
    Write-Host ""
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  等待部署完成" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

kubectl rollout status deployment/document-flow-system -n document-flow --timeout=300s

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  部署完成！" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "查看 Pod 状态:" -ForegroundColor Yellow
kubectl get pods -n document-flow
Write-Host ""

Write-Host "查看服务:" -ForegroundColor Yellow
kubectl get svc -n document-flow
Write-Host ""

Write-Host "查看 Ingress:" -ForegroundColor Yellow
kubectl get ingress -n document-flow
Write-Host ""

Write-Host "查看日志:" -ForegroundColor Yellow
Write-Host "kubectl logs -f deployment/document-flow-system -n document-flow"
Write-Host ""
