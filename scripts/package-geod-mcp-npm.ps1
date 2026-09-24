param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $repoRoot 'packages\geod-mcp'
$metadata = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot ('output\geod-mcp-package-' + $metadata.version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $destination) { throw "Output already exists: $destination" }
$stage = Join-Path $destination 'stage'
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($file in @('package.json', 'README.md')) { Copy-Item -LiteralPath (Join-Path $source $file) -Destination $stage }
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $stage
Copy-Item -LiteralPath (Join-Path $source 'src') -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $source 'bin') -Destination $stage -Recurse
Copy-Item -LiteralPath (Join-Path $source 'skill') -Destination $stage -Recurse
New-Item -ItemType Directory -Path (Join-Path $stage 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'scripts\self-check.mjs') -Destination (Join-Path $stage 'scripts\self-check.mjs')
Copy-Item -LiteralPath (Join-Path $source 'scripts\geod-agent-0.1.0.md') -Destination (Join-Path $stage 'scripts\geod-agent-0.1.0.md')
Copy-Item -LiteralPath (Join-Path $source 'scripts\geod-agent-0.1.2.md') -Destination (Join-Path $stage 'scripts\geod-agent-0.1.2.md')
Copy-Item -LiteralPath (Join-Path $source 'scripts\geod-agent-0.1.3.md') -Destination (Join-Path $stage 'scripts\geod-agent-0.1.3.md')
Copy-Item -LiteralPath (Join-Path $source 'scripts\install-skill.ps1') -Destination (Join-Path $stage 'scripts\install-skill.ps1')
Copy-Item -LiteralPath (Join-Path $source 'scripts\install-workbuddy.ps1') -Destination (Join-Path $stage 'scripts\install-workbuddy.ps1')
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\install-geod-codex.ps1') -Destination (Join-Path $stage 'scripts\install-geod-codex.ps1')
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\install-geod-workbuddy.ps1') -Destination (Join-Path $stage 'scripts\install-geod-workbuddy.ps1')
New-Item -ItemType Directory -Path (Join-Path $stage 'examples') | Out-Null
foreach ($name in @('sichuan-overview.json', 'henan-overview.json')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "examples\geod-cli\$name") -Destination (Join-Path $stage 'examples')
}
Push-Location $stage
try {
    $packResult = & npm.cmd pack --json --ignore-scripts --pack-destination $destination 2>&1
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed: $packResult" }
} finally { Pop-Location }
$packed = ($packResult | Out-String | ConvertFrom-Json)[0]
$tarball = Join-Path $destination $packed.filename
if (-not (Test-Path -LiteralPath $tarball)) { throw 'npm pack did not create the expected tarball.' }
$stream = [System.IO.File]::OpenRead($tarball)
$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $hash = [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $hasher.Dispose() }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(($tarball + '.sha256'), "$hash  $($packed.filename)`n", $utf8)
@{ ok = $true; tarball = $tarball; sha256 = $hash; stage = $stage } | ConvertTo-Json -Compress
