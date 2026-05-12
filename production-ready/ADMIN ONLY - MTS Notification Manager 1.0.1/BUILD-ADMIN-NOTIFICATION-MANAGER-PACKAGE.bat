@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\.."
set "ADMIN_OUT=%ROOT%\production-ready\ADMIN ONLY - MTS Notification Manager 1.0.1"

pushd "%ROOT%" || (
  echo Could not find project root.
  pause
  exit /b 1
)

echo Mock Testing Suite - Build Admin Notification Manager Package
echo ============================================================
echo.
echo This builds the React frontend, packages the admin-only Notification Manager,
echo and refreshes this admin-only production-ready folder.
echo.

pushd desktop || goto :fail

echo Building React frontend...
call npm run build:react
if errorlevel 1 (
  popd
  goto :fail
)

echo Building admin-only Notification Manager installer...
call npx electron-builder --win --x64 --config notification-manager-builder.json
if errorlevel 1 (
  popd
  goto :fail
)

popd

echo Refreshing admin-only production-ready folder...
if exist "%ADMIN_OUT%\notification-manager-win-unpacked" rmdir /s /q "%ADMIN_OUT%\notification-manager-win-unpacked"
copy /y "desktop\dist-notification-manager\MTS Notification Manager Setup 1.0.1.exe" "%ADMIN_OUT%\" >nul
if errorlevel 1 goto :fail
copy /y "desktop\dist-notification-manager\MTS Notification Manager Setup 1.0.1.exe.blockmap" "%ADMIN_OUT%\" >nul
if errorlevel 1 goto :fail
xcopy /e /i /y "desktop\dist-notification-manager\win-unpacked" "%ADMIN_OUT%\notification-manager-win-unpacked" >nul
if errorlevel 1 goto :fail

echo Writing SHA256 hash...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-FileHash '%ADMIN_OUT%\MTS Notification Manager Setup 1.0.1.exe' -Algorithm SHA256 | Format-List | Out-File '%ADMIN_OUT%\NOTIFICATION-MANAGER-HASH.txt' -Encoding utf8"

echo.
echo Admin-only Notification Manager package is ready:
echo %ADMIN_OUT%
echo.
echo Hash written to:
echo %ADMIN_OUT%\NOTIFICATION-MANAGER-HASH.txt
popd
pause
exit /b 0

:fail
echo.
echo Admin-only Notification Manager package build failed.
echo Read the error above, fix it, then run this BAT again.
popd
pause
exit /b 1
