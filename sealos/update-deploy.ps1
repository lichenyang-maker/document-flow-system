# ============================================================
#  更新部署脚本 - 自动检测 Sealos 配置并重新部署
#  使用方法: .\sealos\update-deploy.ps1
# ============================================================
param(
    [string]$Domain = "",          # 你的 Sealos 域名，留空则自动检测
    [string]$Registry = "",        # 镜像仓库地址，留空则用 sealos 默认
    [string]$ImageName = "document-flow-system",
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  公文流转系统 - 更新部署" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# ========== Step 1: 检测 Sealos 环境 ==========
Write-Host "[1/5] 检查 kubectl 连接..." -ForegroundColor Yellow
$kubectlCheck = kubectl version --client 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] kubectl 未安装，请先安装 kubectl" -ForegroundColor Red
    exit 1
}

# 尝试获取当前命名空间信息
try {
    $pods = kubectl get pods -n document-flow -o json 2>$null | ConvertFrom-Json
    if ($pods.items.Count -gt 0) {
        Write-Host "[OK] 已连接到 Kubernetes 集群" -ForegroundColor Green
        $podName = $pods.items[0].metadata.name
        Write-Host "      找到 Pod: $podName" -ForegroundColor Gray
        $currentImage = $pods.items[0].spec.containers[0].image
        Write-Host "      当前镜像: $currentImage" -ForegroundColor Gray
    }
} catch {
    Write-Host "[WARN] 无法获取 Pod 信息，尝试继续..." -ForegroundColor Yellow
}

# 自动检测域名
if (-not $Domain) {
    try {
        $ingress = kubectl get ingress -n document-flow -o json 2>$null | ConvertFrom-Json
        if ($ingress.items.Count -gt 0) {
            $Domain = $ingress.items[0].spec.rules[0].host
            Write-Host "[OK] 自动检测到域名: $Domain" -ForegroundColor Green
        }
    } catch {}
}

if (-not $Domain) {
    Write-Host ""
    Write-Host "⚠️  无法自动检测域名，请手动输入：" -ForegroundColor Yellow
    Write-Host "   (在 Sealos 控制台 → 应用管理 → 点击应用 → 查看域名)" -ForegroundColor Gray
    $Domain = Read-Host "请输入你的 Sealos 域名"
    if (-not $Domain) {
        Write-Host "[ERROR] 域名不能为空" -ForegroundColor Red
        exit 1
    }
}

# 自动检测镜像仓库
if (-not $Registry) {
    try {
        $currentImage = kubectl get deployment document-flow-system -n document-flow -o json 2>$null | ConvertFrom-Json | Select-Object -ExpandProperty spec | Select-Object -ExpandProperty template | Select-Object -ExpandProperty spec | Select-Object -ExpandProperty containers | Select-Object -First 1 | Select-Object -ExpandProperty image
        if ($currentImage -match "^(.+)/$ImageName:") {
            $Registry = $matches[1]
            Write-Host "[OK] 自动检测到镜像仓库: $Registry" -ForegroundColor Green
        }
    } catch {}
}

if (-not $Registry) {
    Write-Host ""
    Write-Host "⚠️  无法自动检测镜像仓库，请手动输入：" -ForegroundColor Yellow
    Write-Host "   (在 Sealos 控制台 → 镜像仓库 可查看)" -ForegroundColor Gray
    $Registry = Read-Host "请输入镜像仓库地址 (如 docker.io/myuser 或 sealos.hub)"
    if (-not $Registry) {
        Write-Host "[ERROR] 镜像仓库不能为空" -ForegroundColor Red
        exit 1
    }
}

$FullImage = "$Registry/$ImageName`:$Tag"
Write-Host ""
Write-Host "部署配置确认:" -ForegroundColor Cyan
Write-Host "  域名:     $Domain" -ForegroundColor White
Write-Host "  镜像:     $FullImage" -ForegroundColor White
Write-Host "  命名空间: document-flow" -ForegroundColor White
Write-Host ""

# ========== Step 2: 构建 Docker 镜像 ==========
Write-Host "[2/5] 构建 Docker 镜像..." -ForegroundColor Yellow
Push-Location $PSScriptRoot\..
try {
    docker build -t $FullImage .
    if ($LASTEXITCODE -ne 0) { throw "镜像构建失败" }
    Write-Host "[OK] 镜像构建完成: $FullImage" -ForegroundColor Green
} finally {
    Pop-Location
}

# ========== Step 3: 推送镜像 ==========
Write-Host "[3/5] 推送镜像到仓库..." -ForegroundColor Yellow
Push-Location $PSScriptRoot\..
try {
    docker push $FullImage
    if ($LASTEXITCODE -ne 0) { throw "镜像推送失败" }
    Write-Host "[OK] 镜像推送完成" -ForegroundColor Green
} finally {
    Pop-Location
}

# ========== Step 4: 更新 Kubernetes 部署 ==========
Write-Host "[4/5] 更新 Kubernetes 部署..." -ForegroundColor Yellow

# 更新 deployment image
kubectl set image deployment/document-flow-system `
    document-flow-system=$FullImage `
    -n document-flow

if ($LASTEXITCODE -ne 0) {
    Write-Host "[WARN] set image 失败，尝试 apply 方式..." -ForegroundColor Yellow
    # 生成临时 yaml 并 apply
    $yamlContent = @"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: document-flow-system
  namespace: document-flow
spec:
  replicas: 1
  selector:
    matchLabels:
      app: document-flow-system
  template:
    metadata:
      labels:
        app: document-flow-system
    spec:
      containers:
        - name: document-flow-system
          image: $FullImage
          imagePullPolicy: Always
          ports:
            - containerPort: 3000
          env:
            - name: NODE_ENV
              value: "production"
            - name: PORT
              value: "3000"
            - name: DATABASE_PATH
              value: "/app/data/document_flow.db"
            - name: FEISHU_APP_ID
              value: "cli_aaa152828fb95bda"
            - name: FEISHU_APP_SECRET
              value: "61tkmvxLdXZ2Tx0m4AgZFez4CC0xvzjx"
            - name: SILICONFLOW_API_KEY
              value: "sk-ananqfsipxweyiejefqltsbladjogmgnwfvxnihtjtnxwjem"
          volumeMounts:
            - name: data
              mountPath: /app/data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: document-flow-data
"@
    $yamlContent | kubectl apply -f -
}

Write-Host "[OK] Deployment 已更新" -ForegroundColor Green

# 更新 Ingress 域名
Write-Host "更新 Ingress 域名..." -ForegroundColor Gray
$ingressYaml = @"
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: document-flow-system
  namespace: document-flow
  annotations:
    kubernetes.io/ingress.class: "nginx"
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
spec:
  rules:
    - host: $Domain
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: document-flow-system
                port:
                  number: 80
"@
$ingressYaml | kubectl apply -f -
Write-Host "[OK] Ingress 域名已更新为: $Domain" -ForegroundColor Green

# ========== Step 5: 等待部署完成 ==========
Write-Host "[5/5] 等待部署完成..." -ForegroundColor Yellow
kubectl rollout status deployment/document-flow-system -n document-flow --timeout=300s

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  ✅ 部署完成！" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "🌐 访问地址: https://$Domain" -ForegroundColor White
Write-Host "🏥 健康检查: https://$Domain/health" -ForegroundColor White
Write-Host "🤖 AI 聊天:  https://$Domain/feishu-chat" -ForegroundColor White
Write-Host ""
Write-Host "📋 查看日志:" -ForegroundColor Yellow
Write-Host "   kubectl logs -f deployment/document-flow-system -n document-flow" -ForegroundColor Gray
Write-Host ""
Write-Host "🔍 飞书诊断:" -ForegroundColor Yellow
Write-Host "   查看日志中是否有 '[飞书] ✅ Tenant Token 获取成功'" -ForegroundColor Gray
Write-Host "   如果看到 '请检查 App ID 和 Secret'，说明飞书凭证有问题" -ForegroundColor Gray
Write-Host ""
