@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "REBUILD_SCRIPT=%SCRIPT_DIR%clean-rebuild-all.bat"

if not exist "%REBUILD_SCRIPT%" (
  echo Missing rebuild script:
  echo   %REBUILD_SCRIPT%
  pause
  exit /b 1
)

call "%REBUILD_SCRIPT%" mts
exit /b %ERRORLEVEL%
