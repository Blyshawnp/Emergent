$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$frontendDir = Join-Path $rootDir 'frontend'
$backendDir = Join-Path $rootDir 'backend'
$desktopDir = Join-Path $rootDir 'desktop'
$mtsDist = Join-Path $desktopDir 'dist'
$samDist = Join-Path $desktopDir 'dist-notification-manager'
$mtsInstaller = 'Mock Testing Suite Setup 1.0.1.exe'
$samInstaller = 'Sam Setup 1.0.1.exe'

$logDir = Join-Path $rootDir 'dev-tools\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$logFile = Join-Path $logDir "clean-rebuild-desktop-only-$stamp.log"
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

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail "$Name was not found on PATH."
  }
  Write-Log "Found $Name"
}

function Run-Command {
  param(
    [string]$Label,
    [string]$Command,
    [string]$WorkingDirectory
  )
  $script:lastStep = "$Label :: $Command"
  Write-Log "Running: $Label"
  Write-Log "Command: $Command"
  Push-Location $WorkingDirectory
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & cmd.exe /d /s /c $Command 2>&1 | ForEach-Object { Write-Log ([string]$_) }
    $rc = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
  if ($rc -ne 0) {
    Write-Log "Failed command: $Command"
    Write-Log "Working directory: $WorkingDirectory"
    Write-Log "Exit code: $rc"
    Fail "$Label failed with exit code $rc."
  }
  $script:lastStep = $Label
  Write-Log "OK: $Label"
}

function Remove-DirSafe {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  $full = [System.IO.Path]::GetFullPath($Path)
  if ($full.TrimEnd('\') -ieq $rootDir.TrimEnd('\')) {
    Fail "Refusing to remove project root: $full"
  }
  if ($full -match 'production-ready') {
    Fail "Refusing to remove production-ready path in desktop-only mode: $full"
  }
  if (Test-Path -LiteralPath $full) {
    Write-Log "Removing: $full"
    Get-ChildItem -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
      try { $_.Attributes = 'Normal' } catch {}
    }
    Remove-Item -LiteralPath $full -Recurse -Force
  } else {
    Write-Log "Not present, skipping: $full"
  }
}

function Stop-Image {
  param([string]$Name)
  $items = Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($Name)) -ErrorAction SilentlyContinue
  if (-not $items) {
    Write-Log "$Name not running."
    return
  }
  $items | Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Log "$Name terminated."
}

function Stop-PythonBackends {
  $items = Get-CimInstance Win32_Process -Filter "name = 'python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'uvicorn server:app|backend\\server.py|packaged_backend.py|APP-main\\backend' }
  foreach ($item in $items) {
    try {
      Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop
      Write-Log "python backend process terminated: $($item.ProcessId)"
    } catch {
      $script:warnings.Add("Unable to terminate python backend process $($item.ProcessId): $($_.Exception.Message)")
    }
  }
  Write-Log 'Checked for local backend Python processes.'
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

function Ensure-DriverReadme {
  param([string]$DriverDir)
  New-Item -ItemType Directory -Force -Path $DriverDir | Out-Null
  $readmePath = Join-Path $DriverDir 'README.txt'
  if (-not (Test-Path -LiteralPath $readmePath)) {
    @"
Browser driver executables are not bundled in this build.
At runtime, Selenium Manager or webdriver-manager will attempt to resolve the correct driver.
If browser automation fails, please make sure Microsoft Edge or Google Chrome is installed and connected to the internet.
"@ | Set-Content -LiteralPath $readmePath -Encoding UTF8
    Write-Log "Created fallback README: $readmePath"
  } else {
    Write-Log "Driver README present: $readmePath"
  }

  $driverFiles = @("chromedriver.exe", "msedgedriver.exe")
  $foundDriver = $false
  foreach ($file in $driverFiles) {
    if (Test-Path -LiteralPath (Join-Path $DriverDir $file)) {
      $foundDriver = $true
      break
    }
  }
  if (-not $foundDriver) {
    $script:warnings.Add("Browser drivers not bundled. Selenium Manager will attempt runtime driver resolution.")
    Write-Log "Warning: Browser drivers not bundled. Selenium Manager will attempt runtime driver resolution."
  } else {
    Write-Log "Browser drivers bundle detected in $DriverDir"
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

function Read-JsonFile {
  param([string]$Path)
  Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Verify-PrivateKeyId {
  param([string]$Source, [string]$Destination, [string]$Label)
  $src = Read-JsonFile $Source
  $dst = Read-JsonFile $Destination
  if (-not $src.private_key_id -or $src.private_key_id -ne $dst.private_key_id) {
    Fail "service-account private_key_id mismatch for $Label."
  }
  Write-Log "Verified service-account private_key_id for $Label."
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
  $keySource = Join-Path $backendDir 'config\google-service-account.json'
  Copy-FileChecked $runtimeSource (Join-Path $DestinationDir 'runtime_config.json')
  Copy-FileChecked $keySource (Join-Path $DestinationDir 'google-service-account.json')
  $legacySource = Join-Path $backendDir 'config\service-account.json'
  if (Test-Path -LiteralPath $legacySource) {
    Copy-FileChecked $legacySource (Join-Path $DestinationDir 'service-account.json')
  }
  Verify-PrivateKeyId $keySource (Join-Path $DestinationDir 'google-service-account.json') $Label
  Write-Log "Runtime config verified for $Label."
}

# ============================================================
# MAIN SCRIPT
# ============================================================

Section 'CLEAN REBUILD DESKTOP ONLY'
Write-Log 'Mode: desktop-only (production-ready will NOT be touched)'
Write-Log "Root: $rootDir"
Write-Log "Log:  $logFile"
Write-Log "Run dev-tools\clean-app-main-junk.bat if you want to remove temporary debug files."

Section 'VERIFYING TOOLCHAIN'
foreach ($command in @('node', 'npm', 'yarn', 'powershell', 'python', 'robocopy')) {
  Require-Command $command
}
Run-Command 'Node version' 'node --version' $rootDir
Run-Command 'npm version' 'npm --version' $rootDir
Run-Command 'Yarn version' 'yarn --version' $rootDir
Run-Command 'Python version' 'python --version' $rootDir

Section 'STOPPING RUNNING PROCESSES'
foreach ($image in @('Mock Testing Suite.exe', 'Sam.exe', 'SAM.exe', 'backend.exe', 'electron.exe', 'makensis.exe', '7za.exe')) {
  Stop-Image $image
}
Stop-PythonBackends
Write-Log 'Waiting for Windows file locks to release...'
Start-Sleep -Seconds 4

Section 'CLEANING OLD DESKTOP BUILDS'
foreach ($path in @(
  (Join-Path $frontendDir 'build'),
  (Join-Path $backendDir 'build'),
  (Join-Path $backendDir 'dist'),
  (Join-Path $desktopDir 'dist'),
  (Join-Path $desktopDir 'dist-notification-manager'),
  (Join-Path $desktopDir 'release'),
  (Join-Path $rootDir 'build'),
  (Join-Path $rootDir 'dist'),
  (Join-Path $rootDir 'release')
)) {
  Remove-DirSafe $path
}

Section 'REBUILDING FRONTEND'
Run-Command 'npm run build:react' 'npm run build:react' $desktopDir
Verify-Path (Join-Path $frontendDir 'build\index.html') 'frontend build index.html'

Section 'REBUILDING BACKEND'
Run-Command 'npm run build:backend' 'npm run build:backend' $desktopDir
Verify-Path (Join-Path $backendDir 'dist\backend.exe') 'backend.exe'
Ensure-DriverReadme (Join-Path $backendDir 'drivers')

Section 'PACKAGING MOCK TESTING SUITE'
Run-Command 'npx electron-builder --win --x64' 'npx electron-builder --win --x64' $desktopDir
Verify-Path (Join-Path $mtsDist 'win-unpacked\Mock Testing Suite.exe') 'MTS win-unpacked executable'
Verify-OptionalPath (Join-Path $mtsDist 'win-unpacked\resources\backend\drivers\chromedriver.exe') 'MTS backend chromedriver.exe'
Verify-OptionalPath (Join-Path $mtsDist 'win-unpacked\resources\backend\drivers\msedgedriver.exe') 'MTS backend msedgedriver.exe'
Verify-Path (Join-Path $mtsDist $mtsInstaller) 'MTS installer'
Verify-Path (Join-Path $mtsDist "$mtsInstaller.blockmap") 'MTS installer blockmap'
Copy-RuntimeConfig (Join-Path $mtsDist 'win-unpacked\resources\backend\config') 'MTS desktop'
Remove-AccidentalBackendFiles (Join-Path $mtsDist 'win-unpacked\resources\backend')

Section 'PACKAGING SAM SMART ALERT MANAGER'
Run-Command 'npx electron-builder --win --x64 --config notification-manager-builder.json' 'npx electron-builder --win --x64 --config notification-manager-builder.json' $desktopDir
Verify-Path (Join-Path $samDist 'win-unpacked\Sam.exe') 'SAM win-unpacked executable'
Verify-OptionalPath (Join-Path $samDist 'win-unpacked\resources\backend\drivers\chromedriver.exe') 'SAM backend chromedriver.exe'
Verify-OptionalPath (Join-Path $samDist 'win-unpacked\resources\backend\drivers\msedgedriver.exe') 'SAM backend msedgedriver.exe'
Verify-Path (Join-Path $samDist $samInstaller) 'SAM installer'
Verify-Path (Join-Path $samDist "$samInstaller.blockmap") 'SAM installer blockmap'
Copy-RuntimeConfig (Join-Path $samDist 'win-unpacked\resources\backend\config') 'SAM desktop'
Remove-AccidentalBackendFiles (Join-Path $samDist 'win-unpacked\resources\backend')

Section 'VERIFYING DESKTOP OUTPUTS'
Verify-Path (Join-Path $mtsDist 'win-unpacked\resources\app.asar') 'MTS app.asar'
Verify-Path (Join-Path $mtsDist 'win-unpacked\resources\backend\backend.exe') 'MTS backend.exe in package'
Verify-Path (Join-Path $samDist 'win-unpacked\resources\app.asar') 'SAM app.asar'
Verify-Path (Join-Path $samDist 'win-unpacked\resources\backend\backend.exe') 'SAM backend.exe in package'

Section 'SUCCESS'
Write-Log 'Summary: SUCCESS'
Write-Log "Build timestamp: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Log 'Built:            MTS desktop + SAM desktop'
Write-Log 'Skipped:          production-ready (not touched)'
Write-Log "MTS installer:    $(Join-Path $mtsDist $mtsInstaller)"
Write-Log "MTS unpacked:     $(Join-Path $mtsDist 'win-unpacked')"
Write-Log "SAM installer:    $(Join-Path $samDist $samInstaller)"
Write-Log "SAM unpacked:     $(Join-Path $samDist 'win-unpacked')"
foreach ($warning in $script:warnings) {
  Write-Log "Warning: $warning"
}
Write-Log 'Desktop builds complete. production-ready was NOT modified.'
Write-Log "Log file: $logFile"
exit 0
