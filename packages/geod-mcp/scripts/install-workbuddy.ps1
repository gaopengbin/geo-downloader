param(
    [string]$Workspace = (Get-Location).Path,
    [string]$ConfigPath = (Join-Path $env:USERPROFILE '.workbuddy\mcp.json')
)
$ErrorActionPreference = 'Stop'
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entrypoint = Join-Path $packageRoot 'src\index.mjs'
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $entrypoint)) { throw 'GeoD MCP entrypoint is missing.' }
$oldWorkspace = $env:GEOD_WORKSPACE
try {
    $env:GEOD_WORKSPACE = $workspacePath
    & $node (Join-Path $PSScriptRoot 'self-check.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'GeoD MCP tool-call verification failed.' }
} finally { $env:GEOD_WORKSPACE = $oldWorkspace }
$target = [System.IO.Path]::GetFullPath($ConfigPath)
$parent = [System.IO.Path]::GetDirectoryName($target)
if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
$config = if (Test-Path -LiteralPath $target) { Get-Content -LiteralPath $target -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if (-not $config.mcpServers) { $config | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force }
$existing = $config.mcpServers.geod
if ($existing) {
    if ($existing.command -ne $node -or $existing.args.Count -ne 1 -or $existing.args[0] -ne $entrypoint -or $existing.env.GEOD_WORKSPACE -ne $workspacePath) {
        throw 'A different geod MCP registration already exists in WorkBuddy. Inspect it before replacing it.'
    }
} else {
    $geod = [pscustomobject]@{ command = $node; args = @($entrypoint); env = [pscustomobject]@{ GEOD_WORKSPACE = $workspacePath } }
    $config.mcpServers | Add-Member -NotePropertyName geod -NotePropertyValue $geod
    $json = $config | ConvertTo-Json -Depth 100
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    if (Test-Path -LiteralPath $target) {
        $backup = $target + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        [System.IO.File]::Copy($target, $backup)
    }
    [System.IO.File]::WriteAllText($target, $json + "`n", $utf8)
}
$readback = Get-Content -LiteralPath $target -Raw | ConvertFrom-Json
if ($readback.mcpServers.geod.command -ne $node -or $readback.mcpServers.geod.args[0] -ne $entrypoint) { throw 'WorkBuddy MCP configuration readback failed.' }
@{ ok = $true; config = $target; server = 'geod'; workspace = $workspacePath; clientToolCallVerified = $false } | ConvertTo-Json -Compress
