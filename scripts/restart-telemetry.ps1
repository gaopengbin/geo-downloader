param(
  [Parameter(Mandatory = $true)]
  [string]$AdminTokenBase64,

  [string]$ServiceRoot = 'C:\nginx-1.30.2\services\geod-telemetry'
)

$ErrorActionPreference = 'Stop'

$nginxRoot = 'C:\nginx-1.30.2'
$serviceRoot = $ServiceRoot
$script = Join-Path $serviceRoot 'server.mjs'
$tokenFile = Join-Path $nginxRoot 'geod-telemetry-admin-token.txt'
$databasePath = Join-Path $nginxRoot 'data\geod-telemetry.sqlite'
$nginxConf = Join-Path $nginxRoot 'conf\nginx.conf'
$nginxExe = Join-Path $nginxRoot 'nginx.exe'
$watchdogScript = Join-Path $serviceRoot 'geod-telemetry-watchdog.ps1'

$adminToken = [System.Text.Encoding]::UTF8.GetString(
  [System.Convert]::FromBase64String($AdminTokenBase64)
)
if ([string]::IsNullOrWhiteSpace($adminToken)) {
  throw 'Telemetry admin token is empty'
}

New-Item -ItemType Directory -Force -Path $serviceRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $databasePath) | Out-Null
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
  Set-Content -LiteralPath $tokenFile -Value $adminToken -NoNewline -Encoding UTF8
}

$legacyModules = Join-Path $nginxRoot 'services\geod-telemetry\node_modules'
$releaseModules = Join-Path $serviceRoot 'node_modules'
if (-not (Test-Path -LiteralPath (Join-Path $releaseModules 'sql.js') -PathType Container)) {
  if (-not (Test-Path -LiteralPath (Join-Path $legacyModules 'sql.js') -PathType Container)) {
    throw "The telemetry sql.js dependency is missing from $legacyModules."
  }
  New-Item -ItemType Directory -Force -Path $releaseModules | Out-Null
  Copy-Item `
    -LiteralPath (Join-Path $legacyModules 'sql.js') `
    -Destination (Join-Path $releaseModules 'sql.js') `
    -Recurse `
    -Force
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($nodeCommand) {
  $node = $nodeCommand.Source
} else {
  $runnerRoot = Split-Path -Parent (
    Split-Path -Parent (
      Split-Path -Parent $env:GITHUB_WORKSPACE
    )
  )
  $node = Get-ChildItem `
      -LiteralPath (Join-Path $runnerRoot 'externals') `
      -Directory `
      -Filter 'node*' |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'bin\node.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
}
if (-not $node) {
  throw 'No compatible Node.js executable was found.'
}
$nodeVersion = [version]((& $node --version).TrimStart('v'))
if ($nodeVersion -lt [version]'20.12.0') {
  throw "Telemetry requires Node.js 20.12 or newer; found $nodeVersion."
}
Write-Host "Using Node.js $nodeVersion from $node"
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*geod-telemetry*server.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$taskName = 'GeoDTelemetry'
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $serviceRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force | Out-Null

$watchdogContent = @"
`$ErrorActionPreference = 'Stop'
`$process = Get-CimInstance Win32_Process |
  Where-Object { `$_.CommandLine -like '*$script*' } |
  Select-Object -First 1
if (-not `$process) {
  Start-ScheduledTask -TaskName '$taskName'
}
"@
Set-Content -LiteralPath $watchdogScript -Value $watchdogContent -Encoding UTF8
$watchdogAction = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$watchdogScript`""
$watchdogTriggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650))
)
Register-ScheduledTask `
  -TaskName 'GeoDTelemetryWatchdog' `
  -Action $watchdogAction `
  -Trigger $watchdogTriggers `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$health = Invoke-RestMethod -Uri 'http://127.0.0.1:9091/health' -TimeoutSec 10
if ($health.status -ne 'ok') {
  throw 'Telemetry health check failed'
}

$conf = Get-Content -LiteralPath $nginxConf -Raw
$conf = $conf.TrimStart([char]0xFEFF)
$location = @'
        location /geod-telemetry/ {
            access_log off;
            client_max_body_size 128k;
            proxy_pass http://127.0.0.1:9091;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
'@
$locationReplacement = $location.Replace('$', '$$')
$needsNginxUpdate = $false
if ($conf -match '(?s)\s*location\s+/geod-telemetry/\s*\{.*?\}\s*') {
  Write-Host 'The GeoD telemetry nginx route is already configured.'
} elseif ($conf -match '(?s)(server\s*\{.*?server_name\s+[^;]*laogao\.xyz[^;]*;.*?)(\s*location\s+/packages/)') {
  $conf = [regex]::Replace(
    $conf,
    '(?s)(server\s*\{.*?server_name\s+[^;]*laogao\.xyz[^;]*;.*?)(\s*location\s+/packages/)',
    "`$1`r`n$locationReplacement`r`n`$2",
    1
  )
  $needsNginxUpdate = $true
} else {
  throw 'Could not locate the laogao.xyz HTTPS server block in nginx.conf'
}

if ($needsNginxUpdate) {
  $backup = "$nginxConf.bak-telemetry-$(Get-Date -Format 'yyyyMMddHHmmss')"
  Copy-Item -LiteralPath $nginxConf -Destination $backup -Force
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($nginxConf, $conf, $utf8NoBom)

  & $nginxExe -t -p $nginxRoot -c conf/nginx.conf
  if ($LASTEXITCODE -ne 0) {
    Copy-Item -LiteralPath $backup -Destination $nginxConf -Force
    throw 'nginx config test failed; the previous configuration was restored'
  }

  Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -eq $nginxExe } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

  $nginxTaskName = 'GeoDNginx'
  $nginxAction = New-ScheduledTaskAction `
    -Execute $nginxExe `
    -Argument "-p `"$nginxRoot`" -c conf/nginx.conf" `
    -WorkingDirectory $nginxRoot
  $nginxTrigger = New-ScheduledTaskTrigger -AtStartup
  Register-ScheduledTask `
    -TaskName $nginxTaskName `
    -Action $nginxAction `
    -Trigger $nginxTrigger `
    -Force | Out-Null
  Start-ScheduledTask -TaskName $nginxTaskName
  Start-Sleep -Seconds 2
}

$publicHealth = Invoke-RestMethod `
  -Uri 'https://laogao.xyz/geod-telemetry/health' `
  -TimeoutSec 15
if ($publicHealth.status -ne 'ok') {
  throw 'Public telemetry health check failed'
}

Write-Host 'GeoD telemetry deployment is healthy.'
