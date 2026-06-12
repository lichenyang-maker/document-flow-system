@echo off
chcp 65001 > nul
echo ========================================
echo   MySQL Root密码重置脚本
echo ========================================
echo.

echo [1/5] 正在停止MySQL服务...
net stop MySQL /y >nul 2>&1
if %errorlevel% neq 0 (
    echo       服务已停止或需要管理员权限
)

echo.
echo [2/5] 正在以跳过权限模式启动MySQL...
start /b mysqld --skip-grant-tables --skip-networking --console >nul 2>&1 &

echo       等待MySQL启动（5秒）...
timeout /t 5 /nobreak > nul

echo.
echo [3/5] 正在重置密码为 123456 ...
"C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -e "FLUSH PRIVILEGES; ALTER USER 'root'@'localhost' IDENTIFIED BY '123456';" >nul 2>&1

if %errorlevel% equ 0 (
    echo       密码重置成功！
) else (
    echo       密码重置可能失败，继续尝试...
)

echo.
echo [4/5] 正在停止临时MySQL进程...
taskkill /F /IM mysqld.exe >nul 2>&1

echo.
echo [5/5] 正在重启MySQL服务...
net start MySQL >nul 2>&1

echo.
echo ========================================
echo   完成！
echo ========================================
echo.
echo 请关闭此窗口
pause > nul
