@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%.."

pushd "%ROOT%" || (
  echo Could not find project root.
  pause
  exit /b 1
)

echo Mock Testing Suite - Clean Rebuild Main App Without Touching production-ready
echo ========================================================================
echo.
echo This rebuilds the main app build outputs only:
echo.
echo   backend\dist\backend.exe
echo   frontend\build
echo   desktop\dist\Mock-Testing-Suite-Setup-1.0.1.exe
echo.
echo It will NOT copy anything into production-ready.
echo It will NOT delete anything inside production-ready.
echo.
pause

echo Removing old source build output...
if exist "frontend\build" rmdir /s /q "frontend\build"
if exist "backend\build" rmdir /s /q "backend\build"
if exist "backend\dist" rmdir /s /q "backend\dist"
if exist "desktop\dist" rmdir /s /q "desktop\dist"

echo.
echo Finding Python...
if exist ".venv\Scripts\python.exe" (
  set "PY=%CD%\.venv\Scripts\python.exe"
  goto :python_found
)

where py >nul 2>nul
if %errorlevel%==0 (
  py -3.11 --version >nul 2>nul
  if %errorlevel%==0 (
    set "PY=py -3.11"
    goto :python_found
  )
  py -3.12 --version >nul 2>nul
  if %errorlevel%==0 (
    set "PY=py -3.12"
    goto :python_found
  )
)

where python >nul 2>nul
if %errorlevel%==0 (
  set "PY=python"
  goto :python_found
)

echo Python was not found.
echo Install Python 3.11 or 3.12 from https://www.python.org/downloads/windows/
echo Make sure "Add python.exe to PATH" is checked during install.
goto :fail

:python_found
echo Using Python command: %PY%
%PY% --version

if not exist ".venv-backend-build\Scripts\python.exe" (
  echo Creating backend build virtual environment...
  %PY% -m venv .venv-backend-build
  if errorlevel 1 goto :fail
)

call ".venv-backend-build\Scripts\activate.bat"
if errorlevel 1 goto :fail

%PY% -c "import PyInstaller" >nul 2>nul
if %errorlevel%==0 (
  echo Python build dependencies already available.
  goto :backend_deps_ready
)

echo Upgrading Python build tools...
%PY% -m pip install --upgrade pip setuptools wheel
if errorlevel 1 goto :fail

echo Installing backend dependencies and PyInstaller...
%PY% -m pip install -r backend\requirements.txt pyinstaller
if errorlevel 1 goto :fail

:backend_deps_ready
echo Building backend.exe...
pushd backend || goto :fail
%PY% -m PyInstaller --noconfirm backend.spec
if errorlevel 1 (
  popd
  goto :fail
)
if not exist "dist\backend.exe" (
  echo backend\dist\backend.exe was not created.
  popd
  goto :fail
)
popd

echo.
echo Building frontend and main installer...
pushd desktop || goto :fail
call npm run build:react
if errorlevel 1 (
  popd
  goto :fail
)

call npx electron-builder --win --x64
if errorlevel 1 (
  popd
  goto :fail
)
popd

echo.
echo Copying current runtime config into main desktop package...
set "MTS_RUNTIME_CONFIG_DIR=%ROOT%\desktop\dist\win-unpacked\resources\backend\config"
if not exist "%MTS_RUNTIME_CONFIG_DIR%" mkdir "%MTS_RUNTIME_CONFIG_DIR%"
copy /y "%ROOT%\backend\config\runtime_config.json" "%MTS_RUNTIME_CONFIG_DIR%\runtime_config.json" >nul
if errorlevel 1 goto :fail
copy /y "%ROOT%\backend\config\apps-script-api-mts.json" "%MTS_RUNTIME_CONFIG_DIR%\apps-script-api.json" >nul
if errorlevel 1 goto :fail
if exist "%MTS_RUNTIME_CONFIG_DIR%\google-service-account.json" del /q "%MTS_RUNTIME_CONFIG_DIR%\google-service-account.json"
if exist "%MTS_RUNTIME_CONFIG_DIR%\service-account.json" del /q "%MTS_RUNTIME_CONFIG_DIR%\service-account.json"
%PY% -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); u=str(d.get('base_url') or ''); t=str(d.get('token') or ''); r=str(d.get('role') or ''); sys.exit(0 if d.get('enabled') is True and r == 'mts' and u.startswith('https://script.google.com/macros/s/') and u.endswith('/exec') and t else 2)" "%MTS_RUNTIME_CONFIG_DIR%\apps-script-api.json"
if errorlevel 1 (
  echo Runtime Apps Script API config verification failed.
  goto :fail
)

echo.
echo Clean main app rebuild complete.
echo.
echo Output files:
echo   %ROOT%\backend\dist\backend.exe
echo   %ROOT%\frontend\build
echo   %ROOT%\desktop\dist\Mock-Testing-Suite-Setup-1.0.1.exe
echo.
echo production-ready was not changed.
popd
pause
exit /b 0

:fail
echo.
echo Clean main app rebuild failed.
echo production-ready was not changed by this script.
echo Read the error above, fix it, then run this BAT again.
popd
pause
exit /b 1
