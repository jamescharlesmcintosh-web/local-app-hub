@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Method POST -ContentType 'application/json' -Body '{}' http://127.0.0.1:8787/api/shutdown -TimeoutSec 2 | Out-Null; Write-Host 'Local App Hub stopped.' } catch { Write-Host 'Hub does not appear to be running.' }"
timeout /t 1 /nobreak >nul
