@echo off
for /f %%v in ('powershell -NoProfile -Command "(Get-Content '%~dp0package.json' -Raw | ConvertFrom-Json).version"') do set APP_VERSION=%%v
if "%APP_VERSION%"=="" set APP_VERSION=0.0.0

echo ================================================
echo  Mock Testing Suite v%APP_VERSION% — Windows Build
echo ================================================
echo.

echo [1/3] Building React frontend...
cd /d "%~dp0..\frontend"
call yarn build
if %ERRORLEVEL% neq 0 (
    echo ERROR: Frontend build failed!
    pause
    exit /b 1
)

echo.
echo [2/3] Installing Electron dependencies...
cd /d "%~dp0"
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed!
    pause
    exit /b 1
)

echo.
echo [3/3] Building Windows installer...
call npm run build:win
if %ERRORLEVEL% neq 0 (
    echo ERROR: Electron build failed!
    pause
    exit /b 1
)

echo.
echo ================================================
echo  BUILD COMPLETE!
echo  Installer: dist\Mock Testing Suite Setup %APP_VERSION%.exe
echo ================================================
pause
