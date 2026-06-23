@echo off
setlocal EnableExtensions

rem Legacy entry point retained for users who already have this shortcut.
rem The maintained rebuild/sync pipeline is clean-rebuild-all.bat.

set "SCRIPT_DIR=%~dp0"
set "REBUILD_SCRIPT=%SCRIPT_DIR%clean-rebuild-all.bat"

if not exist "%REBUILD_SCRIPT%" (
  echo Missing rebuild script:
  echo   %REBUILD_SCRIPT%
  pause
  exit /b 1
)

echo ===============================================
echo   Mock Testing Suite - Full Clean Rebuild
echo ===============================================
echo.
echo This legacy script now delegates to:
echo   %REBUILD_SCRIPT%
echo.
echo The maintained script builds MTS and SAM, copies runtime config,
echo verifies packaged Apps Script API config without printing secret values,
echo syncs production-ready, and writes hashes.
echo.

call "%REBUILD_SCRIPT%" all
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo Full clean rebuild failed. See the clean-rebuild-all log above.
  pause
  exit /b %RC%
)

echo.
echo Full clean rebuild complete.
pause
exit /b 0
