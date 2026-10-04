@echo off
REM ---------------------------------------------------------------------------
REM Manual fallback for the instructor app's firewall rules.
REM
REM The app can do this from its "Allow phones to connect" button; run this
REM script instead if you prefer not to click, or if the button reports a
REM failure. Rule names and ports must stay in step with src/shared/types.ts
REM (FIRST_PORT / MAX_PORT) and src/main/firewall.ts.
REM
REM Run as Administrator: right-click -> Run as administrator.
REM ---------------------------------------------------------------------------

setlocal

REM Must be run elevated to add firewall rules.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo This script needs Administrator rights.
  echo Right-click it and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo Adding firewall rules...
echo.

REM Inbound TCP for the quiz server. The range covers every port the server
REM can bind: it starts at 8080 and walks up to 8089 if a port is taken.
netsh advfirewall firewall add rule name="Quiz LAN Server" dir=in action=allow protocol=TCP localport=8080-8089 profile=any

REM Inbound UDP 5353 for mDNS discovery (phones browsing for the app).
netsh advfirewall firewall add rule name="Quiz LAN Discovery" dir=in action=allow protocol=UDP localport=5353 profile=any

echo.
echo Done. Check the rules with:
echo   netsh advfirewall firewall show rule name="Quiz LAN Server"
echo   netsh advfirewall firewall show rule name="Quiz LAN Discovery"
echo.
echo To remove them later:
echo   netsh advfirewall firewall delete rule name="Quiz LAN Server"
echo   netsh advfirewall firewall delete rule name="Quiz LAN Discovery"
echo.
pause