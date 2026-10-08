@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Local App Hub needs Node.js because your localhost projects are Node-based.
  echo Node was not found on PATH.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787 -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }"
if not errorlevel 1 (
  start "" http://localhost:8787
  exit /b 0
)

start "Local App Hub" /min cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" http://localhost:8787
exit /b 0
