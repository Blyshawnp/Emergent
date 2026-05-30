@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%clean-rebuild-desktop-only.ps1"

if not exist "%PS_SCRIPT%" (
  echo Missing rebuild script:
  echo   %PS_SCRIPT%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
exit /b %ERRORLEVEL%
