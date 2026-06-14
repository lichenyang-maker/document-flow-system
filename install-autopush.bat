@echo off
chcp 65001 >nul
cd /d %~dp0
echo ========================================
echo  自动推送 - 安装计划任务
echo ========================================
echo.

REM 检查是否以管理员运行
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 请右键 → "以管理员身份运行" 本脚本
    pause
    exit /b 1
)

echo ✅ 管理员权限检测通过
echo.

REM 卸载旧任务（如果有）
schtasks /delete /tn "DocumentFlowAutoPush" /f >nul 2>&1

REM 创建开机自启的计划任务
schtasks /create /tn "DocumentFlowAutoPush" /tr "powershell.exe -NoLogo -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%~dp0auto-push.ps1\"" /sc onlogon /ru "%USERDOMAIN%\%USERNAME%" /rl limited /f

if %errorlevel% equ 0 (
    echo ✅ 计划任务安装成功！
    echo.
    echo   📌 每次开机登录时自动启动
    echo   📁 日志文件: %~dp0auto-push.log
    echo.
    echo   🔄 也可以手动启动:
    echo      powershell -ExecutionPolicy Bypass -File "%~dp0auto-push.ps1"
    echo.
    echo   ❌ 卸载命令:
    echo      schtasks /delete /tn "DocumentFlowAutoPush" /f
) else (
    echo ❌ 安装失败（错误码: %errorlevel%）
)

echo.
pause
