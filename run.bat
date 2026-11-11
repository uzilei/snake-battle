@echo off
rem Snake Battle launcher: double-click to start the server.
title Snake Battle
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 20 or newer from nodejs.org and try again.
  goto end
)

if not exist node_modules (
  echo Installing dependencies, first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    goto end
  )
)

node src\server\index.js

:end
echo.
pause
