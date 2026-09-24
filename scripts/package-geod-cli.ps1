param(
    [switch]$SkipBuild,
    [string]$OutputDirectory,
    [string]$BinaryPath,
    [string]$SourceRevision
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packageToml = [System.IO.File]::ReadAllText((Join-Path $repoRoot 'crates\geod-cli\Cargo.toml'))
$versionMatch = [System.Text.RegularExpressions.Regex]::Match($packageToml, '(?m)^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"')
if (-not $versionMatch.Success) { throw 'Unable to read CLI package version.' }
$cliVersion = $versionMatch.Groups[1].Value
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot "output\geod-cli-$cliVersion-windows-x64"
}
$packagePath = [System.IO.Path]::GetFullPath($OutputDirectory)
$archivePath = "$packagePath.zip"
if ((Test-Path -LiteralPath $packagePath) -or (Test-Path -LiteralPath $archivePath)) {
    throw 'Package output already exists. Choose a new -OutputDirectory.'
}
if (-not $SkipBuild) {
    $savedRustFlags = $env:RUSTFLAGS
    Push-Location $repoRoot
    try {
        $env:RUSTFLAGS = '-C target-feature=+crt-static'
        & cargo build --locked --release --jobs 2 --target x86_64-pc-windows-msvc -p geod-cli
        if ($LASTEXITCODE -ne 0) { throw 'GeoD CLI release build failed.' }
    } finally { $env:RUSTFLAGS = $savedRustFlags; Pop-Location }
}
if (-not $BinaryPath) { $BinaryPath = Join-Path $repoRoot 'target\x86_64-pc-windows-msvc\release\geod.exe' }
if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) { throw 'Release geod.exe is missing.' }
$actualVersion = (& $BinaryPath --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $actualVersion -ne "geod $cliVersion") { throw "CLI binary version does not match $cliVersion." }
if ($SourceRevision) {
    if ($SourceRevision -notmatch '^[a-f0-9]{40}$') { throw 'SourceRevision must be a full Git commit hash.' }
    $actualHead = (& git -C $repoRoot rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualHead -ne $SourceRevision) { throw 'SourceRevision is not the current checkout.' }
    $sourceChanges = & git -C $repoRoot status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0 -or $sourceChanges) { throw 'Release provenance requires a clean tracked checkout.' }
}
New-Item -ItemType Directory -Path $packagePath | Out-Null
Copy-Item -LiteralPath $BinaryPath -Destination (Join-Path $packagePath 'geod.exe')
Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $packagePath
foreach ($folderName in @('docs', 'scripts', 'examples\geod-cli')) {
    New-Item -ItemType Directory -Path (Join-Path $packagePath $folderName) | Out-Null
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\geod-cli-0.2.md') -Destination (Join-Path $packagePath 'docs\geod-cli-0.2.md')
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\geod-render.mjs') -Destination (Join-Path $packagePath 'scripts\geod-render.mjs')
Get-ChildItem -LiteralPath (Join-Path $repoRoot 'examples\geod-cli') -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $packagePath 'examples\geod-cli')
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $packagePath 'README.txt'), @'
GeoD CLI for Windows x64

Start here: docs/geod-cli-0.2.md
  .\geod.exe --help
  .\geod.exe plan --request examples/geod-cli/henan-overview.json

Data acquisition needs no Tauri UI or Node runtime.
The package does not include map data.

Portable ZIP: extract, then run geod.exe by its full path (PATH is unchanged).
Windows installer: installs for the current user; open a new terminal afterward.
Full installation and first-run examples: docs/geod-cli-0.2.md.
Project and release: https://github.com/gaopengbin/geo-downloader/releases/tag/geod-cli-v0.2.0
'@, $utf8)
$binaryStream = [System.IO.File]::OpenRead($BinaryPath)
$binaryHasher = [System.Security.Cryptography.SHA256]::Create()
try { $binaryHash = [System.BitConverter]::ToString($binaryHasher.ComputeHash($binaryStream)).Replace('-', '').ToLowerInvariant() }
finally { $binaryStream.Dispose(); $binaryHasher.Dispose() }
$buildInfo = [ordered]@{ name = 'geod-cli'; version = $cliVersion; platform = 'windows-x64'; binarySha256 = $binaryHash; sourceRevision = $SourceRevision; packagedAt = [DateTime]::UtcNow.ToString('o') }
[System.IO.File]::WriteAllText((Join-Path $packagePath 'build-info.json'), ($buildInfo | ConvertTo-Json) + "`n", $utf8)
Compress-Archive -LiteralPath $packagePath -DestinationPath $archivePath
$archiveStream = [System.IO.File]::OpenRead($archivePath)
$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $hash = [System.BitConverter]::ToString($hasher.ComputeHash($archiveStream)).Replace('-', '').ToLowerInvariant() }
finally { $archiveStream.Dispose(); $hasher.Dispose() }
[System.IO.File]::WriteAllText("$archivePath.sha256", "$hash  $([System.IO.Path]::GetFileName($archivePath))`n", $utf8)
@{ ok = $true; package = $packagePath; archive = $archivePath; sha256 = $hash } | ConvertTo-Json -Compress
