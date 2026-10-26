# Adds "Guitar Pro (synced)" entries to the Windows "Send to" menu.
# Run windows\install.cmd [output folder]
#   (or: powershell -ExecutionPolicy Bypass -File install-sendto.ps1 [-OutDir <folder>] [-Uninstall])
# With an output folder every .gp is written there; without one, next to its .psarc.
# The entries start node.exe directly. A .cmd wrapper would go through cmd.exe, which splits file names
# at & and mangles ^ and %, and refuses command lines over 8191 characters (about 75 selected files).
param([string]$OutDir, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$cli = Join-Path $root 'bin\psarc2gp.js'
$sendTo = [Environment]::GetFolderPath('SendTo')
$entries = @(
  @{ Name = 'Guitar Pro (synced).lnk'; Options = '--pause' },
  @{ Name = 'Guitar Pro (synced, overwrite).lnk'; Options = '--pause --force' }
)

if ($Uninstall) {
  foreach ($e in $entries) { Remove-Item -ErrorAction SilentlyContinue (Join-Path $sendTo $e.Name) }
  Write-Host 'Removed the Send To entries.'
  exit 0
}

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
  Write-Host 'Node.js 20 or newer is required. Install the LTS version from https://nodejs.org and run this again.' -ForegroundColor Yellow
  exit 1
}
$version = (& $node.Source --version).TrimStart('v')
if ([int]($version.Split('.')[0]) -lt 20) {
  Write-Host "Node.js $version found; version 20 or newer is required." -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path (Join-Path $root 'node_modules\@coderline\alphatab'))) {
  Write-Host 'Installing dependencies...'
  Push-Location $root
  try { & npm install --omit=dev --ignore-scripts --no-audit --no-fund } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'Installing dependencies failed; see the messages above.' -ForegroundColor Yellow
    exit 1
  }
}

$outArg = ''
if ($OutDir) {
  # "C:\a b\" arrives as C:\a b" (the backslash escapes the quote), so drop stray quotes
  $OutDir = $OutDir.Trim('"')
  if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) {
    Write-Host "Output folder not found: $OutDir" -ForegroundColor Yellow
    exit 1
  }
  $OutDir = (Resolve-Path -LiteralPath $OutDir).ProviderPath
  if ($OutDir.Length -gt 3) { $OutDir = $OutDir.TrimEnd('\', '/') }
  # a backslash right before the closing quote (a drive root, G:\) must be doubled
  $outArg = ' -o "' + ($OutDir -replace '\\$', '\\') + '"'
}

# Guitar Pro's icon makes the entries easy to spot (otherwise they show Node's icon)
$gp = Join-Path $env:ProgramFiles 'Arobas Music\Guitar Pro 8\GuitarPro.exe'
$shell = New-Object -ComObject WScript.Shell
foreach ($e in $entries) {
  $lnk = $shell.CreateShortcut((Join-Path $sendTo $e.Name))
  $lnk.TargetPath = $node.Source
  $lnk.Arguments = "`"$cli`" $($e.Options)$outArg"
  $lnk.WorkingDirectory = $root
  if (Test-Path $gp) { $lnk.IconLocation = "$gp,0" }
  $lnk.Description = 'Convert Rocksmith .psarc to a Guitar Pro file synced to the recording'
  $lnk.Save()
}
Write-Host ''
Write-Host 'Installed. Right-click .psarc files or a folder > Send to > Guitar Pro (synced).' -ForegroundColor Green
Write-Host '(On Windows 11 the Send to menu is under "Show more options", or press Shift+F10.)'
if ($OutDir) { Write-Host "Converted files go to $OutDir. Run this again without a folder to write them next to each .psarc." }
else { Write-Host 'Converted files go next to each .psarc. To use one folder instead: install.cmd "<folder>"' }
Write-Host "The entries run $($node.Source); if you move this folder or reinstall Node.js elsewhere, run this again."
