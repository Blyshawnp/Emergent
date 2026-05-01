@echo off
setlocal

echo ==========================================
echo Patching App file with Tutorial Preview
echo ==========================================

if exist src\App.jsx (
  set APPFILE=src\App.jsx
  goto found
)

if exist src\App.js (
  set APPFILE=src\App.js
  goto found
)

echo ERROR: Could not find src\App.js or src\App.jsx
pause
exit /b 1

:found
echo Found %APPFILE%

copy "%APPFILE%" "%APPFILE%.before-real-tutorial-preview.bak" >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
"$path='%APPFILE%'; $text=Get-Content $path -Raw; if ($text -notmatch 'TutorialPreviewOverlay') { $text = 'import TutorialPreviewOverlay from ''./tutorial/TutorialPreviewOverlay'';' + [Environment]::NewLine + $text }; if ($text -match 'return\s*\(') { $text = $text -replace 'return\s*\(', 'return (' + [Environment]::NewLine + '    <>' + [Environment]::NewLine + '      <TutorialPreviewOverlay />' }; if ($text -match '\);\s*\}\s*export default') { $text = $text -replace '\);\s*\}\s*export default', '    </>' + [Environment]::NewLine + '  );' + [Environment]::NewLine + '}' + [Environment]::NewLine + [Environment]::NewLine + 'export default' }; Set-Content -Encoding UTF8 $path $text"

echo.
echo Patch attempted.
echo.
echo Now run:
echo npm start
echo.
echo If the app fails to compile, run restore-app-after-tutorial-preview.bat
pause