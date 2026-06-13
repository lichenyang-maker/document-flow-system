@echo off
REM auto-push.bat - 自动检测文件变更并推送到 GitHub
REM 放到项目根目录，双击运行

cd /d %~dp0
echo 🚀 自动推送已启动（每30秒检测一次）
:loop
git add .
git diff --cached --quiet
if %errorlevel% equ 0 (
    timeout /t 30 /nobreak > nul
    goto loop
)
git commit -m "auto: %date% %time%"
git push origin main
echo [%time%] ✅ 已推送
timeout /t 30 /nobreak > nul
goto loop
