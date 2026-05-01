@echo off
setlocal

echo Stopping Mock Testing Suite dev environment...
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8600" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
)

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
)

taskkill /IM electron.exe /F >nul 2>&1
taskkill /IM node.exe /F >nul 2>&1
taskkill /IM python.exe /F >nul 2>&1

echo Stop commands sent.
echo.
pause
