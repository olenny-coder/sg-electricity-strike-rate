@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=8791"
if not "%~1"=="" set "PORT=%~1"
set "URL=http://127.0.0.1:%PORT%"

echo.
echo  ===============================================
echo   Strike - Singapore Electricity Price Advisory
echo  ===============================================
echo.

rem --- Node present? -----------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo  [X] Node.js not found on PATH.
  echo      Strike needs Node 22.6 or newer ^(for node:sqlite^).
  echo      Install from https://nodejs.org and re-run this script.
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set "NODEV=%%v"
echo  [1/5] Node %NODEV%

rem --- Dependencies ------------------------------------------------------
if not exist "node_modules" (
  echo  [2/5] Installing server dependencies...
  call npm install || (echo  [X] npm install failed & exit /b 1)
) else (
  echo  [2/5] Server dependencies present
)

if not exist "web\node_modules" (
  echo        Installing client dependencies...
  call npm --prefix web install || (echo  [X] client install failed & exit /b 1)
)

rem --- Client build ------------------------------------------------------
if not exist "web\dist\index.html" (
  echo  [3/5] Building web client...
  call npm run build:web || (echo  [X] build failed & exit /b 1)
) else (
  echo  [3/5] Web client built
)

rem --- Data --------------------------------------------------------------
rem If the market dataset is empty the dashboard has nothing real to show, so
rem seed it. Tariff quarters come from EMA and are cheap to refresh.
if not exist "data\strike.db" (
  echo  [4/5] First run - ingesting real data ^(this takes a minute^)...
  call npm run sync:tariff
  call npm run sync -- --days 180
  call npm run seed
) else (
  echo  [4/5] Existing dataset found ^(skipping ingest^)
)

rem --- Stop anything already on the port --------------------------------
call npm run stop >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr ":%PORT% "') do (
  echo        Port %PORT% busy - stopping pid %%p
  taskkill /PID %%p /F >nul 2>&1
)

rem --- Launch ------------------------------------------------------------
echo  [5/5] Starting server...
start "Strike server" cmd /c "npm start"

echo.
echo  Waiting for %URL% ...
set "READY="
for /l %%i in (1,1,40) do (
  if not defined READY (
    curl -s -o nul -w "%%{http_code}" "%URL%/api/market/status" > "%TEMP%\strike_probe.txt" 2>nul
    set /p CODE=<"%TEMP%\strike_probe.txt"
    if "!CODE!"=="200" (
      set "READY=1"
    ) else (
      timeout /t 1 /nobreak >nul
    )
  )
)
del "%TEMP%\strike_probe.txt" >nul 2>&1

if defined READY (
  echo.
  echo  ===============================================
  echo   Strike is running:  %URL%
  echo  ===============================================
  echo.
  echo   The server is in the "Strike server" window.
  echo   Close that window or press Ctrl+C there to stop.
  echo.
  start "" "%URL%"
) else (
  echo.
  echo  [X] Server did not become ready in 40 seconds.
  echo      Check the "Strike server" window for the error.
  exit /b 1
)

endlocal
