param(
    [Parameter(Mandatory = $true)][string]$PackageZip,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$InnoCompiler = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
& $Python (Join-Path $PSScriptRoot 'build_geod_cli_installer.py') `
    --package-zip $PackageZip --expected-sha256 $ExpectedSha256 `
    --output-directory $OutputDirectory --inno-compiler $InnoCompiler
if ($LASTEXITCODE -ne 0) { throw "GeoD CLI installer build failed (exit $LASTEXITCODE)." }
