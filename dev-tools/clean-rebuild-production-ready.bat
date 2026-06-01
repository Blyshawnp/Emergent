@echo off
setlocal EnableExtensions

rem Refresh production-ready from existing desktop outputs only.
rem This script must not rebuild frontend, backend.exe, or electron packages.
echo REFRESH PRODUCTION-READY ONLY FROM EXISTING DESKTOP BUILDS
echo.

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%clean-rebuild-production-ready.ps1"

if not exist "%PS_SCRIPT%" (
  echo Missing rebuild script:
  echo   %PS_SCRIPT%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
exit /b %ERRORLEVEL%
