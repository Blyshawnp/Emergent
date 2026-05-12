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

echo Mock Testing Suite - Clean Rebuild Main App
echo ==========================================
echo.
echo This will remove old build output and rebuild:
echo.
echo   1. backend\dist\backend.exe
echo   2. frontend\build
echo   3. desktop\dist\Mock Testing Suite Setup 1.0.1.exe
echo   4. this production-ready folder's main app files
echo.
echo It will not delete your source code, settings, or production instructions.
echo.
pause

echo Removing old build output...
if exist "frontend\build" rmdir /s /q "frontend\build"
if exist "backend\build" rmdir /s /q "backend\build"
if exist "backend\dist" rmdir /s /q "backend\dist"
if exist "desktop\dist" rmdir /s /q "desktop\dist"
if exist "%MAIN_OUT%\win-unpacked" rmdir /s /q "%MAIN_OUT%\win-unpacked"
del /q "%MAIN_OUT%\Mock Testing Suite Setup 1.0.1.exe" >nul 2>nul
del /q "%MAIN_OUT%\Mock Testing Suite Setup 1.0.1.exe.blockmap" >nul 2>nul
del /q "%MAIN_OUT%\MAIN-APP-HASH.txt" >nul 2>nul

echo.
echo Finding Python...
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
echo Refreshing production-ready main app folder...
copy /y "desktop\dist\Mock Testing Suite Setup 1.0.1.exe" "%MAIN_OUT%\" >nul
if errorlevel 1 goto :fail
copy /y "desktop\dist\Mock Testing Suite Setup 1.0.1.exe.blockmap" "%MAIN_OUT%\" >nul
if errorlevel 1 goto :fail
xcopy /e /i /y "desktop\dist\win-unpacked" "%MAIN_OUT%\win-unpacked" >nul
if errorlevel 1 goto :fail

echo Writing SHA256 hash...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-FileHash '%MAIN_OUT%\Mock Testing Suite Setup 1.0.1.exe' -Algorithm SHA256 | Format-List | Out-File '%MAIN_OUT%\MAIN-APP-HASH.txt' -Encoding utf8"

echo.
echo Clean main app rebuild complete.
echo.
echo Ready folder:
echo %MAIN_OUT%
echo.
echo Hash:
type "%MAIN_OUT%\MAIN-APP-HASH.txt"
echo.
popd
pause
exit /b 0

:fail
echo.
echo Clean main app rebuild failed.
echo Read the error above, fix it, then run this BAT again.
popd
pause
exit /b 1
