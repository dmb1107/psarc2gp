# Adds "Guitar Pro (synced)" entries to the Windows "Send to" menu.
# Run windows\install.cmd (or: powershell -ExecutionPolicy Bypass -File install-sendto.ps1 [-Uninstall])
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$sendTo = [Environment]::GetFolderPath('SendTo')
$entries = @(
  @{ Name = 'Guitar Pro (synced).lnk'; Target = Join-Path $here 'psarc2gp.cmd' },
  @{ Name = 'Guitar Pro (synced, overwrite).lnk'; Target = Join-Path $here 'psarc2gp-overwrite.cmd' }
)

if ($Uninstall) {
  foreach ($e in $entries) { Remove-Item -ErrorAction SilentlyContinue (Join-Path $sendTo $e.Name) }
  Write-Host 'Removed the Send To entries.'
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js 20 or newer is required. Install the LTS version from https://nodejs.org and run this again.' -ForegroundColor Yellow
  exit 1
}
$version = (& node --version).TrimStart('v')
if ([int]($version.Split('.')[0]) -lt 20) {
  Write-Host "Node.js $version found; version 20 or newer is required." -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path (Join-Path $root 'node_modules\@coderline\alphatab'))) {
  Write-Host 'Installing dependencies...'
  Push-Location $root
  try { & npm install --omit=dev --ignore-scripts --no-audit --no-fund } finally { Pop-Location }
}

$shell = New-Object -ComObject WScript.Shell
foreach ($e in $entries) {
  $lnk = $shell.CreateShortcut((Join-Path $sendTo $e.Name))
  $lnk.TargetPath = $e.Target
  $lnk.WorkingDirectory = $root
  $lnk.Description = 'Convert Rocksmith .psarc to a Guitar Pro file synced to the recording'
  $lnk.Save()
}
Write-Host ''
Write-Host 'Installed. Right-click .psarc files or a folder > Send to > Guitar Pro (synced).' -ForegroundColor Green
Write-Host '(On Windows 11 the Send to menu is under "Show more options", or press Shift+F10.)'
