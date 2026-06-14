# UTF-8 启动脚本（PowerShell）
# 解决 Windows 控制台中文乱码问题

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:LANG = "zh_CN.UTF-8"
$env:LC_ALL = "zh_CN.UTF-8"
$OutputEncoding = [System.Text.Encoding]::UTF8

# 切换代码页为 UTF-8 (65001)
& chcp 65001 | Out-Null

Write-Host "========================================"
Write-Host "   公文流转 + AI 智能体系统"
Write-Host "   正在启动 (UTF-8 模式)..."
Write-Host "========================================"
Write-Host ""

Set-Location $PSScriptRoot
& node server-sqlite.js
