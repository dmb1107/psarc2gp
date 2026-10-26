# Builds the Explorer preview pane add-in for Guitar Pro (.gp) files and installs it.
# Run windows\install-preview.cmd (or: powershell -ExecutionPolicy Bypass -File install.ps1 [-Uninstall])
#
# The COM class is registered machine-wide (HKLM, one admin prompt: this script runs itself elevated
# with -Machine); the .gp association and the handler list entry are per-user. (Machine-wide was chosen
# on a wrong diagnosis, see docs/HANDOFF.md; a fully per-user install would probably work too.)
param([switch]$Uninstall, [switch]$Machine)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)
$name = 'Guitar Pro preview (psarc2gp)'
$clsid = '{97b4eb14-d693-49c4-b493-63f71eda831f}'
$classKey = "HKLM:\SOFTWARE\Classes\CLSID\$clsid"
$userClassKey = "HKCU:\Software\Classes\CLSID\$clsid" # where earlier versions registered it
# {8895b1c6-...} is IPreviewHandler: the preview handler for .gp files, whichever app opens them. A
# per-user .gp key with no values of its own leaves Guitar Pro's machine-wide "open" mapping in effect.
$gpKey = 'HKCU:\Software\Classes\.gp'
$assocKey = "$gpKey\shellex\{8895b1c6-b41f-4c1c-a562-0d564250836f}"
$oldAssocKey = 'HKCU:\Software\Classes\SystemFileAssociations\.gp' # earlier versions; Explorer's preview pane ignores it
$listKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PreviewHandlers'
$dll = Join-Path $here 'bin\Psarc2gpPreview.dll'

# create missing keys one level at a time; New-Item -Force would wipe a key that already exists
function Initialize-Key([string]$path) {
  if (Test-Path -LiteralPath $path) { return }
  Initialize-Key (Split-Path -Parent $path)
  New-Item -Path $path | Out-Null
}

# --- elevated part: the COM class ---
if ($Machine) {
  if ($Uninstall) {
    if (Test-Path -LiteralPath $classKey) { Remove-Item -LiteralPath $classKey -Recurse }
    exit 0
  }
  $version = [Reflection.AssemblyName]::GetAssemblyName($dll).Version.ToString()
  # a .NET Framework COM class: mscoree.dll loads the assembly from CodeBase
  $server = [ordered]@{
    '(default)'    = 'mscoree.dll'
    ThreadingModel = 'Apartment'
    Class          = 'Psarc2gp.Preview.GpPreviewHandler'
    Assembly       = "Psarc2gpPreview, Version=$version, Culture=neutral, PublicKeyToken=null"
    RuntimeVersion = 'v4.0.30319'
    CodeBase       = ([Uri]$dll).AbsoluteUri
  }
  Initialize-Key $classKey
  Set-ItemProperty -LiteralPath $classKey -Name '(default)' -Value $name
  Set-ItemProperty -LiteralPath $classKey -Name DisplayName -Value $name
  # Explorer's 64-bit preview host, at normal integrity: WebView2 can't start in a low-integrity process
  Set-ItemProperty -LiteralPath $classKey -Name AppID -Value '{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}'
  New-ItemProperty -LiteralPath $classKey -Name DisableLowILProcessIsolation -PropertyType DWord -Value 1 -Force | Out-Null
  foreach ($k in "$classKey\InprocServer32", "$classKey\InprocServer32\$version") {
    Initialize-Key $k
    foreach ($v in $server.GetEnumerator()) { Set-ItemProperty -LiteralPath $k -Name $v.Key -Value $v.Value }
  }
  exit 0
}

# --- user part ---
Add-Type -Namespace Psarc2gp -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'
function Update-Explorer { [Psarc2gp.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) } # SHCNE_ASSOCCHANGED

# prevhost.exe keeps the add-in loaded, so the files can't be replaced while it runs. Stopping it only
# blanks open previews; Explorer starts it again for the next one.
function Stop-PreviewHost {
  $p = Get-Process prevhost -ErrorAction SilentlyContinue
  if ($p) { $p | Stop-Process -Force; Start-Sleep -Milliseconds 500 }
}

function Invoke-Elevated([string[]]$extra) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Machine') + $extra
  try { $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden }
  catch { Write-Host 'Windows asked for admin rights and they were not given; nothing was changed.' -ForegroundColor Yellow; exit 1 }
  if ($p.ExitCode -ne 0) { Write-Host "Registering the add-in failed (exit code $($p.ExitCode))." -ForegroundColor Yellow; exit 1 }
}

# remove a key only if nothing else is left in it (the .gp keys may be shared with other software)
function Remove-EmptyKey([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $k = Get-Item -LiteralPath $path
  if ($k.ValueCount -eq 0 -and $k.SubKeyCount -eq 0) { Remove-Item -LiteralPath $path }
}

if ($Uninstall) {
  Invoke-Elevated @('-Uninstall')
  foreach ($k in $assocKey, $userClassKey, $oldAssocKey) { if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse } }
  Remove-EmptyKey "$gpKey\shellex"
  Remove-EmptyKey $gpKey
  if (Test-Path -LiteralPath $listKey) { Remove-ItemProperty -LiteralPath $listKey -Name $clsid -ErrorAction SilentlyContinue }
  Update-Explorer
  Stop-PreviewHost
  Write-Host 'Removed the Guitar Pro preview.'
  exit 0
}

$dotnet = Get-Command dotnet -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $dotnet) {
  Write-Host 'Building the preview needs the .NET SDK: winget install Microsoft.DotNet.SDK.10, then run this again.' -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path (Join-Path $root 'node_modules\@coderline\alphatab\dist\alphaTab.min.js'))) {
  Write-Host 'Run windows\install.cmd first; it installs alphaTab, which the preview uses.' -ForegroundColor Yellow
  exit 1
}

Write-Host 'Building...'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
Stop-PreviewHost
& $dotnet.Source build (Join-Path $here 'Psarc2gpPreview.csproj') -c Release -nologo -v q
if ($LASTEXITCODE -ne 0) {
  Write-Host 'The build failed; see the messages above.' -ForegroundColor Yellow
  exit 1
}

Write-Host 'Registering (Windows will ask for admin rights)...'
Invoke-Elevated @()
foreach ($k in $userClassKey, $oldAssocKey) { if (Test-Path -LiteralPath $k) { Remove-Item -LiteralPath $k -Recurse } }
Initialize-Key $assocKey
Set-ItemProperty -LiteralPath $assocKey -Name '(default)' -Value $clsid
Initialize-Key $listKey
Set-ItemProperty -LiteralPath $listKey -Name $clsid -Value $name
Update-Explorer

Write-Host ''
Write-Host 'Installed. In Explorer, turn on the preview pane (View > Preview pane, or Alt+P) and select a .gp file.' -ForegroundColor Green
Write-Host 'If you move the psarc2gp folder, run this again.'
