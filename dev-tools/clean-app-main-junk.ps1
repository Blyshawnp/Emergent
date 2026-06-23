param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $rootDir 'dev-tools\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$logFile = Join-Path $logDir "clean-app-main-junk-$stamp.log"

function Write-Log {
  param([string]$Message, [string]$Color = 'White')
  $Message | Tee-Object -FilePath $logFile -Append
}

function Section {
  param([string]$Title)
  Write-Log ''
  Write-Log '=================================='
  Write-Log $Title
  Write-Log '=================================='
}

# Lists of items to remove/skip
$filesToDelete = New-Object System.Collections.Generic.List[string]
$foldersToDelete = New-Object System.Collections.Generic.List[string]
$skippedPaths = New-Object System.Collections.Generic.List[string]

function Is-Protected {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  $name = [System.IO.Path]::GetFileName($full).ToLower()
  
  # 1. Exact forbidden filenames (anywhere)
  if ($name -in @('apps-script-api.json', 'google-service-account.json', 'service-account.json', 'runtime_config.json', 'server.py', 'packaged_backend.py', 'package.json', 'package-lock.json', 'yarn.lock')) {
    return $true
  }
  
  # 2. Crucial extensions we NEVER touch
  $ext = [System.IO.Path]::GetExtension($full).ToLower()
  if ($ext -eq '.env') {
    return $true
  }
  
  # 3. Path contains forbidden directory sub-paths
  $segments = $full.Split([System.IO.Path]::DirectorySeparatorChar)
  foreach ($seg in $segments) {
    $segLower = $seg.ToLower()
    if ($segLower -in @('.git', 'node_modules', 'production-ready', 'production-ready-backups', 'dist', 'dist-notification-manager', 'src', 'public', 'services', 'docs', 'memory', '.venv', '.venv-backend-build', '.venv-build')) {
      return $true
    }
  }

  # 4. Protect active databases in backend/data
  if ($full -match '\\backend\\data\\mock_testing_suite\.sqlite3$' -or $full -match '\\backend\\data\\[a-zA-Z0-9_-]+\.sqlite3$') {
    if ($full -match '\\backend\\data\\backups\\') {
      return $false
    }
    return $true
  }

  # 5. CSV/Markdown/PNG defaults
  if ($full -match '\\backend\\defaults\\') {
    return $true
  }
  
  return $false
}

# ============================================================
# MAIN SCANNING
# ============================================================

Section 'PLANNING APP-MAIN CLEANUP'
Write-Log "Dry-Run: $(if ($DryRun) { 'ENABLED' } else { 'DISABLED' })"
Write-Log "Root:    $rootDir"
Write-Log "Log:     $logFile"

# 1. Scan Root Files
$rootFiles = Get-ChildItem -LiteralPath $rootDir -File -Force -ErrorAction SilentlyContinue
foreach ($file in $rootFiles) {
  $name = $file.Name
  $path = $file.FullName
  $isJunk = $false

  if ($name -like "*.tmp" -or $name -like "*.bak" -or $name -like "*.old" -or $name -like "*.diff") {
    $isJunk = $true
  }
  elseif ($name -in @("mts-defaults.json", "mts-runtime.json", "test_result.md")) {
    $isJunk = $true
  }
  elseif ($name -like ".temp_*" -or $name -like "temp_*" -or $name -like "debug_*" -or $name -like "diagnostic_*" -or $name -like "compare-*") {
    $isJunk = $true
  }
  elseif ($name -like "*.log") {
    $isJunk = $true
  }
  elseif ($name -like "*latency*") {
    $isJunk = $true
  }

  if ($isJunk) {
    if (Is-Protected $path) {
      $skippedPaths.Add($path)
    } else {
      $filesToDelete.Add($path)
    }
  }
}

# 2. Scan folders recursively
# Python __pycache__ folders
$pycaches = Get-ChildItem -LiteralPath $rootDir -Directory -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { 
  $_.Name -eq '__pycache__' -and $_.FullName -notmatch '\\(\.git|node_modules|production-ready|production-ready-backups|dist|dist-notification-manager|src|public|services|docs|memory|\.venv|\.venv-backend-build|\.venv-build)\\'
}
foreach ($dir in $pycaches) {
  $path = $dir.FullName
  if (Is-Protected $path) {
    $skippedPaths.Add($path)
  } else {
    $foldersToDelete.Add($path)
  }
}

# .pytest_cache folders
$pytestCaches = Get-ChildItem -LiteralPath $rootDir -Directory -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { 
  $_.Name -eq '.pytest_cache' -and $_.FullName -notmatch '\\(\.git|node_modules|production-ready|production-ready-backups|dist|dist-notification-manager|src|public|services|docs|memory|\.venv|\.venv-backend-build|\.venv-build)\\'
}
foreach ($dir in $pytestCaches) {
  $path = $dir.FullName
  if (Is-Protected $path) {
    $skippedPaths.Add($path)
  } else {
    $foldersToDelete.Add($path)
  }
}

# .eslintcache files
$eslintCaches = Get-ChildItem -LiteralPath $rootDir -Filter ".eslintcache" -File -Recurse -Force -ErrorAction SilentlyContinue
foreach ($file in $eslintCaches) {
  $path = $file.FullName
  if (Is-Protected $path) {
    $skippedPaths.Add($path)
  } else {
    $filesToDelete.Add($path)
  }
}

# 3. Specific folders
# .antigravitycli/ at root
$antiDir = Join-Path $rootDir '.antigravitycli'
if (Test-Path -LiteralPath $antiDir) {
  if (Is-Protected $antiDir) {
    $skippedPaths.Add($antiDir)
  } else {
    $foldersToDelete.Add($antiDir)
  }
}

# frontend/node_modules/.cache
$feCacheDir = Join-Path $rootDir 'frontend\node_modules\.cache'
if (Test-Path -LiteralPath $feCacheDir) {
  if (Is-Protected $feCacheDir) {
    $skippedPaths.Add($feCacheDir)
  } else {
    $foldersToDelete.Add($feCacheDir)
  }
}

# 4. backend/data/backups/ files
$backupDir = Join-Path $rootDir 'backend\data\backups'
if (Test-Path -LiteralPath $backupDir) {
  $backups = Get-ChildItem -LiteralPath $backupDir -File -Force -ErrorAction SilentlyContinue
  foreach ($file in $backups) {
    $path = $file.FullName
    if ($file.Extension.ToLower() -eq '.sqlite3') {
      if (Is-Protected $path) {
        $skippedPaths.Add($path)
      } else {
        $filesToDelete.Add($path)
      }
    }
  }
}

# 5. dev-tools/logs older than 14 days
$logDirLocation = Join-Path $rootDir 'dev-tools\logs'
if (Test-Path -LiteralPath $logDirLocation) {
  $logs = Get-ChildItem -LiteralPath $logDirLocation -File -Force -ErrorAction SilentlyContinue
  $cutoff = (Get-Date).AddDays(-14)
  foreach ($file in $logs) {
    if ($file.LastWriteTime -lt $cutoff -and $file.Name -notlike "*clean-app-main-junk*") {
      $path = $file.FullName
      if (Is-Protected $path) {
        $skippedPaths.Add($path)
      } else {
        $filesToDelete.Add($path)
      }
    }
  }
}

# ============================================================
# DISPLAY PROPOSAL
# ============================================================

Section 'PROPOSED CLEANUP ITEMS'
if ($filesToDelete.Count -eq 0 -and $foldersToDelete.Count -eq 0) {
  Write-Log 'No temporary junk files or folders found to clean.'
} else {
  if ($foldersToDelete.Count -gt 0) {
    Write-Log 'FOLDERS TO REMOVE:'
    foreach ($f in $foldersToDelete) {
      Write-Log "  - [FOLDER] $f"
    }
  }
  if ($filesToDelete.Count -gt 0) {
    Write-Log 'FILES TO REMOVE:'
    foreach ($f in $filesToDelete) {
      Write-Log "  - [FILE]   $f"
    }
  }
}

if ($skippedPaths.Count -gt 0) {
  Write-Log ''
  Write-Log 'PROTECTED PATHS SKIPPED (SAFEGUARDED):'
  foreach ($s in $skippedPaths) {
    Write-Log "  - [PROTECTED] $s"
  }
}

if ($DryRun) {
  Section 'DRY-RUN COMPLETE'
  Write-Log 'Dry-run validation complete. No files or folders were deleted.'
  Write-Log "Log file: $logFile"
  exit 0
}

if ($filesToDelete.Count -eq 0 -and $foldersToDelete.Count -eq 0) {
  Section 'SUCCESS'
  Write-Log 'Nothing to clean. Cleanup complete.'
  Write-Log "Log file: $logFile"
  exit 0
}

# ============================================================
# USER CONFIRMATION
# ============================================================

Write-Log ''
Write-Log 'WARNING: This action is permanent.'
Write-Log 'Please review the proposed list above carefully.'
Write-Host 'Type CLEAN to continue: ' -NoNewline
$userInput = [System.Console]::ReadLine()

if (($userInput -eq $null) -or ($userInput.Trim() -ne 'CLEAN')) {
  Section 'CLEANUP CANCELED'
  Write-Log 'Cleanup canceled. No files or folders were deleted.'
  Write-Log "Log file: $logFile"
  exit 0
}

# ============================================================
# PERFORM CLEANUP
# ============================================================

Section 'PERFORMING CLEANUP'
$deletedFilesCount = 0
$deletedFoldersCount = 0
$permissionErrors = New-Object System.Collections.Generic.List[string]

# Delete Files
foreach ($file in $filesToDelete) {
  try {
    if (Test-Path -LiteralPath $file) {
      $item = Get-Item -LiteralPath $file
      if ($item.Attributes -match 'ReadOnly') {
        $item.Attributes = 'Normal'
      }
      Remove-Item -LiteralPath $file -Force -ErrorAction Stop
      Write-Log "Removed file: $file"
      $deletedFilesCount++
    }
  } catch {
    $permissionErrors.Add("Failed to remove file $file : $($_.Exception.Message)")
  }
}

# Delete Folders (deepest first)
$sortedFolders = $foldersToDelete | Sort-Object -Property Length -Descending
foreach ($folder in $sortedFolders) {
  try {
    if (Test-Path -LiteralPath $folder) {
      Get-ChildItem -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
        try { $_.Attributes = 'Normal' } catch {}
      }
      Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction Stop
      Write-Log "Removed folder: $folder"
      $deletedFoldersCount++
    }
  } catch {
    $permissionErrors.Add("Failed to remove folder $folder : $($_.Exception.Message)")
  }
}

Section 'CLEANUP SUMMARY'
Write-Log "Files deleted:            $deletedFilesCount"
Write-Log "Folders deleted:          $deletedFoldersCount"
Write-Log "Skipped protected paths:  $($skippedPaths.Count)"
if ($permissionErrors.Count -gt 0) {
  Write-Log "Permission errors:        $($permissionErrors.Count)"
  foreach ($err in $permissionErrors) {
    Write-Log "  - $err"
  }
} else {
  Write-Log 'Permission errors:        0'
}
Write-Log 'Cleanup complete.'
Write-Log "Log file: $logFile"
exit 0
