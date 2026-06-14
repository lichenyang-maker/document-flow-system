@echo off
REM 公文流转 + AI 智能体系统 - 启动脚本（解决 Windows 中文乱码）
chcp 65001 >nul
set LANG=zh_CN.UTF-8
set LC_ALL=zh_CN.UTF-8
cd /d "%~dp0"
echo ========================================
echo    公文流转 + AI 智能体系统
echo    正在启动 (UTF-8 模式)...
echo ========================================
echo.
node server-sqlite.js
echo.
echo 服务已退出。按任意键关闭...
pause >nul
