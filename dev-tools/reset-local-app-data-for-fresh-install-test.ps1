param(
  [switch]$Apply,
  [switch]$IncludeLocalCache,
  [switch]$NoProcessStop
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appData = [Environment]::GetFolderPath('ApplicationData')
$localAppData = [Environment]::GetFolderPath('LocalApplicationData')

function Write-Info {
  param([string]$Message)
  Write-Host $Message
}

function Assert-OutsideRepo {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  $repoFull = [System.IO.Path]::GetFullPath($repoRoot).TrimEnd('\')
  if ($full.TrimEnd('\').StartsWith($repoFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to reset a path inside the repo: $full"
  }
}

function Assert-SafeTarget {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'Refusing to use an empty reset path.'
  }

  $full = [System.IO.Path]::GetFullPath($Path)
  Assert-OutsideRepo $full

  if ($full -match 'production-ready|desktop\\dist|dist-notification-manager|frontend\\build|google-service-account\.json') {
    throw "Refusing unsafe reset path: $full"
  }

  return $full
}

function New-Target {
  param(
    [string]$Label,
    [string]$Path,
    [string]$Reason,
    [bool]$Default = $true
  )

  [pscustomobject]@{
    Label = $Label
    Path = Assert-SafeTarget $Path
    Reason = $Reason
    Default = $Default
    Exists = Test-Path -LiteralPath $Path
  }
}

function Stop-AppProcesses {
  foreach ($name in @('Mock Testing Suite', 'Sam', 'SAM', 'backend')) {
    $processes = Get-Process -Name $name -ErrorAction SilentlyContinue
    foreach ($process in $processes) {
      try {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        Write-Info "Stopped process: $name ($($process.Id))"
      } catch {
        Write-Warning "Unable to stop $name ($($process.Id)): $($_.Exception.Message)"
      }
    }
  }
}

function Assert-NoCredentialFiles {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $credentialFiles = Get-ChildItem -LiteralPath $Path -Recurse -Force -Filter 'google-service-account.json' -ErrorAction SilentlyContinue
  if ($credentialFiles) {
    $paths = ($credentialFiles | ForEach-Object { $_.FullName }) -join '; '
    throw "Refusing to delete target because credential file(s) were found: $paths"
  }
}

$targets = @(
  # Electron userData for MTS. Contains mock_testing_suite.sqlite3, logs,
  # electron-store config, Chromium Local Storage, Session Storage, IndexedDB,
  # and tutorial/setup state persisted by the packaged app.
  New-Target 'MTS roaming userData' (Join-Path $appData 'Mock Testing Suite') 'Fresh-install state for Mock Testing Suite.'

  # Electron userData for SAM. Contains the SAM SQLite/settings/logs and
  # Chromium storage used by the notification manager UI.
  New-Target 'SAM roaming userData' (Join-Path $appData 'Sam') 'Fresh-install state for Sam.'
)

if ($IncludeLocalCache) {
  $targets += @(
    # Optional Electron/Chromium cache locations. These should not be needed
    # for setup/tutorial reset, but can be useful if a local cache survives.
    New-Target 'MTS local cache' (Join-Path $localAppData 'Mock Testing Suite') 'Optional local cache for Mock Testing Suite.' $false
    New-Target 'SAM local cache' (Join-Path $localAppData 'Sam') 'Optional local cache for Sam.' $false
  )
}

Write-Info 'LOCAL TESTING ONLY - fresh install app-data reset'
Write-Info 'This script does not touch source files, repo files, build outputs, production-ready, Google Sheets, Supabase, or credentials.'
Write-Info ''
Write-Info "Repo guard: $repoRoot"
Write-Info "Mode:       $(if ($Apply) { 'APPLY' } else { 'DRY RUN' })"
Write-Info ''
Write-Info 'Planned targets:'
foreach ($target in $targets) {
  Write-Info "[$(if ($target.Exists) { 'exists' } else { 'missing' })] $($target.Label)"
  Write-Info "  Path:   $($target.Path)"
  Write-Info "  Reason: $($target.Reason)"
}

if (-not $Apply) {
  Write-Info ''
  Write-Info 'Dry run complete. Nothing was deleted.'
  Write-Info 'To reset local app data, rerun with:'
  Write-Info '  dev-tools\reset-local-app-data-for-fresh-install-test.ps1 -Apply'
  Write-Info 'Add -IncludeLocalCache only if you also want app-specific LOCALAPPDATA cache folders removed.'
  exit 0
}

Write-Info ''
$confirmation = Read-Host 'Type RESET to delete the listed local app-data folders'
if ($confirmation -ne 'RESET') {
  Write-Info 'Reset cancelled. Nothing was deleted.'
  exit 1
}

if (-not $NoProcessStop) {
  Stop-AppProcesses
}

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target.Path)) {
    Write-Info "Skipping missing target: $($target.Path)"
    continue
  }

  Assert-NoCredentialFiles $target.Path
  Remove-Item -LiteralPath $target.Path -Recurse -Force
  Write-Info "Removed: $($target.Path)"
}

Write-Info ''
Write-Info 'Reset complete. Restart MTS/SAM to test fresh-install behavior.'
Write-Info 'Expected MTS result: Setup Wizard appears, then the Tutorial can auto-start after setup.'
Write-Info 'Expected SAM result: SAM setup/onboarding state is cleared.'
