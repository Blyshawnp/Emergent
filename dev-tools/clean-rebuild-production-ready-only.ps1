$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$frontendDir = Join-Path $rootDir 'frontend'
$backendDir = Join-Path $rootDir 'backend'
$desktopDir = Join-Path $rootDir 'desktop'
$prodDir = Join-Path $rootDir 'production-ready'
$mtsProdDir = Join-Path $prodDir 'Mock Testing Suite 1.0.1'
$samProdDir = Join-Path $prodDir 'ADMIN ONLY - SAM 1.0.1'
$mtsDist = Join-Path $desktopDir 'dist'
$samDist = Join-Path $desktopDir 'dist-notification-manager'
$mtsInstaller = 'Mock-Testing-Suite-Setup-1.0.1.exe'
$samInstaller = 'Sam-Setup-1.0.1.exe'

$logDir = Join-Path $rootDir 'dev-tools\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$logFile = Join-Path $logDir "clean-rebuild-production-ready-only-$stamp.log"
$script:lastStep = 'Startup'
$script:warnings = New-Object System.Collections.Generic.List[string]

function Write-Log {
  param([string]$Message)
  $Message | Tee-Object -FilePath $logFile -Append
}

function Section {
  param([string]$Title)
  Write-Log ''
  Write-Log '=================================='
  Write-Log $Title
  Write-Log '=================================='
}

function Fail {
  param([string]$Message)
  Section 'BUILD FAILED'
  Write-Log "ERROR: $Message"
  Write-Log "Last successful step: $script:lastStep"
  Write-Log "Log file: $logFile"
  exit 1
}

function Verify-Path {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path)) {
    Fail "Missing $Label`: $Path"
  }
  Write-Log "Verified $Label`: $Path"
}

function Verify-OptionalPath {
  param([string]$Path, [string]$Label)
  if (Test-Path -LiteralPath $Path) {
    Write-Log "Verified optional $Label`: $Path"
    return
  }
  $script:warnings.Add("Optional $Label not found: $Path. Browser driver runtime fallback will be used.")
}

function Read-JsonFile {
  param([string]$Path)
  Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Copy-FileChecked {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path -LiteralPath $Source)) {
    Fail "File missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
  Write-Log "Copied: $Destination"
}

function Copy-RuntimeConfig {
  param([string]$DestinationDir, [string]$Label)
  New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
  $runtimeSource = Join-Path $backendDir 'config\runtime_config.json'
  $apiSource = Join-Path $backendDir 'config\apps-script-api.json'
  Copy-FileChecked $runtimeSource (Join-Path $DestinationDir 'runtime_config.json')
  Copy-FileChecked $apiSource (Join-Path $DestinationDir 'apps-script-api.json')
  foreach ($legacyName in @('google-service-account.json', 'service-account.json')) {
    $legacyPath = Join-Path $DestinationDir $legacyName
    if (Test-Path -LiteralPath $legacyPath) {
      Remove-Item -LiteralPath $legacyPath -Force
      Write-Log "Removed obsolete packaged credential file from $Label."
    }
  }
  $apiConfig = Read-JsonFile $apiSource
  if ($apiConfig.enabled -ne $true -or -not $apiConfig.base_url -or -not $apiConfig.token) {
    Fail "Apps Script API config is missing enabled, base_url, or token for $Label."
  }
  if ([string]$apiConfig.base_url -notmatch '^https://script\.google\.com/macros/s/.+/exec$') {
    Fail "Apps Script API base_url is invalid for $Label."
  }
  Write-Log "Runtime and Apps Script API config verified for $Label without logging secret values."
}

function Sync-Dir {
  param([string]$Source, [string]$Destination)
  if (-not (Test-Path -LiteralPath $Source)) {
    Fail "Sync source missing: $Source"
  }
  if ($Destination -match 'production-ready-backups') {
    Fail "Refusing to sync into backup path: $Destination"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Log "Syncing directory: $Source -> $Destination"
  Write-Log 'Excluding build-local API config from mirror; the current config is copied immediately after sync.'
  & robocopy $Source $Destination /MIR /XD '.git' '.pytest_cache' 'node_modules' 'production-ready-backups' 'logs' 'tmp' 'temp' /XF 'apps-script-api.json' 'google-service-account.json' 'service-account.json' '*.tmp' '*.temp' /R:2 /W:2 /NFL /NDL /NP /NJH /NJS 2>&1 |
    ForEach-Object { Write-Log ([string]$_) }
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    Fail "robocopy failed with code $rc."
  }
  if ($rc -gt 0) {
    $script:warnings.Add("robocopy completed with non-fatal status $rc for $Destination")
  }
}

function Remove-AccidentalBackendFiles {
  param([string]$BackendResourcesDir)
  foreach ($name in @('cd', 'curl', 'dir', 'static', 'type', 'assets')) {
    $filePath = Join-Path $BackendResourcesDir $name
    if (Test-Path -LiteralPath $filePath -PathType Leaf) {
      try {
        if ((Get-Item -LiteralPath $filePath).Length -eq 0) {
          Remove-Item -LiteralPath $filePath -Force
          Write-Log "Removed accidental backend file: $filePath"
        }
      } catch {
        $script:warnings.Add("Unable to remove accidental backend file ${filePath}: $($_.Exception.Message)")
      }
    }
  }
}

function Get-Sha256Hex {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha.ComputeHash($stream)
      return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Write-HashFile {
  param([string]$Source, [string]$HashFile, [string]$Label)
  if (-not (Test-Path -LiteralPath $Source)) {
    Fail "Hash source missing: $Source"
  }
  $hash = Get-Sha256Hex $Source
  "$Label SHA256: $hash" | Set-Content -LiteralPath $HashFile -Encoding ASCII
  Write-Log "Hash updated: $HashFile"
}

function Compare-Hash {
  param([string]$Source, [string]$Destination, [string]$Label)
  if (-not (Test-Path -LiteralPath $Source)) { Fail "Hash source missing for $Label`: $Source" }
  if (-not (Test-Path -LiteralPath $Destination)) { Fail "Hash destination missing for $Label`: $Destination" }
  $left = Get-Sha256Hex $Source
  $right = Get-Sha256Hex $Destination
  if ($left -ne $right) {
    Fail "hash mismatch for $Label."
  }
  Write-Log "Verified: $Label"
}

# ============================================================
# MAIN SCRIPT
# ============================================================

Section 'REFRESH PRODUCTION-READY FROM EXISTING DESKTOP BUILDS'
Write-Log 'Mode: production-ready-only (no frontend/backend/electron rebuild)'
Write-Log "Root: $rootDir"
Write-Log "Log:  $logFile"
Write-Log "Run dev-tools\clean-app-main-junk.bat if you want to remove temporary debug files."

Section 'CHECKING EXISTING DESKTOP BUILDS'
$missingBuilds = @()
if (-not (Test-Path -LiteralPath (Join-Path $mtsDist 'win-unpacked\Mock Testing Suite.exe'))) {
  $missingBuilds += 'desktop/dist/win-unpacked/Mock Testing Suite.exe'
}
if (-not (Test-Path -LiteralPath (Join-Path $mtsDist $mtsInstaller))) {
  $missingBuilds += "desktop/dist/$mtsInstaller"
}
if (-not (Test-Path -LiteralPath (Join-Path $samDist 'win-unpacked\Sam.exe'))) {
  $missingBuilds += 'desktop/dist-notification-manager/win-unpacked/Sam.exe'
}
if (-not (Test-Path -LiteralPath (Join-Path $samDist $samInstaller))) {
  $missingBuilds += "desktop/dist-notification-manager/$samInstaller"
}

if ($missingBuilds.Count -gt 0) {
  Write-Log ''
  Write-Log 'ERROR: Desktop builds are missing. Cannot refresh production-ready.'
  Write-Log 'Missing files:'
  foreach ($missing in $missingBuilds) {
    Write-Log "  - $missing"
  }
  Write-Log ''
  Write-Log 'Run clean-rebuild-desktop-only.bat or clean-rebuild-all.bat first.'
  exit 1
}
Write-Log 'All required desktop build outputs found.'

Section 'SYNCING MTS TO PRODUCTION-READY'
Sync-Dir (Join-Path $mtsDist 'win-unpacked') (Join-Path $mtsProdDir 'win-unpacked')
Copy-RuntimeConfig (Join-Path $mtsProdDir 'win-unpacked\\resources\\backend\\config') 'MTS production-ready'
Remove-AccidentalBackendFiles (Join-Path $mtsProdDir 'win-unpacked\\resources\\backend')
Verify-OptionalPath (Join-Path $mtsProdDir 'win-unpacked\\resources\\backend\\drivers\\chromedriver.exe') 'MTS production-ready backend chromedriver.exe'
Verify-OptionalPath (Join-Path $mtsProdDir 'win-unpacked\\resources\\backend\\drivers\\msedgedriver.exe') 'MTS production-ready backend msedgedriver.exe'
Copy-FileChecked (Join-Path $mtsDist $mtsInstaller) (Join-Path $mtsProdDir $mtsInstaller)
Copy-FileChecked (Join-Path $mtsDist "$mtsInstaller.blockmap") (Join-Path $mtsProdDir "$mtsInstaller.blockmap")
Write-HashFile (Join-Path $mtsProdDir $mtsInstaller) (Join-Path $mtsProdDir 'MAIN-APP-HASH.txt') $mtsInstaller

Section 'SYNCING SAM TO PRODUCTION-READY'
Sync-Dir (Join-Path $samDist 'win-unpacked') (Join-Path $samProdDir 'notification-manager-win-unpacked')
Copy-RuntimeConfig (Join-Path $samProdDir 'notification-manager-win-unpacked\\resources\\backend\\config') 'SAM production-ready'
Remove-AccidentalBackendFiles (Join-Path $samProdDir 'notification-manager-win-unpacked\\resources\\backend')
Verify-OptionalPath (Join-Path $samProdDir 'notification-manager-win-unpacked\\resources\\backend\\drivers\\chromedriver.exe') 'SAM production-ready backend chromedriver.exe'
Verify-OptionalPath (Join-Path $samProdDir 'notification-manager-win-unpacked\\resources\\backend\\drivers\\msedgedriver.exe') 'SAM production-ready backend msedgedriver.exe'
Copy-FileChecked (Join-Path $samDist $samInstaller) (Join-Path $samProdDir $samInstaller)
Copy-FileChecked (Join-Path $samDist "$samInstaller.blockmap") (Join-Path $samProdDir "$samInstaller.blockmap")
Write-HashFile (Join-Path $samProdDir $samInstaller) (Join-Path $samProdDir 'NOTIFICATION-MANAGER-HASH.txt') $samInstaller

Section 'VERIFYING OUTPUT HASHES'
Compare-Hash (Join-Path $mtsDist 'win-unpacked\resources\app.asar') (Join-Path $mtsProdDir 'win-unpacked\resources\app.asar') 'MTS app.asar'
Compare-Hash (Join-Path $backendDir 'dist\backend.exe') (Join-Path $mtsProdDir 'win-unpacked\resources\backend\backend.exe') 'MTS backend.exe'
Compare-Hash (Join-Path $mtsDist $mtsInstaller) (Join-Path $mtsProdDir $mtsInstaller) 'MTS installer'
Compare-Hash (Join-Path $samDist 'win-unpacked\resources\app.asar') (Join-Path $samProdDir 'notification-manager-win-unpacked\resources\app.asar') 'SAM app.asar'
Compare-Hash (Join-Path $backendDir 'dist\backend.exe') (Join-Path $samProdDir 'notification-manager-win-unpacked\resources\backend\backend.exe') 'SAM backend.exe'
Compare-Hash (Join-Path $samDist $samInstaller) (Join-Path $samProdDir $samInstaller) 'SAM installer'

Section 'SUCCESS'
Write-Log 'Summary: SUCCESS'
Write-Log "Build timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Log 'Built:            nothing (used existing desktop builds)'
Write-Log 'Updated:          production-ready MTS + SAM'
Write-Log "MTS installer:    $(Join-Path $mtsProdDir $mtsInstaller)"
Write-Log "MTS unpacked:     $(Join-Path $mtsProdDir 'win-unpacked')"
Write-Log "MTS hash:         $(Join-Path $mtsProdDir 'MAIN-APP-HASH.txt')"
Write-Log "SAM installer:    $(Join-Path $samProdDir $samInstaller)"
Write-Log "SAM unpacked:     $(Join-Path $samProdDir 'notification-manager-win-unpacked')"
Write-Log "SAM hash:         $(Join-Path $samProdDir 'NOTIFICATION-MANAGER-HASH.txt')"
foreach ($warning in $script:warnings) {
  Write-Log "Warning: $warning"
}
Write-Log 'Production-ready refresh complete.'
Write-Log "Log file: $logFile"
exit 0
