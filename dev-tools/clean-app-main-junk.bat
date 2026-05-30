@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%clean-app-main-junk.ps1"

if not exist "%PS_SCRIPT%" (
  echo Missing cleanup script:
  echo   %PS_SCRIPT%
  exit /b 1
)

set "DRY_RUN_ARG="
if "%~1"=="--dry-run" (
  set "DRY_RUN_ARG=-DryRun"
) else if "%~1"=="-dry-run" (
  set "DRY_RUN_ARG=-DryRun"
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %DRY_RUN_ARG%
exit /b %ERRORLEVEL%
