@echo off
chcp 65001 >nul
title Firewall rule for GOSUDARSTVO

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo [!] Run this file AS ADMINISTRATOR
  echo     ^(right click -^> Run as administrator^)
  echo.
  pause
  exit /b 1
)

netsh advfirewall firewall delete rule name="Gosudarstvo game 3000" >nul 2>&1
netsh advfirewall firewall add rule name="Gosudarstvo game 3000" dir=in action=allow protocol=TCP localport=3000 profile=any

echo.
echo Done. Port 3000 is now allowed for incoming connections.
echo.
pause
