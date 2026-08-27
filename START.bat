@echo off
chcp 65001 >nul
title GOSUDARSTVO - game server
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [!] Node.js not found. Install it from https://nodejs.org  ^(LTS^)
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, please wait...
  call npm install --no-audit --no-fund
)

echo.
echo Starting server... ^(close this window to stop the game^)
echo.
node server\index.js

echo.
echo Server stopped.
pause
