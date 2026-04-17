@echo off
echo ================================================
echo  Mock Testing Suite v2.5.0 — Windows Build
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
echo  Installer: dist\Mock Testing Suite Setup 2.5.0.exe
echo ================================================
pause
