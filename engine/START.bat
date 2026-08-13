@echo off
title FounderFlow Engine
cd /d "%~dp0"

:: ── First run detection ──────────────────────────────
if not exist "node_modules" goto :first_time
if not exist "sessions\Default" goto :first_time

:: ── Normal run — launch hidden (no terminal) ─────────
if exist "%~dp0node.cmd" (
  powershell -WindowStyle Hidden -Command "Start-Process '%~dp0node.cmd' -ArgumentList 'start.cjs','auto' -WindowStyle Hidden"
  exit /b
)
if exist "%~dp0portable-node\node.exe" (
  powershell -WindowStyle Hidden -Command "Start-Process '%~dp0portable-node\node.exe' -ArgumentList 'start.cjs','auto' -WindowStyle Hidden"
  exit /b
)
powershell -WindowStyle Hidden -Command "Start-Process node -ArgumentList 'start.cjs','auto' -WindowStyle Hidden"
exit /b

:first_time
echo ╔══════════════════════════════════════════════════════════╗
echo ║              FounderFlow Engine                          ║
echo ║                                                          ║
echo ║  Double-click START.hta for the GUI setup wizard         ║
echo ║  (recommended — no terminal needed)                      ║
echo ║                                                          ║
echo ║  Using this terminal instead? Continuing...              ║
echo ╚══════════════════════════════════════════════════════════╝
echo.
if exist "%~dp0node.cmd" ( "%~dp0node.cmd" start.cjs auto
) else if exist "%~dp0portable-node\node.exe" ( "%~dp0portable-node\node.exe" start.cjs auto
) else ( node start.cjs auto )
if %ERRORLEVEL% EQU 0 (
  copy "%~dp0START.vbs" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\FounderFlow Engine.vbs" >nul
  echo ✅ Setup complete! Engine registered to auto-start.
) else (
  echo.
  echo ⛔ Setup exited with code %ERRORLEVEL%
  pause
)
