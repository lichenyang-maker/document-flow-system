param(
    [string]$ImageRegistry = "your-registry",
    [string]$ImageName = "document-flow-system",
    [string]$ImageTag = "latest"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  构建 Docker 镜像" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "镜像仓库: $ImageRegistry"
Write-Host "镜像名称: $ImageName"
Write-Host "镜像标签: $ImageTag"
Write-Host ""

$FullImage = "$ImageRegistry/$ImageName`:$ImageTag"

Write-Host "步骤 1: 构建镜像..." -ForegroundColor Yellow
docker build -t $FullImage .
if ($LASTEXITCODE -ne 0) { throw "镜像构建失败" }
Write-Host "[OK] 镜像构建完成: $FullImage" -ForegroundColor Green
Write-Host ""

Write-Host "步骤 2: 测试镜像本地运行..." -ForegroundColor Yellow
$containerId = docker run -d --name docflow-test -p 3000:3000 $FullImage
if ($LASTEXITCODE -ne 0) { throw "容器启动失败" }

Write-Host "等待容器启动..."
Start-Sleep -Seconds 8

try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/health" -UseBasicParsing -TimeoutSec 10
    if ($response.Content -match "ok") {
        Write-Host "[OK] 健康检查通过" -ForegroundColor Green
    } else {
        Write-Warning "健康检查响应异常: $($response.Content)"
    }
} catch {
    Write-Warning "健康检查失败: $_"
}

Write-Host ""
Write-Host "步骤 3: 停止测试容器..." -ForegroundColor Yellow
docker stop docflow-test 2>$null | Out-Null
docker rm docflow-test 2>$null | Out-Null
Write-Host ""

Write-Host "步骤 4: 推送镜像到仓库..." -ForegroundColor Yellow
docker push $FullImage
if ($LASTEXITCODE -ne 0) { throw "镜像推送失败" }
Write-Host ""
Write-Host "[OK] 镜像推送完成: $FullImage" -ForegroundColor Green
Write-Host ""

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  镜像准备完成" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步: 部署到 sealos" -ForegroundColor Yellow
Write-Host "请更新 sealos/deployment.yaml 中的 image 字段为: $FullImage"
Write-Host ""
