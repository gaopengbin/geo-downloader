param(
    [Parameter(Mandatory = $true)][string]$PackageSpec,
    [string]$Workspace = (Join-Path $env:LOCALAPPDATA 'GeoD\Workspace'),
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'GeoD\Agent')
)
$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
if (-not (Test-Path -LiteralPath $workspacePath)) { New-Item -ItemType Directory -Path $workspacePath -Force | Out-Null }
$installPath = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $PackageSpec) { $PackageSpec = (Resolve-Path -LiteralPath $PackageSpec).Path }
New-Item -ItemType Directory -Path $installPath -Force | Out-Null
& npm.cmd install --prefix $installPath --ignore-scripts --no-audit --no-fund --no-save --no-package-lock $PackageSpec
if ($LASTEXITCODE -ne 0) { throw 'GeoD MCP installation failed.' }
$installer = Join-Path $installPath 'node_modules\geod-mcp\scripts\install-workbuddy.ps1'
if (-not (Test-Path -LiteralPath $installer)) { throw 'Installed WorkBuddy integration script is missing.' }
& $installer -Workspace $workspacePath
if ($LASTEXITCODE -ne 0) { throw 'WorkBuddy MCP registration failed.' }
