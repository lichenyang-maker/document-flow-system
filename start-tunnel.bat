@echo off
cd /d D:\document-flow-system
echo Starting Document Flow System on port 3000...
start /b node server-merged.js
timeout /t 3 /nobreak > nul
echo.
echo Starting Cloudflare Tunnel...
D:\tools\cloudflared.exe tunnel --url http://localhost:3000
