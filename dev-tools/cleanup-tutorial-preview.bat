@echo off
setlocal

call restore-real-app.bat

if exist src\TutorialPreview.jsx (
  del src\TutorialPreview.jsx
  echo Deleted src\TutorialPreview.jsx
)

echo Cleanup complete.
pause