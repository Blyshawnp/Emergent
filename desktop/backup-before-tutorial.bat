@echo off
setlocal

echo Backing up current app files...

if not exist src (
  echo ERROR: src folder not found. Put this bat file in the desktop folder.
  pause
  exit /b 1
)

set BACKUP_DIR=tutorial_backup_%date:~-4%%date:~4,2%%date:~7,2%_%time:~0,2%%time:~3,2%
set BACKUP_DIR=%BACKUP_DIR: =0%

mkdir "%BACKUP_DIR%"

xcopy src "%BACKUP_DIR%\src" /E /I /Y >nul
copy package.json "%BACKUP_DIR%\package.json" >nul

if exist package-lock.json copy package-lock.json "%BACKUP_DIR%\package-lock.json" >nul

echo Backup created:
echo %BACKUP_DIR%
pause