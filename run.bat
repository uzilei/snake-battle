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

rem Restart the server whenever it exits (a crash, or a start-up error such as
rem the port being busy), after a short delay. Each restart is also appended
rem to server-restarts.log. Close this window or press Ctrl+C to stop.
:run
node src\server\index.js
set EXITCODE=%errorlevel%
echo.
echo [%date% %time%] Server stopped (exit code %EXITCODE%), restarting in 3 seconds. Ctrl+C to stop.
>>server-restarts.log echo [%date% %time%] Server stopped (exit code %EXITCODE%), restarting
rem ping waits ~3 s even without an interactive console (timeout would not).
ping -n 4 127.0.0.1 >nul
goto run

:end
echo.
pause
