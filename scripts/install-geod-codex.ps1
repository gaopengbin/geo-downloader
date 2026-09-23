param(
    [Parameter(Mandatory = $true)][string]$PackageSpec,
    [string]$Workspace = (Get-Location).Path,
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'GeoD\Agent')
)
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
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
    if ($existing.transport.command -ne $node -or $existing.transport.args.Count -ne 1 -or $existing.transport.args[0] -ne $entrypoint -or $existing.transport.env.GEOD_WORKSPACE -ne $workspacePath) {
        throw 'A different geod MCP registration already exists in Codex. Inspect it before replacing it.'
    }
}
New-Item -ItemType Directory -Path $installPath -Force | Out-Null
& npm.cmd install --prefix $installPath --ignore-scripts --no-audit --no-fund --no-save --no-package-lock $PackageSpec
if ($LASTEXITCODE -ne 0) { throw 'GeoD MCP installation failed.' }
$packageRoot = Join-Path $installPath 'node_modules\geod-mcp'
$cli = Join-Path $installPath 'node_modules\geod-cli\native\geod.exe'
if (-not (Test-Path -LiteralPath $entrypoint)) { throw 'Installed MCP entrypoint is missing.' }
if (-not (Test-Path -LiteralPath $cli)) { throw 'Installed GeoD native executable is missing.' }
$oldWorkspace = $env:GEOD_WORKSPACE
try {
    $env:GEOD_WORKSPACE = $workspacePath
    & $node (Join-Path $packageRoot 'scripts\self-check.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'GeoD MCP tool-call verification failed.' }
} finally { $env:GEOD_WORKSPACE = $oldWorkspace }
if (-not $existing) {
    & $codex mcp add geod --env "GEOD_WORKSPACE=$workspacePath" -- $node $entrypoint
    if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed.' }
}
$skillSource = Join-Path $packageRoot 'skill\geod-agent'
function Normalize-GeoDSkill([string]$Content) { return ($Content -replace "`r`n", "`n").TrimEnd() }
if (Test-Path -LiteralPath $skillDestination) {
    $current = Get-Content -LiteralPath (Join-Path $skillDestination 'SKILL.md') -Raw
    $incoming = Get-Content -LiteralPath (Join-Path $skillSource 'SKILL.md') -Raw
    if ((Normalize-GeoDSkill $current) -ne (Normalize-GeoDSkill $incoming)) {
        $previous = Get-Content -LiteralPath (Join-Path $packageRoot 'scripts\geod-agent-0.1.0.md') -Raw
        if ((Normalize-GeoDSkill $current) -ne (Normalize-GeoDSkill $previous)) { throw 'A modified geod-agent skill already exists. Inspect it before replacing it.' }
        $skillFile = Join-Path $skillDestination 'SKILL.md'
        $backup = $skillFile + '.backup-0.1.0-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item -LiteralPath $skillFile -Destination $backup
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($skillFile, $incoming, $utf8)
    }
} else {
    Copy-Item -LiteralPath $skillSource -Destination $skillDestination -Recurse
}
$registered = & $codex mcp get geod --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $registered.transport.command -ne $node) { throw 'Codex MCP readback failed.' }
@{ ok = $true; package = $packageRoot; workspace = $workspacePath; codexServer = 'geod'; skill = $skillDestination; entrypoint = $entrypoint } | ConvertTo-Json -Compress
