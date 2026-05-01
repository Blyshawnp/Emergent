@echo off
setlocal EnableExtensions

net session >nul 2>&1
set "IS_ADMIN=0"
if not errorlevel 1 set "IS_ADMIN=1"

set "ROOT_DIR=%~dp0.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"

set "APP_EXE=%ROOT_DIR%\desktop\dist\win-unpacked\Mock Testing Suite.exe"
set "PACKAGED_USERDATA_DIR=%APPDATA%\mock-testing-suite"
set "PACKAGED_DB_DIR=%PACKAGED_USERDATA_DIR%\mongodb-data"
set "PACKAGED_LOCAL_STORAGE_DIR=%PACKAGED_USERDATA_DIR%\Local Storage"
set "PACKAGED_SESSION_STORAGE_DIR=%PACKAGED_USERDATA_DIR%\Session Storage"
set "DEV_DB_DIR=%ROOT_DIR%\backend\mongodb\data\mock_testing_suite"
set "WIN_UNPACKED_DIR=%ROOT_DIR%\desktop\dist\win-unpacked"

:menu
cls
echo ===============================================
echo   Mock Testing Suite - Developer Reset Utility
echo ===============================================
echo.
echo   1. Reset only
echo   2. Reset + Launch packaged app
echo   3. Reset + Rebuild + Launch packaged app
echo   4. Exit
echo.
choice /C 1234 /N /M "Select an option: "

if errorlevel 4 goto :exit_script
if errorlevel 3 goto :reset_rebuild_launch
if errorlevel 2 goto :reset_launch
if errorlevel 1 goto :reset_only
goto :invalid_choice

:reset_only
call :run_reset
goto :finish

:reset_launch
call :run_reset
if errorlevel 1 goto :finish
call :launch_app
goto :finish

:reset_rebuild_launch
call :run_reset
if errorlevel 1 goto :finish
call :rebuild_app
if errorlevel 1 goto :finish
call :launch_app
goto :finish

:run_reset
echo.
echo [1/3] Killing running processes...
call :stop_mongo_service
if errorlevel 1 exit /b 1
call :kill_process "Mock Testing Suite.exe"
call :kill_process "electron.exe"
call :kill_process "backend.exe"
call :kill_process "mongod.exe"
call :kill_process "chromedriver.exe"
call :kill_process "msedgedriver.exe"
call :verify_no_mongod
if errorlevel 1 exit /b 1

echo.
echo [2/3] Waiting for processes to close...
timeout /t 2 /nobreak >nul

echo.
echo [3/3] Deleting packaged app database...
call :remove_dir "%PACKAGED_DB_DIR%" "Packaged MongoDB data"
if errorlevel 1 exit /b 1

echo.
echo Cleaning legacy repo-local database path if present...
call :remove_dir "%DEV_DB_DIR%" "Legacy repo-local MongoDB data"
if errorlevel 1 exit /b 1

echo.
echo Clearing packaged app local storage...
call :remove_dir "%PACKAGED_LOCAL_STORAGE_DIR%" "Packaged app Local Storage"
if errorlevel 1 exit /b 1

echo.
echo Clearing packaged app session storage...
call :remove_dir "%PACKAGED_SESSION_STORAGE_DIR%" "Packaged app Session Storage"
if errorlevel 1 exit /b 1

echo.
echo Reset complete.
exit /b 0

:rebuild_app
echo.
echo Cleaning packaged output folder before rebuild...
if exist "%WIN_UNPACKED_DIR%" (
  rmdir /S /Q "%WIN_UNPACKED_DIR%"
  if exist "%WIN_UNPACKED_DIR%" (
    echo Failed to remove:
    echo   %WIN_UNPACKED_DIR%
    exit /b 1
  )
  echo Removed:
  echo   %WIN_UNPACKED_DIR%
) else (
  echo No existing win-unpacked folder found.
)

echo.
echo Building frontend...
pushd "%ROOT_DIR%\frontend" || (
  echo Unable to open frontend folder.
  exit /b 1
)
call yarn build
if errorlevel 1 (
  popd
  echo Frontend build failed.
  exit /b 1
)
popd

echo.
echo Building Windows desktop package...
pushd "%ROOT_DIR%\desktop" || (
  echo Unable to open desktop folder.
  exit /b 1
)
call npm run build:win
if errorlevel 1 (
  popd
  echo Desktop build failed.
  exit /b 1
)
popd

echo.
echo Rebuild complete.
exit /b 0

:launch_app
echo.
echo Launching packaged app...
if not exist "%APP_EXE%" (
  echo Packaged app not found:
  echo   %APP_EXE%
  exit /b 1
)
start "" "%APP_EXE%"
echo Packaged app launched.
exit /b 0

:kill_process
set "PROCESS_NAME=%~1"
taskkill /IM %PROCESS_NAME% /T /F >nul 2>&1
if errorlevel 1 (
  echo   %PROCESS_NAME% not running.
) else (
  echo   %PROCESS_NAME% terminated.
)
exit /b 0

:stop_mongo_service
sc query "MongoDB" >nul 2>&1
if errorlevel 1 (
  echo   MongoDB service not installed.
  exit /b 0
)

if "%IS_ADMIN%" NEQ "1" (
  echo   MongoDB service detected. Relaunching this reset tool with Administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 1
)

echo   Stopping MongoDB Windows service if it is running...
net stop "MongoDB" >nul 2>&1
if errorlevel 1 (
  echo   MongoDB service was not running or could not be stopped cleanly.
  sc stop "MongoDB" >nul 2>&1
  timeout /t 2 /nobreak >nul
)

sc query "MongoDB" | find /I "RUNNING" >nul
if not errorlevel 1 (
  echo   MongoDB service is still running.
  echo   Run this script in an Administrator Command Prompt or stop the MongoDB service manually first.
  exit /b 1
)

echo   MongoDB service stopped.
timeout /t 2 /nobreak >nul
exit /b 0

:verify_no_mongod
tasklist /FI "IMAGENAME eq mongod.exe" | find /I "mongod.exe" >nul
if not errorlevel 1 (
  echo   A mongod.exe process is still running after reset cleanup.
  echo   Stop the MongoDB Windows service or close any external MongoDB instance, then try again.
  exit /b 1
)
exit /b 0

:remove_dir
set "TARGET_DIR=%~1"
set "TARGET_LABEL=%~2"
echo   Target folder:
echo     %TARGET_DIR%
if exist "%TARGET_DIR%" (
  rmdir /S /Q "%TARGET_DIR%"
  if exist "%TARGET_DIR%" (
    echo Failed to remove %TARGET_LABEL%:
    echo   %TARGET_DIR%
    exit /b 1
  )
  echo %TARGET_LABEL% removed:
  echo   %TARGET_DIR%
) else (
  echo %TARGET_LABEL% not found, nothing to delete:
  echo   %TARGET_DIR%
)
exit /b 0

:invalid_choice
echo.
echo Invalid selection.
goto :finish

:finish
echo.
pause
goto :menu

:exit_script
echo.
echo Exiting developer utility.
echo.
pause
endlocal
