@echo off
setlocal

set "ROOT=%~dp0"

echo Starting Mock Testing Suite dev environment...
echo.

start "MTS Backend" powershell -NoExit -Command "Set-Location '%ROOT%backend'; python -m uvicorn server:app --host 127.0.0.1 --port 8600 --reload"
start "MTS Frontend" cmd /k "cd /d "%ROOT%frontend" && yarn start"

timeout /t 5 /nobreak >nul

start "MTS Desktop" cmd /k "cd /d "%ROOT%desktop" && npm start"

echo Opened backend, frontend, and desktop windows.
echo If a window fails immediately, install dependencies in that project first.
echo.
pause
