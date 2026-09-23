param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $repoRoot 'packages\geod-mcp'
$packageInfo = [System.IO.File]::ReadAllText((Join-Path $sourcePath 'package.json')) | ConvertFrom-Json
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot "output\geod-mcp-$($packageInfo.version)-win-x64" }
$packagePath = [System.IO.Path]::GetFullPath($OutputDirectory)
$archivePath = "$packagePath.zip"
if ((Test-Path -LiteralPath $packagePath) -or (Test-Path -LiteralPath $archivePath)) { throw 'Output exists; choose a new -OutputDirectory.' }
$binaryPath = Join-Path $repoRoot 'target\release\geod.exe'
if (-not (Test-Path -LiteralPath $binaryPath)) { throw 'Build geod-cli --release first.' }
New-Item -ItemType Directory -Path $packagePath | Out-Null
foreach ($file in @('package.json', 'package-lock.json', 'README.md')) { Copy-Item -LiteralPath (Join-Path $sourcePath $file) -Destination $packagePath }
Copy-Item -LiteralPath (Join-Path $sourcePath 'src') -Destination $packagePath -Recurse
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $packagePath
foreach ($folder in @('bin', 'scripts', 'examples', 'docs')) { New-Item -ItemType Directory -Path (Join-Path $packagePath $folder) | Out-Null }
Copy-Item -LiteralPath $binaryPath -Destination (Join-Path $packagePath 'bin\geod.exe')
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\geod-render.mjs') -Destination (Join-Path $packagePath 'scripts\geod-render.mjs')
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\geod-cli.md') -Destination (Join-Path $packagePath 'docs')
Get-ChildItem -LiteralPath (Join-Path $repoRoot 'examples\geod-cli') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $packagePath 'examples') }
Push-Location $packagePath
try {
    & npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
} finally { Pop-Location }
$config = @{ mcpServers = @{ geod = @{ command = 'node'; args = @((Join-Path $packagePath 'src\index.mjs')); env = @{ GEOD_WORKSPACE = $packagePath; GEOSTYLE_URL = 'http://127.0.0.1:3100' } } } }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $packagePath 'mcp.config.json'), ($config | ConvertTo-Json -Depth 6), $utf8)
Compress-Archive -LiteralPath $packagePath -DestinationPath $archivePath
$stream = [System.IO.File]::OpenRead($archivePath)
$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $hash = [System.BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $hasher.Dispose() }
[System.IO.File]::WriteAllText("$archivePath.sha256", "$hash  $([System.IO.Path]::GetFileName($archivePath))`n", $utf8)
@{ ok = $true; package = $packagePath; archive = $archivePath; sha256 = $hash } | ConvertTo-Json -Compress
