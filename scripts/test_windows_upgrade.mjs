// Exercise an actual per-user NSIS upgrade on a disposable GitHub-hosted Windows VM.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import net from 'node:net'
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

async function smoke(version, save) {
  const listener = net.createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  const child = spawn(exe, [], { windowsHide:true, stdio:'ignore', env:{
    ...process.env, WEBVIEW2_BROWSER_EXECUTABLE_FOLDER:runtime,
    WEBVIEW2_USER_DATA_FOLDER:path.join(work,'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 --disable-gpu --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=127.0.0.1;localhost;tauri.localhost`,
    HTTPS_PROXY:'http://127.0.0.1:9', HTTP_PROXY:'http://127.0.0.1:9', NO_PROXY:'localhost,127.0.0.1,tauri.localhost',
  } })
  let socket
  let lastPages = []
  async function evaluate(expression) {
    const id = ++evaluate.sequence
    const answer = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(Error('WebView command timed out')) }, 15000)
      function receive({data}) {
        const reply = JSON.parse(data)
        if (reply.id !== id) return
        clearTimeout(timeout)
        socket.removeEventListener('message', receive)
        if (reply.error || reply.result?.exceptionDetails) reject(Error(JSON.stringify(reply)))
        else resolve(reply.result.result.value)
      }
      socket.addEventListener('message', receive)
    })
    socket.send(JSON.stringify({ id, method:'Runtime.evaluate', params:{ expression, returnByValue:true, awaitPromise:true } }))
    return answer
  }
  evaluate.sequence = 0
  try {
    const deadline = Date.now() + 90000
    while (Date.now() < deadline && !socket) {
      assert.equal(child.exitCode, null, 'GeoD exited before opening its window')
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`, {signal:AbortSignal.timeout(2000)})
        .then(r => r.json()).catch(() => [])
      const target = pages.find(p => p.type === 'page' && /^https?:\/\/tauri\.localhost(?:\/|$)/.test(p.url))
      if (pages.length) lastPages = pages.map(({type, url}) => ({type, url:url?.split('?')[0]}))
      if (target) {
        socket = new WebSocket(target.webSocketDebuggerUrl)
        await once(socket, 'open', {signal:AbortSignal.timeout(10000)})
      } else await delay(300)
    }
    if (!socket) {
      console.error('GeoD PID, debugging port and CDP targets', child.pid, port, lastPages)
      const info = execFileSync('pwsh', ['-NoProfile','-Command',
        "Get-Process geo-downloader,msedgewebview2,explorer -ErrorAction SilentlyContinue | Select-Object Name,Id,SessionId,MainWindowTitle | Format-Table | Out-String; exit 0"],
        {windowsHide:true,encoding:'utf8'})
      throw Error('The installed app did not create its Tauri WebView. ' + info)
    }
    let ready = false
    while (Date.now() < deadline && !ready) {
      ready = await evaluate("!!window.__TAURI_INTERNALS__?.invoke && !!document.querySelector('[data-tour=mode-tabs]')")
      if (!ready) await delay(250)
    }
    assert(ready, 'The installed map workspace did not render')
    assert.equal(await evaluate("window.__TAURI_INTERNALS__.invoke('plugin:app|version')"), version)
    const stored = await evaluate(`(async () => {
      const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
      const settings = await invoke('get_settings')
      if (${save}) {
        settings.custom_sources.push({ id:${JSON.stringify(marker)}, name:'Upgrade probe', url:'http://127.0.0.1:9/{z}/{x}/{y}.png', max_zoom:18, subdomains:'' })
        await invoke('save_settings', {settings})
      }
      return (await invoke('get_settings')).custom_sources.some(s => s.id === ${JSON.stringify(marker)})
    })()`)
    assert.equal(stored, true, 'The installed app must read the setting saved by its predecessor')
    console.log(`GeoD ${version} launched and ${save ? 'saved' : 'reloaded'} the test source via native IPC`)
  } finally {
    socket?.close()
    if (child.pid && child.exitCode === null) {
      execFileSync('taskkill.exe', ['/PID',String(child.pid),'/T','/F'], {windowsHide:true, stdio:'ignore'})
    }
  }
}

// No destination override on the second installation: NSIS must pick up its existing per-user location.
execFileSync(previousInstaller, ['/S',`/D=${installDir}`], {windowsHide:true, timeout:180000})
await stat(exe)
await smoke(oldTag.slice(1), true)
execFileSync(path.resolve(candidate), ['/S'], {windowsHide:true, timeout:180000})
await smoke(releaseVersion, false)
console.log(`Verified installed Windows upgrade ${oldTag} -> v${releaseVersion}`)
