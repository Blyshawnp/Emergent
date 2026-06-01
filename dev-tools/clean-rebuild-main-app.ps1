$ErrorActionPreference = 'Stop'

# Clean rebuild the desktop outputs only. This delegates to the existing
# desktop-only implementation and intentionally does not touch production-ready.
$scriptPath = Join-Path $PSScriptRoot 'clean-rebuild-desktop-only.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
  Write-Error "Missing rebuild script: $scriptPath"
  exit 1
}

Write-Host 'CLEAN REBUILD MAIN APP DESKTOP OUTPUTS ONLY, PRODUCTION-READY NOT TOUCHED'
Write-Host ''
& $scriptPath
exit $LASTEXITCODE
