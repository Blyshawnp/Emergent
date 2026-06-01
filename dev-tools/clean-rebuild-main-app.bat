@echo off
setlocal EnableExtensions

rem Clean rebuild desktop outputs only: frontend, backend.exe, MTS desktop,
rem and SAM desktop. This script must not delete, sync, or update production-ready.
echo CLEAN REBUILD MAIN APP DESKTOP OUTPUTS ONLY, PRODUCTION-READY NOT TOUCHED
echo.

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%clean-rebuild-main-app.ps1"

if not exist "%PS_SCRIPT%" (
  echo Missing rebuild script:
  echo   %PS_SCRIPT%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
exit /b %ERRORLEVEL%
