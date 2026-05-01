@echo off
setlocal

echo Starting app...

if not exist package.json (
  echo ERROR: package.json not found.
  pause
  exit /b 1
)

call npm start
pause