@echo off
REM ================================================================
REM  Mock Testing Suite v3.0 — Desktop App Build Script
REM  Creates a standalone Windows application (no Python needed)
REM ================================================================
echo.
echo  ==========================================
echo   Mock Testing Suite — Desktop Build
echo  ==========================================
echo.

REM Step 1: Check PyInstaller
echo  [1/4] Checking PyInstaller...
py -3.13 -m PyInstaller --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  Installing PyInstaller...
    py -3.13 -m pip install pyinstaller
)
echo        OK

REM Step 2: Check pywebview
echo  [2/4] Checking pywebview...
py -3.13 -c "import webview" >nul 2>&1
if %errorlevel% neq 0 (
    echo  Installing pywebview...
    py -3.13 -m pip install pywebview
)
echo        OK

REM Step 3: Build
echo  [3/4] Building MockTestingSuite.exe (this takes 2-5 minutes)...
py -3.13 -m PyInstaller ^
    --name "MockTestingSuite" ^
    --onedir ^
    --windowed ^
    --noconfirm ^
    --clean ^
    --icon "frontend\assets\favicon.ico" ^
    --add-data "backend;backend" ^
    --add-data "frontend;frontend" ^
    --hidden-import uvicorn.logging ^
    --hidden-import uvicorn.loops ^
    --hidden-import uvicorn.loops.auto ^
    --hidden-import uvicorn.protocols ^
    --hidden-import uvicorn.protocols.http ^
    --hidden-import uvicorn.protocols.http.auto ^
    --hidden-import uvicorn.protocols.websockets ^
    --hidden-import uvicorn.protocols.websockets.auto ^
    --hidden-import uvicorn.lifespan ^
    --hidden-import uvicorn.lifespan.on ^
    --hidden-import uvicorn.lifespan.off ^
    --collect-all uvicorn ^
    --collect-all fastapi ^
    --collect-all starlette ^
    --collect-all webview ^
    desktop.py

if %errorlevel% neq 0 (
    echo.
    echo  BUILD FAILED! Check the errors above.
    pause
    exit /b 1
)
echo        OK

REM Step 4: Prepare output
echo  [4/4] Preparing output...
if not exist "dist\MockTestingSuite\data" mkdir "dist\MockTestingSuite\data"

if exist "frontend\assets\favicon.ico" (
    copy "frontend\assets\favicon.ico" "dist\MockTestingSuite\favicon.ico" >nul 2>&1
)

echo.
echo  ==========================================
echo   BUILD COMPLETE!
echo.
echo   Output: dist\MockTestingSuite\
echo   Launch: dist\MockTestingSuite\MockTestingSuite.exe
echo.
echo   To create an installer:
echo   Open installer.iss in Inno Setup and compile.
echo  ==========================================
echo.
pause
