param(
  [Parameter(Mandatory = $true)]
  [string]$Token
)

$ErrorActionPreference = 'Stop'

$script = 'C:\nginx-1.30.2\tools\qr-upload-server.js'
$tokenFile = 'C:\nginx-1.30.2\qr-admin-token.txt'
$nginxRoot = 'C:\nginx-1.30.2'
$nginxConf = Join-Path $nginxRoot 'conf\nginx.conf'
$nginxExe = Join-Path $nginxRoot 'nginx.exe'

if ([string]::IsNullOrWhiteSpace($Token)) {
  throw 'QR admin token is empty'
}

Set-Content -LiteralPath $tokenFile -Value $Token -NoNewline -Encoding UTF8

$node = (Get-Command node.exe -ErrorAction Stop).Source

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*qr-upload-server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$taskName = 'GeoDQrAdmin'
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`""
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force | Out-Null

Start-Process -FilePath $node -ArgumentList @($script) -WindowStyle Hidden
Start-Sleep -Seconds 3

$response = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/qr-admin/' -UseBasicParsing -TimeoutSec 10
if ($response.StatusCode -ne 200) {
  throw "QR admin returned status $($response.StatusCode)"
}

if (Test-Path $nginxConf) {
  $conf = Get-Content -LiteralPath $nginxConf -Raw
  $location = @'
        location /qr-admin/ {
            proxy_pass http://127.0.0.1:9090/qr-admin/;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
'@
  $locationReplacement = $location.Replace('$', '$$')
  $updated = $false
  if ($conf -match '(?s)\s*location\s+/qr-admin/\s*\{.*?\}\s*') {
    $conf = [regex]::Replace($conf, '(?s)\s*location\s+/qr-admin/\s*\{.*?\}\s*', "`r`n$locationReplacement`r`n", 1)
    $updated = $true
  } elseif ($conf -match '(?s)(server\s*\{.*?server_name\s+[^;]*laogao\.xyz[^;]*;.*?)(\s*location\s+/packages/)') {
    $conf = [regex]::Replace($conf, '(?s)(server\s*\{.*?server_name\s+[^;]*laogao\.xyz[^;]*;.*?)(\s*location\s+/packages/)', "`$1`r`n$locationReplacement`r`n`$2", 1)
    $updated = $true
  } elseif ($conf -match '(?s)(server\s*\{.*?listen\s+443.*?)(\s*location\s+/packages/)') {
    $conf = [regex]::Replace($conf, '(?s)(server\s*\{.*?listen\s+443.*?)(\s*location\s+/packages/)', "`$1`r`n$locationReplacement`r`n`$2", 1)
    $updated = $true
  }

  if ($updated) {
    $backup = "$nginxConf.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
    Copy-Item -LiteralPath $nginxConf -Destination $backup -Force
    Set-Content -LiteralPath $nginxConf -Value $conf -Encoding UTF8
  }

  if (Test-Path $nginxExe) {
    & $nginxExe -t -p $nginxRoot -c conf/nginx.conf
    & $nginxExe -s reload -p $nginxRoot -c conf/nginx.conf
  }
}

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*qr-upload-server.js*' } |
  Select-Object ProcessId,CommandLine |
  Format-List
