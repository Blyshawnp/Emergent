@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%..\.."
pushd "%ROOT%" || (
  echo Could not find project root.
  pause
  exit /b 1
)

echo Mock Testing Suite - Rebuild Backend
echo ===================================
echo.
echo This rebuilds backend\dist\backend.exe from the Python backend source.
echo Use Python 3.11 or 3.12 from python.org.
echo.

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
pause
popd
exit /b 1

:python_found
echo Using Python command: %PY%
%PY% --version
echo.

if not exist ".venv-backend-build\Scripts\python.exe" (
  echo Creating backend build virtual environment...
  %PY% -m venv .venv-backend-build
  if errorlevel 1 goto :fail
)

call ".venv-backend-build\Scripts\activate.bat"
if errorlevel 1 goto :fail

echo Upgrading Python build tools...
python -m pip install --upgrade pip setuptools wheel
if errorlevel 1 goto :fail

echo Installing backend dependencies and PyInstaller...
python -m pip install -r backend\requirements.txt pyinstaller
if errorlevel 1 goto :fail

echo Building backend.exe...
pushd backend || goto :fail
python -m PyInstaller --noconfirm backend.spec
if errorlevel 1 (
  popd
  goto :fail
)

if not exist "dist\backend.exe" (
  echo backend\dist\backend.exe was not created.
  popd
  goto :fail
)

for %%F in ("dist\backend.exe") do echo Built: %%~fF
popd

echo.
echo Backend rebuild complete.
echo Next step: run BUILD-MAIN-APP-PACKAGE.bat and the admin package build if needed.
popd
pause
exit /b 0

:fail
echo.
echo Backend rebuild failed.
echo Read the error above. Most failures are caused by missing Python 3.11/3.12,
echo blocked internet access, or Python not being the normal python.org Windows build.
popd
pause
exit /b 1
