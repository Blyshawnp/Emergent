@echo off
setlocal EnableExtensions

set "ROOT_DIR=%~dp0.."
for %%I in ("%ROOT_DIR%") do set "ROOT_DIR=%%~fI"

set "FRONTEND_DIR=%ROOT_DIR%\frontend"
set "BACKEND_DIR=%ROOT_DIR%\backend"
set "DESKTOP_DIR=%ROOT_DIR%\desktop"

set "FRONTEND_BUILD_DIR=%FRONTEND_DIR%\build"
set "BACKEND_DIST_DIR=%BACKEND_DIR%\dist"
set "DESKTOP_DIST_DIR=%DESKTOP_DIR%\dist"
set "DESKTOP_CACHE_DIR=%DESKTOP_DIR%\node_modules\.cache"
set "PACKAGED_USERDATA_DIR=%APPDATA%\mock-testing-suite"
set "PACKAGED_LOCAL_STORAGE_DIR=%PACKAGED_USERDATA_DIR%\Local Storage"
set "PACKAGED_SESSION_STORAGE_DIR=%PACKAGED_USERDATA_DIR%\Session Storage"

echo ===============================================
echo   Mock Testing Suite - Full Clean Rebuild
echo ===============================================
echo.

echo [1/7] Killing running processes...
call :kill_process "Mock Testing Suite.exe"
call :kill_process "electron.exe"
call :kill_process "backend.exe"
call :kill_process "mongod.exe"
call :kill_process "chromedriver.exe"
call :kill_process "msedgedriver.exe"

echo.
echo [2/7] Waiting for file locks to clear...
timeout /t 3 /nobreak >nul

echo.
echo [3/7] Deleting old frontend build...
call :safe_remove_dir "%FRONTEND_BUILD_DIR%"

echo.
echo [4/7] Deleting old backend dist...
call :safe_remove_dir "%BACKEND_DIST_DIR%"

echo.
echo [5/7] Deleting old desktop dist...
call :safe_remove_dir "%DESKTOP_DIST_DIR%"

echo.
echo [6/7] Deleting optional desktop cache...
call :safe_remove_dir "%DESKTOP_CACHE_DIR%"

echo.
echo [7/9] Clearing packaged app local storage...
call :safe_remove_dir "%PACKAGED_LOCAL_STORAGE_DIR%"

echo.
echo [8/9] Clearing packaged app session storage...
call :safe_remove_dir "%PACKAGED_SESSION_STORAGE_DIR%"

echo.
echo [9/9] Rebuilding everything...

echo.
echo --- Building frontend ---
pushd "%FRONTEND_DIR%" || goto :pushd_fail_frontend
call yarn build
if errorlevel 1 (
  echo Frontend build failed.
  popd
  goto :fail
)
popd

echo.
echo --- Building backend ---
pushd "%BACKEND_DIR%" || goto :pushd_fail_backend
if exist "build-backend.ps1" (
  powershell -ExecutionPolicy Bypass -File ".\build-backend.ps1"
) else (
  echo build-backend.ps1 not found.
  popd
  goto :fail
)
if errorlevel 1 (
  echo Backend build failed.
  popd
  goto :fail
)
popd

echo.
echo --- Building desktop package ---
pushd "%DESKTOP_DIR%" || goto :pushd_fail_desktop
call npm run build:win
if errorlevel 1 (
  echo Desktop build failed.
  popd
  goto :fail
)
popd

echo.
echo ===============================================
echo Full clean rebuild complete.
echo ===============================================
echo.
echo Packaged app should now be here:
echo %DESKTOP_DIR%\dist\win-unpacked\Mock Testing Suite.exe
echo.
pause
goto :eof

:kill_process
taskkill /f /im %~1 >nul 2>&1
if errorlevel 1 (
  echo   %~1 not running.
) else (
  echo   %~1 terminated.
)
exit /b 0

:safe_remove_dir
if exist "%~1" (
  rmdir /s /q "%~1"
  if exist "%~1" (
    echo Failed to remove:
    echo   %~1
    echo.
    echo A file is probably still locked. Rebooting Windows is the fastest fix if this keeps happening.
    goto :fail
  ) else (
    echo Removed:
    echo   %~1
  )
) else (
  echo Not found, skipping:
  echo   %~1
)
exit /b 0

:pushd_fail_frontend
echo Unable to open frontend folder:
echo   %FRONTEND_DIR%
goto :fail

:pushd_fail_backend
echo Unable to open backend folder:
echo   %BACKEND_DIR%
goto :fail

:pushd_fail_desktop
echo Unable to open desktop folder:
echo   %DESKTOP_DIR%
goto :fail

:fail
echo.
echo ===============================================
echo Full clean rebuild failed.
echo ===============================================
echo.
pause
exit /b 1
