$ErrorActionPreference = 'Stop'

# Refresh production-ready from existing desktop builds only. This wrapper checks
# for the required desktop artifacts before delegating to the existing sync script.
$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktopDir = Join-Path $rootDir 'desktop'
$required = @(
  (Join-Path $desktopDir 'dist\win-unpacked'),
  (Join-Path $desktopDir 'dist\Mock-Testing-Suite-Setup-1.0.1.exe'),
  (Join-Path $desktopDir 'dist-notification-manager\win-unpacked'),
  (Join-Path $desktopDir 'dist-notification-manager\Sam-Setup-1.0.1.exe')
)

Write-Host 'REFRESH PRODUCTION-READY ONLY FROM EXISTING DESKTOP BUILDS'
Write-Host ''

$missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_) })
if ($missing.Count -gt 0) {
  Write-Host 'Desktop builds are missing. Run clean-rebuild-main-app.bat or clean-rebuild-all.bat first.'
  Write-Host 'Missing paths:'
  foreach ($path in $missing) {
    Write-Host "  - $path"
  }
  exit 1
}

$scriptPath = Join-Path $PSScriptRoot 'clean-rebuild-production-ready-only.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
  Write-Error "Missing rebuild script: $scriptPath"
  exit 1
}

& $scriptPath
exit $LASTEXITCODE
