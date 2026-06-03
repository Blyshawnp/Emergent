param(
  [Parameter(Mandatory=$true)]
  [string]$DistDir,

  [Parameter(Mandatory=$true)]
  [string]$InstallerName
)

$ErrorActionPreference = 'Stop'

function Fail {
  param([string]$Message)
  Write-Host "[release-asset-validation] ERROR: $Message" -ForegroundColor Red
  exit 1
}

function Get-Sha512Base64 {
  param([string]$Path)
  $sha = [System.Security.Cryptography.SHA512]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return [Convert]::ToBase64String($sha.ComputeHash($stream))
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

$resolvedDist = (Resolve-Path -LiteralPath $DistDir).Path
$latestPath = Join-Path $resolvedDist 'latest.yml'
$installerPath = Join-Path $resolvedDist $InstallerName
$blockmapPath = Join-Path $resolvedDist "$InstallerName.blockmap"

if (-not (Test-Path -LiteralPath $latestPath)) { Fail "Missing latest.yml: $latestPath" }
if (-not (Test-Path -LiteralPath $installerPath)) { Fail "Missing installer: $installerPath" }
if (-not (Test-Path -LiteralPath $blockmapPath)) { Fail "Missing blockmap: $blockmapPath" }

$latestText = Get-Content -LiteralPath $latestPath -Raw
$pathMatch = [regex]::Match($latestText, '(?m)^path:\s*(.+?)\s*$')
$urlMatch = [regex]::Match($latestText, '(?m)^\s*-\s*url:\s*(.+?)\s*$')
$shaMatch = [regex]::Match($latestText, '(?m)^sha512:\s*(.+?)\s*$')

if (-not $pathMatch.Success) { Fail "latest.yml does not contain a top-level path field." }
if (-not $urlMatch.Success) { Fail "latest.yml does not contain files[0].url." }
if (-not $shaMatch.Success) { Fail "latest.yml does not contain a top-level sha512 field." }

$latestPathName = $pathMatch.Groups[1].Value.Trim().Trim("'`"")
$latestUrlName = $urlMatch.Groups[1].Value.Trim().Trim("'`"")
$latestSha512 = $shaMatch.Groups[1].Value.Trim()
$actualSha512 = Get-Sha512Base64 $installerPath
$installerSize = (Get-Item -LiteralPath $installerPath).Length

Write-Host "[release-asset-validation] latest.yml: $latestPath"
Write-Host "[release-asset-validation] installer:  $InstallerName"
Write-Host "[release-asset-validation] size:       $installerSize"
Write-Host "[release-asset-validation] yml path:   $latestPathName"
Write-Host "[release-asset-validation] yml url:    $latestUrlName"
Write-Host "[release-asset-validation] yml sha512: $latestSha512"
Write-Host "[release-asset-validation] exe sha512: $actualSha512"

if ($latestPathName -cne $InstallerName) {
  Fail "latest.yml path '$latestPathName' does not match expected installer '$InstallerName'."
}

if ($latestUrlName -cne $InstallerName) {
  Fail "latest.yml files[0].url '$latestUrlName' does not match expected installer '$InstallerName'."
}

if ($latestSha512 -cne $actualSha512) {
  Fail "latest.yml sha512 does not match the local installer. Rebuild and upload latest.yml, installer, and blockmap from the same build."
}

Write-Host "[release-asset-validation] OK: latest.yml matches installer and blockmap from this build."
