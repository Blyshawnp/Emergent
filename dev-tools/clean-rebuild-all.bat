@echo off
setlocal EnableExtensions

rem Full clean rebuild of everything: frontend, backend.exe, both desktop packages,
rem and production-ready output. Use this when you want a complete release refresh.
echo FULL CLEAN REBUILD INCLUDING PRODUCTION-READY
echo.

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%clean-rebuild-all.ps1"

if not exist "%PS_SCRIPT%" (
  echo Missing rebuild script:
  echo   %PS_SCRIPT%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -Mode "%~1"
exit /b %ERRORLEVEL%
