@echo off
chcp 65001 > nul
echo ================================
echo  启动公文流转系统 + 公网隧道
echo ================================
echo.

echo [1/3] 检查本地服务...
netstat -ano | findstr :3000 > nul
if %ERRORLEVEL% EQU 0 (
    echo ✓ 服务已在端口 3000 运行
) else (
    echo ✗ 服务未运行，正在启动...
    cd /d D:\document-flow-system
    start /min node server-merged.js
    timeout /t 3 /nobreak > nul
)

echo.
echo [2/3] 启动 ngrok 隧道...
taskkill /f /im ngrok.exe > nul 2>&1
start "ngrok" /min D:\tools\ngrok.exe http 3000

echo.
echo [3/3] 获取公网地址...
timeout /t 5 /nobreak > nul

echo.
echo ========================================
echo  公网访问地址：
echo ========================================
echo.

curl -s http://localhost:4040/api/tunnels > "%TEMP%\ngrok_tunnels.json" 2> nul
powershell -NoProfile -Command "$j = Get-Content '%TEMP%\ngrok_tunnels.json' -Raw | ConvertFrom-Json; if($j.tunnels.Count -gt 0){ Write-Host $j.tunnels[0].public_url } else { Write-Host '等待 ngrok 启动...'; Start-Sleep -Seconds 3; $j2 = Get-Content '%TEMP%\ngrok_tunnels.json' -Raw | ConvertFrom-Json; Write-Host $j2.tunnels[0].public_url }"

echo.
echo ========================================
echo  登录账号：
echo    - 管理员：admin / admin123
echo    - 普通用户：张三 / 123456
echo ========================================
echo.
echo 提示：ngrok 窗口已在后台运行，关闭窗口会断开公网访问
echo.
pause
