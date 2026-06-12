@echo off
cd /d D:\document-flow-system
echo Starting Document Flow System...
start /min node server-merged.js
timeout /t 5 /nobreak > nul
curl -s http://localhost:3000 > nul && echo Service is running on port 3000 || echo Service failed to start
pause
