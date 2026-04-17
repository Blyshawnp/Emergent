@echo off
echo.
echo  ==========================================
echo   Mock Testing Suite — Package Installer
echo  ==========================================
echo.
echo  Installing required Python packages...
echo.
cd /d "%~dp0backend"
py -3.13 -m pip install -r requirements.txt
py -3.13 -m pip install pywebview
echo.
if %errorlevel% equ 0 (
    echo  SUCCESS! All packages installed.
    echo.
    echo  You can now double-click RUN_APP.bat to launch.
) else (
    echo  FAILED! See the error messages above.
    echo.
    echo  Try running Command Prompt as Administrator.
)
echo.
pause
