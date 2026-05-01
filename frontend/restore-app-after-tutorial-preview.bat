@echo off
setlocal

echo ==========================================
echo Restoring App File
echo ==========================================

if exist src\App.jsx.before-real-tutorial-preview.bak (
  copy /Y src\App.jsx.before-real-tutorial-preview.bak src\App.jsx >nul
  echo Restored src\App.jsx
)

if exist src\App.js.before-real-tutorial-preview.bak (
  copy /Y src\App.js.before-real-tutorial-preview.bak src\App.js >nul
  echo Restored src\App.js
)

echo Done.
pause