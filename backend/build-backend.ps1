$ErrorActionPreference = "Stop"

$backendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $backendRoot
Set-Location $backendRoot

function Resolve-BuildPython {
  if ($env:MTS_BUILD_PYTHON -and (Test-Path -LiteralPath $env:MTS_BUILD_PYTHON)) {
    return $env:MTS_BUILD_PYTHON
  }

  $repoPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
  if (Test-Path -LiteralPath $repoPython) {
    return $repoPython
  }

  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python -and $python.Source -notmatch "\\Microsoft\\WindowsApps\\") {
    return $python.Source
  }

  throw "A real Python interpreter was not found. Create .venv or set MTS_BUILD_PYTHON to python.exe."
}

$pythonExe = Resolve-BuildPython
Write-Host "Using Python: $pythonExe"
$requirementsPath = Join-Path $backendRoot "requirements.txt"

function Invoke-BuildPython {
  param(
    [string]$Label,
    [string[]]$Arguments
  )

  & $pythonExe @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

if (Test-Path -LiteralPath $requirementsPath) {
  Invoke-BuildPython 'Backend requirements install' @('-m', 'pip', 'install', '-r', $requirementsPath, 'pyinstaller', '-q')
} else {
  & $pythonExe -m PyInstaller --version > $null 2>&1
  if ($LASTEXITCODE -ne 0) {
    Invoke-BuildPython 'PyInstaller install' @('-m', 'pip', 'install', 'pyinstaller', '-q')
  }
}

Invoke-BuildPython 'Backend PyInstaller build' @('-m', 'PyInstaller', '--noconfirm', "$backendRoot\backend.spec")

Write-Host ""
Write-Host "Backend build complete:"
Write-Host "  $backendRoot\dist\backend.exe"
