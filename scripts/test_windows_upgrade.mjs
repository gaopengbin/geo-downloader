// Exercise an actual per-user NSIS upgrade on a disposable GitHub-hosted Windows VM.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' &&
  process.env.GEOD_RUNNER_ENVIRONMENT === 'github-hosted', 'Run only on a disposable GitHub-hosted Windows runner')
const [candidate, releaseVersion] = process.argv.slice(2)
assert(candidate && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(releaseVersion))
const work = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'geod-upgrade-'))
const repository = process.env.GITHUB_REPOSITORY
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true })
const versions = JSON.parse(gh('release', 'list', '-R', repository, '--exclude-pre-releases',
  '--exclude-drafts', '--limit', '100', '--json', 'tagName')).map(r => r.tagName)
function compareVersions(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}
const baseVersion = releaseVersion.split('-')[0]
const oldTag = versions.filter(t => /^v\d+\.\d+\.\d+$/.test(t) && compareVersions(t.slice(1), baseVersion) < 0)
  .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))[0]
assert(oldTag, 'No previous stable release is available for an upgrade')
const oldAssetName = `GeoDownloader_${oldTag.slice(1)}_windows_x64-setup.exe`
const { assets } = JSON.parse(gh('release', 'view', oldTag, '-R', repository, '--json', 'assets'))
const asset = assets.find(item => item.name === oldAssetName)
assert(asset && /^sha256:[0-9a-f]{64}$/i.test(asset.digest), 'Previous installer needs a published checksum')
gh('release', 'download', oldTag, '-R', repository, '--pattern', oldAssetName, '--dir', work)
const previousInstaller = path.join(work, oldAssetName)
const bytes = await readFile(previousInstaller)
assert.equal(bytes.length, asset.size)
assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), asset.digest.toLowerCase())

const installDir = path.join(work, 'installation')
const exe = path.join(installDir, 'geo-downloader.exe')
async function installedWebView() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
  for (const root of roots) {
    const base = path.join(root, 'Microsoft', 'EdgeWebView', 'Application')
    const entries = await readdir(base).catch(() => [])
    const versions = entries.filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name)).sort((a,b) => b.localeCompare(a, 'en', {numeric:true}))
    for (const version of versions) {
      const folder = path.join(base, version)
      if ((await stat(path.join(folder, 'msedgewebview2.exe')).catch(() => null))?.isFile()) return folder
    }
  }
}
let runtime = await installedWebView()
if (!runtime) {
  // Install Microsoft's Evergreen Runtime on images that do not carry it.
  const installer = path.join(work, 'MicrosoftEdgeWebView2Setup.exe')
  execFileSync('curl.exe', ['--fail','--location','--silent','--show-error','--retry','2','--output',installer,
    'https://go.microsoft.com/fwlink/p/?LinkId=2124703'], {windowsHide:true,timeout:120000})
  execFileSync('pwsh', ['-NoProfile','-Command',
    "$s=Get-AuthenticodeSignature -LiteralPath $env:GEOD_WEBVIEW_SETUP; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'Unexpected WebView2 bootstrapper signature' }"],
    {windowsHide:true,env:{...process.env,GEOD_WEBVIEW_SETUP:installer}})
  execFileSync(installer, ['/silent','/install'], {windowsHide:true,timeout:240000})
  runtime = await installedWebView()
}
assert(runtime, 'Edge WebView2 Runtime is required to launch the desktop app')
console.log('Using the runner account and WebView2 runtime', runtime)
const marker = 'custom_upgrade_' + randomUUID()
const data = path.join(process.env.LOCALAPPDATA, 'geo-downloader')
const historyPath = path.join(data, 'history.db')
const settingsPath = path.join(data, 'settings.json')
const imports = path.join(data, 'history.json')
await mkdir(data, {recursive:true})
const source = {id:marker, name:'Saved upgrade source', url:'http://127.0.0.1:9/{z}/{x}/{y}.png',
  max_zoom:18, subdomains:''}
await writeFile(settingsPath, JSON.stringify({default_concurrency:13, custom_sources:[source]}), {flag:'wx'})

function legacyRecord(version) {
  return {id:randomUUID(), name:'Upgrade sample '+version, source:'fixture', source_name:'Migration test',
    zoom:7, format:'geotiff', file_path:path.join(work, 'existing.tif'), file_size:1024, tile_count:2,
    failed_count:0, created_at:new Date().toISOString(), status:'completed'}
}

// The app itself imports the records. The probe only opens its SQLite database read-only.
function readHistory(records) {
  const db = new DatabaseSync(historyPath, {readOnly:true})
  try {
    for (const row of records) {
      const actual = db.prepare('SELECT name, tile_count, status FROM download_history WHERE id=?').get(row.id)
      assert(actual && actual.name === row.name && actual.tile_count === row.tile_count && actual.status === row.status)
    }
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  } finally { db.close() }
}

const inspectWindow = [
  "$app=Get-Process -Id ([int]$env:GEOD_PROBE_PID) -ErrorAction Stop",
  "$web=@(Get-CimInstance Win32_Process -Filter \u0022Name='msedgewebview2.exe'\u0022)",
  "$front=@($app.Id); $children=@()",
  "while($front.Count -gt 0){ $next=@($web | Where-Object { $front -contains $_.ParentProcessId -and $children -notcontains $_.ProcessId }); if(!$next.Count){break}; $front=@($next.ProcessId); $children+=$front }",
  "$renderers=@($web | Where-Object { $children -contains $_.ProcessId -and $_.CommandLine -match '--type=renderer' })",
  "[pscustomobject]@{title=$app.MainWindowTitle; handle=$app.MainWindowHandle.ToInt64(); executable=$app.Path; version=$app.MainModule.FileVersionInfo.ProductVersion; renderers=$renderers.Count} | ConvertTo-Json -Compress"
].join('\n')

async function smoke(version, records) {
  const child = spawn(exe, [], {windowsHide:true, stdio:'ignore', env:{
    ...process.env, WEBVIEW2_BROWSER_EXECUTABLE_FOLDER:runtime,
    WEBVIEW2_USER_DATA_FOLDER:path.join(work,'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--disable-gpu --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=127.0.0.1;localhost;tauri.localhost',
    HTTPS_PROXY:'http://127.0.0.1:9', HTTP_PROXY:'http://127.0.0.1:9', NO_PROXY:'localhost,127.0.0.1,tauri.localhost',
  }})
  let lastEvidence
  try {
    const deadline = Date.now()+60000
    while (Date.now()<deadline) {
      assert.equal(child.exitCode,null,'GeoD exited during startup')
      const win = JSON.parse(execFileSync('pwsh',['-NoProfile','-Command',inspectWindow],{
        windowsHide:true, encoding:'utf8', timeout:10000, env:{...process.env,GEOD_PROBE_PID:String(child.pid)}}))
      lastEvidence = win
      if (win.handle && (!win.title || win.title==='GeoDownloader') && win.renderers>0) {
        assert.equal(path.resolve(win.executable).toLowerCase(),exe.toLowerCase())
        assert.equal(win.version,version)
        try { readHistory(records) } catch (error) { lastEvidence={win, history:error.message}; await delay(400);continue }
        const loaded = JSON.parse(await readFile(settingsPath,'utf8'))
        assert.equal(loaded.default_concurrency,13)
        const stored = loaded.custom_sources.find(s=>s.id===marker)
        assert(stored && Object.entries(source).every(([field,value])=>stored[field]===value))
        console.log('Verified installed process and preserved data:', JSON.stringify({...win, historyRecords:records.length, sourcePreserved:true}))
        return
      }
      await delay(400)
    }
    throw Error('Installed program did not pass window, renderer and history checks: '+JSON.stringify(lastEvidence))
  } finally {
    if (child.pid && child.exitCode===null)
      execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})
  }
}

// No destination override on the second installation: NSIS must pick up its existing per-user location.
execFileSync(previousInstaller, ['/S',`/D=${installDir}`], {windowsHide:true, timeout:180000})
await stat(exe)
const oldRecord = legacyRecord(oldTag)
await writeFile(imports, JSON.stringify([oldRecord]), {flag:'wx'})
await smoke(oldTag.slice(1), [oldRecord])
execFileSync(path.resolve(candidate), ['/S'], {windowsHide:true, timeout:180000})
const newRecord = legacyRecord(releaseVersion)
await writeFile(imports, JSON.stringify([newRecord]), {flag:'wx'})
await smoke(releaseVersion, [oldRecord, newRecord])
console.log(`Verified installed Windows upgrade ${oldTag} -> v${releaseVersion}`)
