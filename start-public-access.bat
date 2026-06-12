@echo off
echo Starting Document Flow System...
cd /d D:\document-flow-system
start /min node server-merged.js
timeout /t 3 /nobreak > nul

echo.
echo Starting Ngrok Tunnel...
start /min D:\tools\ngrok.exe http 3000

echo.
echo Waiting for ngrok to start...
timeout /t 5 /nobreak > nul

echo.
echo Getting public URL...
curl -s http://localhost:4040/api/tunnels > "%TEMP%\ngrok_info.json"
powershell -Command "$j = Get-Content '%TEMP%\ngrok_info.json' | ConvertFrom-Json; $j.tunnels[0].public_url" > "%TEMP%\ngrok_url.txt"
set /p NGROK_URL= < "%TEMP%\ngrok_url.txt"

echo.
echo ========================================
echo Public URL: %NGROK_URL%
echo ========================================
echo.
echo Share this URL with others to access your system!
echo.
echo Login credentials:
echo   Admin: admin / admin123
echo   User:  zhangsan / 123456
echo.
pause
