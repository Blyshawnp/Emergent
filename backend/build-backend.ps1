$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $backendRoot

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw "Python launcher 'py' was not found. Install Python 3.10+ on the build machine."
}

py -3 -m pip install pyinstaller -q
py -3 -m PyInstaller --noconfirm "$backendRoot\backend.spec"

Write-Host ""
Write-Host "Backend build complete:"
Write-Host "  $backendRoot\dist\backend.exe"
