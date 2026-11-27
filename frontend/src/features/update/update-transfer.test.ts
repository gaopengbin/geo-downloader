import assert from 'node:assert/strict'
import test from 'node:test'
import { installerIntegrity, releaseAction, updateSpeed, UpdateTelemetryTracker } from './update-transfer.ts'
import { useUpdateStore } from './update-store.ts'

test('mirror SHA256 and GitHub digests describe the same installer', () => {
  assert.deepEqual(installerIntegrity({ sha256: 'A'.repeat(64), size: 1024 }),
    installerIntegrity({ digest: `sha256:${'a'.repeat(64)}`, size: 1024 }))
})

test('update telemetry emits transitions once and never treats handoff as installation success', () => {
  const tracker = new UpdateTelemetryTracker()
  assert.deepEqual(tracker.started(), { state: 'started', source: 'unknown', reason: 'none', attempt: 0 })
  const transfer = { source: 'mirror', phase: 'downloading', attempt: 1, progress: 5, downloaded: 5, total: 100, bytesPerSecond: 5, reason: null } as const
  for (let progress = 1; progress < 80; progress++) assert.equal(tracker.observe({ ...transfer, progress }), null)
  const switched = { ...transfer, phase: 'switching', reason: 'slow' } as const
  assert.equal(tracker.observe(switched)?.reason, 'slow')
  assert.equal(tracker.observe(switched), null)
  assert.equal(tracker.observe({ ...transfer, phase: 'verifying', source: 'github', attempt: 2 })?.state, 'verifying')
  assert.equal(tracker.observe({ ...transfer, phase: 'installing', source: 'github', attempt: 2 })?.state, 'installing')
  assert.equal(tracker.failed().state, 'failed')
  assert.equal(new UpdateTelemetryTracker().observe(switched)?.state, 'switching')
  assert.doesNotMatch(JSON.stringify(tracker.failed()), /downloaded|bytesPerSecond|url|success/)
})

test('missing or malformed integrity never starts an unverified update', () => {
  for (const asset of [{}, { sha256: 'a'.repeat(64), size: 0 }, { digest: 'sha256:abc', size: 1024 },
    { sha256: 'a'.repeat(64), size: Number.NaN }, { sha256: 'a'.repeat(64), size: 1.5 },
    { sha256: 'a'.repeat(64), size: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => installerIntegrity(asset), /UPDATE_INTEGRITY_MISSING/)
  }
})

test('speed display never produces NaN or negative values', () => {
  assert.equal(updateSpeed(1024 * 100), '100.0 KB/s')
  assert.equal(updateSpeed(1024 * 1024 * 1.5), '1.5 MB/s')
  assert.equal(updateSpeed(Number.NaN), '0.0 KB/s')
  assert.equal(updateSpeed(-100), '0.0 KB/s')
})

test('release assets match native platform and architecture, including unsupported targets', () => {
  const assets = ['windows_arm64-setup.exe', 'windows_x64-setup.exe', 'macos_x64.dmg', 'macos_arm64.dmg', 'linux_amd64.AppImage', 'linux_amd64.deb']
    .map(suffix => ({ name: 'GeoDownloader_3.6.29_' + suffix, browser_download_url: 'https://example.test/' + suffix,
      size: 100, digest: 'sha256:' + 'a'.repeat(64) }))
  for (const [os, arch, suffix] of [['macos','x86_64','macos_x64.dmg'],['macos','aarch64','macos_arm64.dmg'],['linux','x86_64','linux_amd64.AppImage']]) {
    const action = releaseAction(assets, 'v3.6.29', [os,arch])
    assert.equal(action?.kind,'download')
    assert.ok(action?.url.endsWith(suffix))
    assert.ok(action?.url.startsWith('https://github.com/gaopengbin/geo-downloader/releases/download/v3.6.29/'))
  }
  const windows = releaseAction(assets, 'v3.6.29', ['windows','x86_64'])
  assert.equal(windows?.kind, 'install')
  assert.ok(windows?.url.endsWith('windows_x64-setup.exe'))
  assert.equal(releaseAction(assets, 'v3.6.29', ['linux','aarch64']), null)
  assert.throws(() => releaseAction([], 'v3.6.29', ['windows','x86_64']))
})

test('a new update or closing the dialog resets the previous source and progress', () => {
  const store = useUpdateStore.getState()
  store.setDownloading(true)
  store.setProgress(42)
  store.setTransfer({ source: 'github', phase: 'downloading', attempt: 2, progress: 42,
    downloaded: 420, total: 1000, bytesPerSecond: 1024, reason: null })
  store.showDialog({ currentVersion: '3.6.13', latestVersion: '3.6.24', noteGroups: [],
    action: { kind: 'install', url: 'https://laogao.xyz/packages/latest/GeoDownloader_3.6.24_windows_x64-setup.exe',
      expectedSha256: 'a'.repeat(64), expectedSize: 1000 },
    releaseUrl: 'https://github.com/gaopengbin/geo-downloader/releases/tag/v3.6.24' })
  assert.equal(useUpdateStore.getState().progress, 0)
  assert.equal(useUpdateStore.getState().transfer, null)
  assert.equal(useUpdateStore.getState().downloading, false)
  store.setTransfer({ source: 'mirror', phase: 'switching', attempt: 2, progress: 0,
    downloaded: 0, total: 1000, bytesPerSecond: 0, reason: 'slow' })
  store.closeDialog()
  assert.equal(useUpdateStore.getState().transfer, null)
})
