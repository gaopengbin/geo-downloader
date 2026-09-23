param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PackageRoot 'skill\geod-agent\SKILL.md'
if (-not (Test-Path -LiteralPath $source)) { throw 'GeoD Agent Skill is missing from the package.' }
$target = [System.IO.Path]::GetFullPath($Destination)
$skillFile = Join-Path $target 'SKILL.md'
function Normalize-GeoDSkill([string]$Content) { return ($Content -replace "`r`n", "`n").TrimEnd() }
$incoming = Get-Content -LiteralPath $source -Raw
if (Test-Path -LiteralPath $target) {
    if (-not (Test-Path -LiteralPath $skillFile)) { throw "A different geod-agent directory already exists: $target" }
    $current = Get-Content -LiteralPath $skillFile -Raw
    if ((Normalize-GeoDSkill $current) -ne (Normalize-GeoDSkill $incoming)) {
        $known = @('geod-agent-0.1.0.md', 'geod-agent-0.1.2.md')
        $isPrevious = $false
        foreach ($name in $known) {
            $previous = Get-Content -LiteralPath (Join-Path $PackageRoot "scripts\$name") -Raw
            if ((Normalize-GeoDSkill $current) -eq (Normalize-GeoDSkill $previous)) { $isPrevious = $true; break }
        }
        if (-not $isPrevious) { throw "A modified geod-agent Skill already exists: $skillFile" }
        $backup = $skillFile + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item -LiteralPath $skillFile -Destination $backup
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($skillFile, $incoming, $utf8)
    }
} else {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $skillFile
}
if ((Normalize-GeoDSkill (Get-Content -LiteralPath $skillFile -Raw)) -ne (Normalize-GeoDSkill $incoming)) { throw 'GeoD Agent Skill verification failed.' }
@{ ok = $true; skill = $skillFile } | ConvertTo-Json -Compress
