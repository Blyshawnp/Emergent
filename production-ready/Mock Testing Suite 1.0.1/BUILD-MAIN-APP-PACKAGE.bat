@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\.."
set "MAIN_OUT=%ROOT%\production-ready\Mock Testing Suite 1.0.1"

pushd "%ROOT%" || (
  echo Could not find project root.
  pause
  exit /b 1
)

echo Mock Testing Suite - Build Main App Package
echo ==========================================
echo.
echo This builds the React frontend, packages the Windows installer,
echo and refreshes this production-ready folder.
echo.

pushd desktop || goto :fail

echo Building React frontend...
call npm run build:react
if errorlevel 1 (
  popd
  goto :fail
)

echo Building main Windows installer...
call npx electron-builder --win --x64
if errorlevel 1 (
  popd
  goto :fail
)

popd

echo Refreshing production-ready main app folder...
if exist "%MAIN_OUT%\win-unpacked" rmdir /s /q "%MAIN_OUT%\win-unpacked"
copy /y "desktop\dist\Mock Testing Suite Setup 1.0.1.exe" "%MAIN_OUT%\" >nul
if errorlevel 1 goto :fail
copy /y "desktop\dist\Mock Testing Suite Setup 1.0.1.exe.blockmap" "%MAIN_OUT%\" >nul
if errorlevel 1 goto :fail
xcopy /e /i /y "desktop\dist\win-unpacked" "%MAIN_OUT%\win-unpacked" >nul
if errorlevel 1 goto :fail

echo Writing SHA256 hash...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-FileHash '%MAIN_OUT%\Mock Testing Suite Setup 1.0.1.exe' -Algorithm SHA256 | Format-List | Out-File '%MAIN_OUT%\MAIN-APP-HASH.txt' -Encoding utf8"

echo.
echo Main app package is ready:
echo %MAIN_OUT%
echo.
echo Hash written to:
echo %MAIN_OUT%\MAIN-APP-HASH.txt
popd
pause
exit /b 0

:fail
echo.
echo Main app package build failed.
echo Read the error above, fix it, then run this BAT again.
popd
pause
exit /b 1
