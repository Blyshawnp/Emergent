@echo off
setlocal

echo ==========================================
echo Restoring Real App
echo ==========================================

if exist src\App.jsx.before-tutorial-preview.bak (
  copy /Y src\App.jsx.before-tutorial-preview.bak src\App.jsx
  echo Restored src\App.jsx
)

if exist src\App.js.before-tutorial-preview.bak (
  copy /Y src\App.js.before-tutorial-preview.bak src\App.js
  echo Restored src\App.js
)

echo Done.
pause