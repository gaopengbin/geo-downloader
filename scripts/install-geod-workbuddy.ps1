param(
    [Parameter(Mandatory = $true)][string]$PackageSpec,
    [string]$Workspace = (Get-Location).Path,
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'GeoD\Agent')
)
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
$installPath = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $PackageSpec) { $PackageSpec = (Resolve-Path -LiteralPath $PackageSpec).Path }
New-Item -ItemType Directory -Path $installPath -Force | Out-Null
& npm.cmd install --prefix $installPath --ignore-scripts --no-audit --no-fund --no-save --no-package-lock $PackageSpec
if ($LASTEXITCODE -ne 0) { throw 'GeoD MCP installation failed.' }
$installer = Join-Path $installPath 'node_modules\geod-mcp\scripts\install-workbuddy.ps1'
if (-not (Test-Path -LiteralPath $installer)) { throw 'Installed WorkBuddy integration script is missing.' }
& powershell.exe -NoProfile -File $installer -Workspace $workspacePath
if ($LASTEXITCODE -ne 0) { throw 'WorkBuddy MCP registration failed.' }
