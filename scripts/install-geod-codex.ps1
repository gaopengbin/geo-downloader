param(
    [Parameter(Mandatory = $true)][string]$PackageSpec,
    [string]$Workspace = (Join-Path $env:LOCALAPPDATA 'GeoD\Workspace'),
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'GeoD\Agent')
)
$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath($Workspace)
if (-not (Test-Path -LiteralPath $workspacePath)) { New-Item -ItemType Directory -Path $workspacePath -Force | Out-Null }
$installPath = [System.IO.Path]::GetFullPath($Destination)
$node = (Get-Command node.exe -ErrorAction Stop).Source
$codex = (Get-Command codex.cmd -ErrorAction Stop).Source
if ([int]([string]( & $node --version)).TrimStart('v').Split('.')[0] -lt 22) { throw 'GeoD MCP requires Node.js 22 or newer.' }
if (Test-Path -LiteralPath $PackageSpec) { $PackageSpec = (Resolve-Path -LiteralPath $PackageSpec).Path }
$entrypoint = Join-Path $installPath 'node_modules\geod-mcp\src\index.mjs'
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$skillDestination = Join-Path $codexHome 'skills\geod-agent'
$configured = & $codex mcp list --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect existing Codex MCP servers.' }
$existing = $configured | Where-Object { $_.name -eq 'geod' } | Select-Object -First 1
if ($existing) {
    if ($existing.transport.command -ne $node -or $existing.transport.args.Count -ne 1 -or $existing.transport.args[0] -ne $entrypoint -or @($existing.transport.env.PSObject.Properties).Count -ne 1) {
        throw 'A different geod MCP registration already exists in Codex. Inspect it before replacing it.'
    }
}
New-Item -ItemType Directory -Path $installPath -Force | Out-Null
& npm.cmd install --prefix $installPath --ignore-scripts --no-audit --no-fund --no-save --no-package-lock $PackageSpec
if ($LASTEXITCODE -ne 0) { throw 'GeoD MCP installation failed.' }
$packageRoot = Join-Path $installPath 'node_modules\geod-mcp'
$cli = Join-Path $packageRoot 'bin\geod.exe'
if (-not (Test-Path -LiteralPath $entrypoint)) { throw 'Installed MCP entrypoint is missing.' }
if (-not (Test-Path -LiteralPath $cli)) { throw 'Installed GeoD native executable is missing.' }
$oldWorkspace = $env:GEOD_WORKSPACE
try {
    $env:GEOD_WORKSPACE = $workspacePath
    & $node (Join-Path $packageRoot 'scripts\self-check.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'GeoD MCP tool-call verification failed.' }
} finally { $env:GEOD_WORKSPACE = $oldWorkspace }
if ($existing -and $existing.transport.env.GEOD_WORKSPACE -ne $workspacePath) {
    $codexConfig = Join-Path $codexHome 'config.toml'
    if (-not (Test-Path -LiteralPath $codexConfig)) { throw 'Codex config.toml is missing; cannot back up the existing geod registration.' }
    $backup = $codexConfig + '.backup-geod-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $codexConfig -Destination $backup
    & $codex mcp remove geod
    if ($LASTEXITCODE -ne 0) { throw "Could not remove the old geod registration; backup: $backup" }
    try {
        & $codex mcp add geod --env "GEOD_WORKSPACE=$workspacePath" -- $node $entrypoint
        if ($LASTEXITCODE -ne 0) { throw 'Could not register GeoD with the new workspace.' }
    } catch {
        Copy-Item -LiteralPath $backup -Destination $codexConfig -Force
        throw
    }
} elseif (-not $existing) {
    & $codex mcp add geod --env "GEOD_WORKSPACE=$workspacePath" -- $node $entrypoint
    if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed.' }
}
& (Join-Path $packageRoot 'scripts\install-skill.ps1') -PackageRoot $packageRoot -Destination $skillDestination
if ($LASTEXITCODE -ne 0) { throw 'GeoD Agent Skill installation failed.' }
$registered = & $codex mcp get geod --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $registered.transport.command -ne $node) { throw 'Codex MCP readback failed.' }
@{ ok = $true; package = $packageRoot; workspace = $workspacePath; codexServer = 'geod'; skill = $skillDestination; entrypoint = $entrypoint } | ConvertTo-Json -Compress
