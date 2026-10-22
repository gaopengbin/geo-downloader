import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeDownloadDiagnostics, taskDownloadDiagnostics } from './download-diagnostics.ts'
import { DownloadLifecycleTracker } from './download-lifecycle.ts'

const raw = { diagnostic_version: 1, provider: 'tianditu', phase: 'overlay_download', token_source: 'user',
  configured_tokens: 3, used_tokens: 3, token_switches: 2, recovered_switches: 1,
  settings_updates: 0, last_rejection_status: 429, tokens_exhausted: true }
test('final exhaustion and last HTTP status survive without copying secrets or raw errors', () => {
  const tracker = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 0)
  tracker.observe([{ id: 'private-task', status: 'downloading', download_diagnostics: raw }])
  const [event] = tracker.observe([{ id: 'private-task', status: 'failed', download_diagnostics: { ...raw, token: 'secret', url: 'https://private/' }, error: 'TILE_TOKENS_EXHAUSTED: tk=secret C:/private' }])
  assert.equal(event.error_code, 'all_tokens_unavailable'); assert.equal(event.http_status, 429)
  assert.equal(event.configured_tokens, 3); assert.equal(event.used_tokens, 3)
  assert.equal(event.token_switches, 2); assert.equal(event.recovered_switches, 1)
  assert.doesNotMatch(JSON.stringify(event), /secret|private|https|TILE_TOKENS/)
})
test('success after rotation is separate from later export/storage failure', () => {
  const success = taskDownloadDiagnostics({ ...raw, tokens_exhausted: false }, 'completed')!
  assert.equal(success.error_code, 'none'); assert.equal(success.http_status, 0)
  const failure = taskDownloadDiagnostics({ ...raw, phase: 'export', provider: 'other', tokens_exhausted: false }, 'failed', 'TILE_STORAGE_FAILED: C:/secret', 'disk')!
  assert.equal(failure.error_code, 'storage_failed'); assert.equal(failure.provider, 'other'); assert.equal(failure.http_status, 0)
})
test('diagnostic boundary rejects unbounded values and arbitrary categorical strings', () => {
  const safe = taskDownloadDiagnostics(raw, 'failed', 'HTTP 403 Forbidden', 'auth')!
  assert.equal(safe.http_status, 403)
  for (const extra of [{ used_tokens: -1 }, { configured_tokens: 65536 }, { token_switches: NaN }, { settings_updates: 1.5 }, { phase: 'https://private' }, { error_code: 'tk=secret' }, { last_rejection_status: 200 }, { provider: 'private-source' }, { http_status: 600 }]) {
    assert.equal(sanitizeDownloadDiagnostics({ ...safe, ...extra }), undefined)
  }
  assert.equal(taskDownloadDiagnostics(undefined, 'failed', 'secret'), undefined)
  assert.equal(taskDownloadDiagnostics({ ...raw, diagnostic_version: 2 }, 'failed'), undefined)
})
test('resume starts a fresh attempt while observer restart does not replay old failures', () => {
  const tracker = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 0)
  const [first] = tracker.observe([{ id: 'task', status: 'downloading', download_diagnostics: raw }])
  tracker.observe([{ id: 'task', status: 'failed', download_diagnostics: raw }])
  const [resumed] = tracker.observe([{ id: 'task', status: 'downloading', download_diagnostics: { ...raw, used_tokens: 0, token_switches: 0, recovered_switches: 0, tokens_exhausted: false } }])
  assert.notEqual(first.attempt_id, resumed.attempt_id); assert.equal(resumed.used_tokens, 0)
  const again = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => 0, tracker.snapshot())
  assert.deepEqual(again.observe([{ id: 'task', status: 'downloading', download_diagnostics: raw }]), [])
})
