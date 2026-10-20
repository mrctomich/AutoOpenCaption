@echo off
title AutoOpenCaption
echo Starting AutoOpenCaption server...
echo.

REM Open the browser shortly after the server comes up (separate hidden
REM helper so it doesn't block the server starting below).
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8743"

REM Run the server as a foreground child of this console window: closing
REM this window (or Ctrl+C) terminates it, so no orphaned server is left
REM holding port 8743 for the next launch.
echo AutoOpenCaption will open at http://localhost:8743
echo Close this window to stop the server.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\serve.ps1"

echo.
echo AutoOpenCaption server stopped.
pause >nul
