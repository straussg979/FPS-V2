@echo off
rem COLD SECTOR launcher for Windows: double-click to check the setup, install what is missing, start the game
rem and open it in the browser. Close this window (or press Ctrl+C) to stop the server.
setlocal
cd /d "%~dp0"
title COLD SECTOR

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. COLD SECTOR needs Node.js 22 or newer.
  echo Opening the download page: install the LTS version, then start this file again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

node scripts\preflight.mjs --deps
if errorlevel 10 goto install
if errorlevel 1 goto failed
goto ready

:install
echo Installing dependencies (first start only, needs an internet connection)...
call npm.cmd install
if errorlevel 1 (
  echo npm install failed - see the messages above.
  goto failed
)
node scripts\preflight.mjs --deps
if errorlevel 1 goto failed

:ready
set "PORT="
for /f "usebackq delims=" %%p in (`node scripts\preflight.mjs --port`) do set "PORT=%%p"
if not defined PORT goto failed
echo.
echo Starting COLD SECTOR on http://127.0.0.1:%PORT%/  (the first start builds the game, about a minute)
start "" /b node scripts\preflight.mjs --open %PORT%
call npm.cmd start
echo.
echo COLD SECTOR has stopped.
pause
exit /b 0

:failed
echo.
echo COLD SECTOR could not start.
pause
exit /b 1
