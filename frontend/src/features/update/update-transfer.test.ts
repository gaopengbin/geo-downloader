import assert from 'node:assert/strict'
import test from 'node:test'
import { installerIntegrity, updateSpeed } from './update-transfer.ts'
import { useUpdateStore } from './update-store.ts'

test('mirror SHA256 and GitHub digests describe the same installer', () => {
  assert.deepEqual(installerIntegrity({ sha256: 'A'.repeat(64), size: 1024 }),
    installerIntegrity({ digest: `sha256:${'a'.repeat(64)}`, size: 1024 }))
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

test('a new update or closing the dialog resets the previous source and progress', () => {
  const store = useUpdateStore.getState()
  store.setDownloading(true)
  store.setProgress(42)
  store.setTransfer({ source: 'github', phase: 'downloading', attempt: 2, progress: 42,
    downloaded: 420, total: 1000, bytesPerSecond: 1024, reason: null })
  store.showDialog({ currentVersion: '3.6.13', latestVersion: '3.6.24', noteGroups: [],
    downloadUrl: 'https://laogao.xyz/packages/latest/GeoDownloader_3.6.24_windows_x64-setup.exe',
    releaseUrl: 'https://github.com/gaopengbin/geo-downloader/releases/tag/v3.6.24',
    expectedSha256: 'a'.repeat(64), expectedSize: 1000 })
  assert.equal(useUpdateStore.getState().progress, 0)
  assert.equal(useUpdateStore.getState().transfer, null)
  assert.equal(useUpdateStore.getState().downloading, false)
  store.setTransfer({ source: 'mirror', phase: 'switching', attempt: 2, progress: 0,
    downloaded: 0, total: 1000, bytesPerSecond: 0, reason: 'slow' })
  store.closeDialog()
  assert.equal(useUpdateStore.getState().transfer, null)
})
