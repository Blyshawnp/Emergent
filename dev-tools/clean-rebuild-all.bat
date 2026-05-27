@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ================================================================
rem  Clean rebuild and production-ready sync for:
rem    - Mock Testing Suite
rem    - SAM Smart Alert Manager
rem
rem  Usage:
rem    clean-rebuild-all.bat        Rebuild and sync both apps
rem    clean-rebuild-all.bat all    Rebuild and sync both apps
rem    clean-rebuild-all.bat mts    Rebuild and sync MTS only
rem    clean-rebuild-all.bat sam    Rebuild and sync SAM only
rem
rem  This script intentionally does NOT delete:
rem    - production-ready-backups
rem    - runtime config files
rem    - local SQLite/user data
rem ================================================================

set "MODE=%~1"
if "%MODE%"=="" set "MODE=all"
set "MODE=%MODE:"=%"

if /I not "%MODE%"=="all" if /I not "%MODE%"=="mts" if /I not "%MODE%"=="sam" (
  echo Invalid argument: %MODE%
  echo Usage: %~nx0 [all^|mts^|sam]
  exit /b 2
)

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"

set "FRONTEND_DIR=%ROOT_DIR%\frontend"
set "BACKEND_DIR=%ROOT_DIR%\backend"
set "DESKTOP_DIR=%ROOT_DIR%\desktop"
set "PROD_DIR=%ROOT_DIR%\production-ready"
set "MTS_PROD_DIR=%PROD_DIR%\Mock Testing Suite 1.0.1"
set "SAM_PROD_DIR=%PROD_DIR%\ADMIN ONLY - MTS Notification Manager 1.0.1"

set "MTS_DIST=%DESKTOP_DIR%\dist"
set "SAM_DIST=%DESKTOP_DIR%\dist-notification-manager"
set "MTS_INSTALLER=Mock Testing Suite Setup 1.0.1.exe"
set "SAM_INSTALLER=Sam Setup 1.0.1.exe"
set "SAM_LEGACY_INSTALLER=MTS Notification Manager Setup 1.0.1.exe"

if not exist "%ROOT_DIR%\dev-tools" mkdir "%ROOT_DIR%\dev-tools"
if not exist "%ROOT_DIR%\dev-tools\logs" mkdir "%ROOT_DIR%\dev-tools\logs"

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd-HHmmss"') do set "BUILD_STAMP=%%I"
if "%BUILD_STAMP%"=="" set "BUILD_STAMP=manual-run"
set "LOG_FILE=%ROOT_DIR%\dev-tools\logs\clean-rebuild-all-%BUILD_STAMP%.log"
set "START_TIME=%time%"
set "LAST_STEP=Startup"

call :section "CLEAN REBUILD ALL"
call :log "Mode: %MODE%"
call :log "Root: %ROOT_DIR%"
call :log "Log:  %LOG_FILE%"

call :section "VERIFYING TOOLCHAIN"
call :require_command node "Node.js was not found on PATH."
if errorlevel 1 goto :fail
call :require_command npm "npm was not found on PATH."
if errorlevel 1 goto :fail
call :require_command yarn "Yarn was not found on PATH."
if errorlevel 1 goto :fail
call :require_command powershell "Windows PowerShell was not found on PATH."
if errorlevel 1 goto :fail
call :require_command certutil "certutil was not found on PATH."
if errorlevel 1 goto :fail
call :require_command python "Python was not found on PATH."
if errorlevel 1 goto :fail

call :run "Node version" "node --version"
if errorlevel 1 goto :fail
call :run "npm version" "npm --version"
if errorlevel 1 goto :fail
call :run "Yarn version" "yarn --version"
if errorlevel 1 goto :fail
call :run "Python version" "python --version"
if errorlevel 1 goto :fail

call :section "STOPPING RUNNING PROCESSES"
call :kill_image "Mock Testing Suite.exe"
call :kill_image "Sam.exe"
call :kill_image "SAM.exe"
call :kill_image "backend.exe"
call :kill_image "electron.exe"
call :kill_image "makensis.exe"
call :kill_image "7za.exe"
call :kill_python_backends
call :log "Waiting for Windows file locks to release..."
timeout /t 4 /nobreak >nul

call :section "CLEANING OLD BUILDS"
call :safe_remove_dir "%FRONTEND_DIR%\build"
if errorlevel 1 goto :fail
call :safe_remove_dir "%BACKEND_DIR%\build"
if errorlevel 1 goto :fail
call :safe_remove_dir "%BACKEND_DIR%\dist"
if errorlevel 1 goto :fail
call :safe_remove_dir "%DESKTOP_DIR%\dist"
if errorlevel 1 goto :fail
call :safe_remove_dir "%DESKTOP_DIR%\dist-notification-manager"
if errorlevel 1 goto :fail
call :safe_remove_dir "%DESKTOP_DIR%\release"
if errorlevel 1 goto :fail
call :safe_remove_dir "%ROOT_DIR%\build"
if errorlevel 1 goto :fail
call :safe_remove_dir "%ROOT_DIR%\dist"
if errorlevel 1 goto :fail
call :safe_remove_dir "%ROOT_DIR%\release"
if errorlevel 1 goto :fail

call :section "REBUILDING FRONTEND"
pushd "%DESKTOP_DIR%" || goto :pushd_fail
call :run "npm run build:react" "npm run build:react"
set "BUILD_RC=%errorlevel%"
popd
if not "%BUILD_RC%"=="0" goto :fail
if not exist "%FRONTEND_DIR%\build\index.html" (
  call :log "ERROR: frontend\build\index.html was not generated."
  set "LAST_STEP=Verify frontend build output: %FRONTEND_DIR%\build\index.html"
  goto :fail
)

call :section "REBUILDING BACKEND"
pushd "%DESKTOP_DIR%" || goto :pushd_fail
call :run "npm run build:backend" "npm run build:backend"
set "BUILD_RC=%errorlevel%"
popd
if not "%BUILD_RC%"=="0" goto :fail
if not exist "%BACKEND_DIR%\dist\backend.exe" (
  call :log "ERROR: backend\dist\backend.exe was not generated."
  set "LAST_STEP=Verify backend build output: %BACKEND_DIR%\dist\backend.exe"
  goto :fail
)

if /I "%MODE%"=="sam" goto :package_sam

call :section "PACKAGING MOCK TESTING SUITE"
pushd "%DESKTOP_DIR%" || goto :pushd_fail
call :run "npx electron-builder --win --x64" "npx electron-builder --win --x64"
set "BUILD_RC=%errorlevel%"
popd
if not "%BUILD_RC%"=="0" goto :fail
if not exist "%MTS_DIST%\win-unpacked\Mock Testing Suite.exe" (
  call :log "ERROR: MTS win-unpacked executable was not generated."
  set "LAST_STEP=Verify MTS executable: %MTS_DIST%\win-unpacked\Mock Testing Suite.exe"
  goto :fail
)
if not exist "%MTS_DIST%\%MTS_INSTALLER%" (
  call :log "ERROR: MTS installer was not generated: %MTS_DIST%\%MTS_INSTALLER%"
  set "LAST_STEP=Verify MTS installer: %MTS_DIST%\%MTS_INSTALLER%"
  goto :fail
)

if /I "%MODE%"=="mts" goto :sync_outputs

:package_sam
call :section "PACKAGING SAM SMART ALERT MANAGER"
pushd "%DESKTOP_DIR%" || goto :pushd_fail
call :run "npx electron-builder --win --x64 --config notification-manager-builder.json" "npx electron-builder --win --x64 --config notification-manager-builder.json"
set "BUILD_RC=%errorlevel%"
popd
if not "%BUILD_RC%"=="0" goto :fail
if not exist "%SAM_DIST%\win-unpacked\Sam.exe" (
  call :log "ERROR: SAM win-unpacked executable was not generated."
  set "LAST_STEP=Verify SAM executable: %SAM_DIST%\win-unpacked\Sam.exe"
  goto :fail
)
if not exist "%SAM_DIST%\%SAM_INSTALLER%" (
  call :log "ERROR: SAM installer was not generated: %SAM_DIST%\%SAM_INSTALLER%"
  set "LAST_STEP=Verify SAM installer: %SAM_DIST%\%SAM_INSTALLER%"
  goto :fail
)

:sync_outputs
call :section "SYNCING PRODUCTION-READY"
if /I "%MODE%"=="sam" goto :sync_sam_only

call :sync_dir "%MTS_DIST%\win-unpacked" "%MTS_PROD_DIR%\win-unpacked"
if errorlevel 1 goto :fail
call :copy_file "%MTS_DIST%\%MTS_INSTALLER%" "%MTS_PROD_DIR%\%MTS_INSTALLER%"
if errorlevel 1 goto :fail
call :copy_file "%MTS_DIST%\%MTS_INSTALLER%.blockmap" "%MTS_PROD_DIR%\%MTS_INSTALLER%.blockmap"
if errorlevel 1 goto :fail
call :write_hash "%MTS_PROD_DIR%\%MTS_INSTALLER%" "%MTS_PROD_DIR%\MAIN-APP-HASH.txt" "Mock Testing Suite Setup 1.0.1.exe"
if errorlevel 1 goto :fail

if /I "%MODE%"=="mts" goto :verify_outputs

:sync_sam_only
call :sync_dir "%SAM_DIST%\win-unpacked" "%SAM_PROD_DIR%\notification-manager-win-unpacked"
if errorlevel 1 goto :fail
call :copy_file "%SAM_DIST%\%SAM_INSTALLER%" "%SAM_PROD_DIR%\%SAM_INSTALLER%"
if errorlevel 1 goto :fail
call :copy_file "%SAM_DIST%\%SAM_INSTALLER%.blockmap" "%SAM_PROD_DIR%\%SAM_INSTALLER%.blockmap"
if errorlevel 1 goto :fail
call :copy_file "%SAM_DIST%\%SAM_INSTALLER%" "%SAM_PROD_DIR%\%SAM_LEGACY_INSTALLER%"
if errorlevel 1 goto :fail
call :copy_file "%SAM_DIST%\%SAM_INSTALLER%.blockmap" "%SAM_PROD_DIR%\%SAM_LEGACY_INSTALLER%.blockmap"
if errorlevel 1 goto :fail
call :write_hash "%SAM_PROD_DIR%\%SAM_INSTALLER%" "%SAM_PROD_DIR%\NOTIFICATION-MANAGER-HASH.txt" "Sam Setup 1.0.1.exe"
if errorlevel 1 goto :fail

:verify_outputs
call :section "VERIFYING OUTPUT HASHES"
if /I not "%MODE%"=="sam" (
  call :compare_hash "%MTS_DIST%\win-unpacked\resources\app.asar" "%MTS_PROD_DIR%\win-unpacked\resources\app.asar" "MTS app.asar"
  if errorlevel 1 goto :fail
  call :compare_hash "%BACKEND_DIR%\dist\backend.exe" "%MTS_PROD_DIR%\win-unpacked\resources\backend\backend.exe" "MTS backend.exe"
  if errorlevel 1 goto :fail
  call :compare_hash "%MTS_DIST%\%MTS_INSTALLER%" "%MTS_PROD_DIR%\%MTS_INSTALLER%" "MTS installer"
  if errorlevel 1 goto :fail
)
if /I not "%MODE%"=="mts" (
  call :compare_hash "%SAM_DIST%\win-unpacked\resources\app.asar" "%SAM_PROD_DIR%\notification-manager-win-unpacked\resources\app.asar" "SAM app.asar"
  if errorlevel 1 goto :fail
  call :compare_hash "%BACKEND_DIR%\dist\backend.exe" "%SAM_PROD_DIR%\notification-manager-win-unpacked\resources\backend\backend.exe" "SAM backend.exe"
  if errorlevel 1 goto :fail
  call :compare_hash "%SAM_DIST%\%SAM_INSTALLER%" "%SAM_PROD_DIR%\%SAM_INSTALLER%" "SAM installer"
  if errorlevel 1 goto :fail
)

call :section "SUCCESS"
call :log "Build timestamp: %date% %time%"
call :log "Started at:       %START_TIME%"
if /I not "%MODE%"=="sam" (
  call :log "MTS installer:    %MTS_PROD_DIR%\%MTS_INSTALLER%"
  call :log "MTS unpacked:     %MTS_PROD_DIR%\win-unpacked"
)
if /I not "%MODE%"=="mts" (
  call :log "SAM installer:    %SAM_PROD_DIR%\%SAM_INSTALLER%"
  call :log "SAM unpacked:     %SAM_PROD_DIR%\notification-manager-win-unpacked"
)
call :log "Production-ready update complete."
call :log "Log file: %LOG_FILE%"
exit /b 0

:section
echo.
echo ==================================
echo %~1
echo ==================================
>>"%LOG_FILE%" echo.
>>"%LOG_FILE%" echo ==================================
>>"%LOG_FILE%" echo %~1
>>"%LOG_FILE%" echo ==================================
exit /b 0

:log
echo %~1
>>"%LOG_FILE%" echo [%date% %time%] %~1
exit /b 0

:require_command
where %~1 >nul 2>nul
if errorlevel 1 (
  call :log "ERROR: %~2"
  exit /b 1
)
call :log "Found %~1"
exit /b 0

:run
set "RUN_LABEL=%~1"
set "RUN_CMD=%~2"
set "LAST_STEP=%RUN_LABEL% :: %RUN_CMD%"
call :log "Running: %RUN_LABEL%"
call :log "Command: %RUN_CMD%"
>>"%LOG_FILE%" echo ---- %RUN_LABEL% ----
>>"%LOG_FILE%" echo Command: %RUN_CMD%
cmd /d /s /c "%RUN_CMD%" >>"%LOG_FILE%" 2>&1
set "RUN_RC=%errorlevel%"
if not "%RUN_RC%"=="0" (
  call :log "ERROR: %RUN_LABEL% failed with exit code %RUN_RC%."
  call :log "Failed command: %RUN_CMD%"
  call :log "See log for details: %LOG_FILE%"
  exit /b %RUN_RC%
)
call :log "OK: %RUN_LABEL%"
exit /b 0

:kill_image
taskkill /f /im "%~1" >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
  call :log "%~1 not running."
) else (
  call :log "%~1 terminated."
)
exit /b 0

:kill_python_backends
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"name = 'python.exe'\" | Where-Object { $_.CommandLine -match 'uvicorn server:app|backend\\server.py|packaged_backend.py|APP-main\\backend' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output ('python backend process terminated: ' + $_.ProcessId) } catch { Write-Output ('unable to terminate python process: ' + $_.ProcessId + ' ' + $_.Exception.Message) } }" >>"%LOG_FILE%" 2>&1
call :log "Checked for local backend Python processes."
exit /b 0

:safe_remove_dir
set "TARGET=%~1"
if "%TARGET%"=="" exit /b 0
if /I "%TARGET%"=="%ROOT_DIR%" (
  call :log "ERROR: refusing to remove project root."
  exit /b 1
)
echo "%TARGET%" | findstr /I "production-ready-backups" >nul
if not errorlevel 1 (
  call :log "ERROR: refusing to remove backup path: %TARGET%"
  exit /b 1
)
if exist "%TARGET%" (
  call :log "Removing: %TARGET%"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%TARGET%'; if(Test-Path -LiteralPath $p){ Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Attributes='Normal' } catch {} }; Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop }" >>"%LOG_FILE%" 2>&1
  if errorlevel 1 (
    call :log "ERROR: failed to remove %TARGET%. A file may still be locked."
    exit /b 1
  )
) else (
  call :log "Not present, skipping: %TARGET%"
)
exit /b 0

:sync_dir
set "SRC=%~1"
set "DST=%~2"
if not exist "%SRC%" (
  call :log "ERROR: sync source missing: %SRC%"
  exit /b 1
)
echo "%DST%" | findstr /I "production-ready-backups" >nul
if not errorlevel 1 (
  call :log "ERROR: refusing to sync into backup path: %DST%"
  exit /b 1
)
call :log "Syncing directory: %SRC% -> %DST%"
call :log "Preserving protected runtime credential files: google-service-account.json, service-account.json"
if not exist "%DST%\.." mkdir "%DST%\.." >nul 2>nul
set "PRESERVE_DIR=%TEMP%\mts-sync-preserve-%RANDOM%%RANDOM%"
mkdir "%PRESERVE_DIR%" >nul 2>nul
if exist "%DST%\resources\backend\config\google-service-account.json" copy /y "%DST%\resources\backend\config\google-service-account.json" "%PRESERVE_DIR%\google-service-account.json" >>"%LOG_FILE%" 2>&1
if exist "%DST%\resources\backend\config\service-account.json" copy /y "%DST%\resources\backend\config\service-account.json" "%PRESERVE_DIR%\service-account.json" >>"%LOG_FILE%" 2>&1
robocopy "%SRC%" "%DST%" /MIR /XD ".git" ".pytest_cache" "node_modules" "production-ready-backups" /XF google-service-account.json service-account.json "*.tmp" "*.temp" /R:2 /W:2 /NFL /NDL /NP /NJH /NJS >>"%LOG_FILE%" 2>&1
set "ROBO_RC=%errorlevel%"
if %ROBO_RC% GEQ 8 (
  call :log "ERROR: robocopy failed with code %ROBO_RC%."
  exit /b 1
)
if not exist "%DST%\resources\backend\config" mkdir "%DST%\resources\backend\config" >nul 2>nul
if exist "%PRESERVE_DIR%\google-service-account.json" (
  copy /y "%PRESERVE_DIR%\google-service-account.json" "%DST%\resources\backend\config\google-service-account.json" >>"%LOG_FILE%" 2>&1
) else if exist "%SRC%\resources\backend\config\google-service-account.json" (
  copy /y "%SRC%\resources\backend\config\google-service-account.json" "%DST%\resources\backend\config\google-service-account.json" >>"%LOG_FILE%" 2>&1
)
if exist "%PRESERVE_DIR%\service-account.json" (
  copy /y "%PRESERVE_DIR%\service-account.json" "%DST%\resources\backend\config\service-account.json" >>"%LOG_FILE%" 2>&1
) else if exist "%SRC%\resources\backend\config\service-account.json" (
  copy /y "%SRC%\resources\backend\config\service-account.json" "%DST%\resources\backend\config\service-account.json" >>"%LOG_FILE%" 2>&1
)
if exist "%PRESERVE_DIR%" rmdir /s /q "%PRESERVE_DIR%" >nul 2>nul
exit /b 0

:copy_file
set "SRC_FILE=%~1"
set "DST_FILE=%~2"
if not exist "%SRC_FILE%" (
  call :log "ERROR: file missing: %SRC_FILE%"
  exit /b 1
)
if not exist "%~dp2" mkdir "%~dp2" >nul 2>nul
copy /y "%SRC_FILE%" "%DST_FILE%" >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
  call :log "ERROR: failed to copy %SRC_FILE% -> %DST_FILE%"
  exit /b 1
)
call :log "Copied: %DST_FILE%"
exit /b 0

:write_hash
set "HASH_SOURCE=%~1"
set "HASH_FILE=%~2"
set "HASH_LABEL=%~3"
call :sha256_file "%HASH_SOURCE%" HASH_VALUE
if errorlevel 1 (
  call :log "ERROR: failed to write hash file: %HASH_FILE%"
  exit /b 1
)
>"%HASH_FILE%" echo %HASH_LABEL% SHA256: !HASH_VALUE!
call :log "Hash updated: %HASH_FILE%"
exit /b 0

:compare_hash
set "HASH_LEFT=%~1"
set "HASH_RIGHT=%~2"
set "HASH_NAME=%~3"
call :sha256_file "%HASH_LEFT%" HASH_LEFT_VALUE
if errorlevel 1 (
  call :log "ERROR: failed to hash source for %HASH_NAME%: %HASH_LEFT%"
  exit /b 1
)
call :sha256_file "%HASH_RIGHT%" HASH_RIGHT_VALUE
if errorlevel 1 (
  call :log "ERROR: failed to hash destination for %HASH_NAME%: %HASH_RIGHT%"
  exit /b 1
)
if /I not "!HASH_LEFT_VALUE!"=="!HASH_RIGHT_VALUE!" (
  >>"%LOG_FILE%" echo HASH MISMATCH: %HASH_NAME%
  >>"%LOG_FILE%" echo Source:      !HASH_LEFT_VALUE!
  >>"%LOG_FILE%" echo Destination: !HASH_RIGHT_VALUE!
  call :log "ERROR: hash mismatch for %HASH_NAME%."
  exit /b 1
)
>>"%LOG_FILE%" echo %HASH_NAME% match: !HASH_LEFT_VALUE:~0,16!
call :log "Verified: %HASH_NAME%"
exit /b 0

:sha256_file
set "SHA_SOURCE=%~1"
set "SHA_RETURN_VAR=%~2"
set "SHA_VALUE="
if not exist "%SHA_SOURCE%" (
  call :log "ERROR: hash source missing: %SHA_SOURCE%"
  exit /b 1
)
for /f "skip=1 tokens=* delims=" %%H in ('certutil -hashfile "%SHA_SOURCE%" SHA256') do (
  if not defined SHA_VALUE set "SHA_VALUE=%%H"
)
set "SHA_VALUE=!SHA_VALUE: =!"
if "!SHA_VALUE!"=="" (
  call :log "ERROR: unable to calculate SHA256 for %SHA_SOURCE%"
  exit /b 1
)
set "%SHA_RETURN_VAR%=!SHA_VALUE!"
exit /b 0

:pushd_fail
call :log "ERROR: unable to open required directory."
goto :fail

:fail
call :section "BUILD FAILED"
call :log "The rebuild stopped before completion."
call :log "Last step: %LAST_STEP%"
call :log "Check the log for details: %LOG_FILE%"
exit /b 1
