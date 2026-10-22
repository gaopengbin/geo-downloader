import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { initializeDatabase } from '../database.mjs'
import { createTelemetryServer, validateEnvelope } from '../server.mjs'

const require = createRequire(import.meta.url)

test('download outcomes accept only random attempt IDs and categorical diagnostics', () => {
  const properties = { attempt_id: crypto.randomUUID(), state: 'failed', duration: '10-60s', reason: 'network' }
  assert.deepEqual(validateEnvelope({ schema_version: 1, events: [event({ event: 'download_task_state', properties })] })[0].properties, properties)
  for (const unsafe of [{ ...properties, path: 'private.tif' }, { ...properties, reason: 'raw password error' }, { ...properties, attempt_id: 'job-123' }]) {
    assert.throws(() => validateEnvelope({ schema_version: 1, events: [event({ event: 'download_task_state', properties: unsafe })] }))
  }
})

const diagnostics = { diagnostic_version: 1, provider: 'tianditu', phase: 'overlay_download', token_source: 'user',
  configured_tokens: 3, used_tokens: 3, token_switches: 2, recovered_switches: 1, settings_updates: 0,
  last_rejection_status: 429, tokens_exhausted: true, error_code: 'all_tokens_unavailable', http_status: 429 }
test('accepts bounded failover categories and rejects credentials, raw errors and malformed diagnostics', () => {
  const properties = { attempt_id: crypto.randomUUID(), state: 'failed', duration: '30m+', reason: 'auth', ...diagnostics }
  assert.deepEqual(validateEnvelope({ schema_version: 1, events: [event({ event: 'download_task_state', properties })] })[0].properties, properties)
  for (const extra of [{ token: 'secret' }, { url: 'https://private' }, { error: 'raw secret error' }, { provider: 'private-source' }, { phase: 'C:/private' }, { used_tokens: -1 }, { token_switches: 65536 }, { settings_updates: 1.5 }, { last_rejection_status: 200 }, { http_status: 600 }, { error_code: 'tk=secret' }, { tokens_exhausted: 'true' }, { diagnostic_version: 2 }]) {
    assert.throws(() => validateEnvelope({ schema_version: 1, events: [event({ event: 'download_task_state', properties: { ...properties, ...extra } })] }))
  }
  const partial = { ...properties }; delete partial.used_tokens
  assert.throws(() => validateEnvelope({ schema_version: 1, events: [event({ event: 'download_task_state', properties: partial })] }))
})

function event(overrides = {}) {
  return {
    event_id: crypto.randomUUID(),
    event: 'app_started',
    occurred_at: new Date().toISOString(),
    install_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    app_version: '3.6.6',
    platform: 'windows',
    properties: {},
    ...overrides,
  }
}

test('accepts GeoD events and rejects unrelated properties', () => {
  const [normalized] = validateEnvelope({ schema_version: 1, events: [event()] })
  assert.equal(normalized.eventName, 'app_started')
  assert.throws(
    () => validateEnvelope({ schema_version: 1, events: [event({ properties: { url: 'https://example.com' } })] }),
    /properties must be empty/,
  )
})

test('accepts privacy-safe assistant events and rejects message content', () => {
  const [normalized] = validateEnvelope({
    schema_version: 1,
    events: [event({
      event: 'assistant_request',
      properties: {
        outcome: 'success',
        diagnostics_attached: true,
        source_count: '2-10',
        duration: '3-10s',
      },
    })],
  })
  assert.deepEqual(normalized.properties, {
    outcome: 'success',
    diagnostics_attached: true,
    source_count: '2-10',
    duration: '3-10s',
  })
  assert.throws(
    () => validateEnvelope({
      schema_version: 1,
      events: [event({
        event: 'assistant_request',
        properties: {
          outcome: 'success',
          diagnostics_attached: false,
          source_count: '0',
          duration: 'under_3s',
          prompt: 'private user content',
        },
      })],
    }),
    /assistant_request properties are invalid/,
  )
})

test('serves only GeoD health, event ingestion, and protected statistics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geod-telemetry-'))
  const tokenPath = path.join(directory, 'admin-token.txt')
  await writeFile(tokenPath, 'admin-test-token')
  const databaseConfig = { databasePath: path.join(directory, 'geod.sqlite'), databaseId: 'geod-test-lifecycle', environment: 'test' }
  initializeDatabase({ ...databaseConfig, createNew: true, offlineConfirmed: true })
  const server = await createTelemetryServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      ...databaseConfig,
      adminTokenFile: tokenPath,
      maxBodyBytes: 131072,
      rateLimitPerMinute: 1000,
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const health = await fetch(`${baseUrl}/geod-telemetry/health`).then((response) => response.json())
    assert.equal(health.status, 'ok')
    assert.equal(health.storage, 'sqlite-wal')
    const ingestion = await fetch(`${baseUrl}/geod-telemetry/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 1, events: [event(), event({ event: 'download_task_state', properties: {
        attempt_id: crypto.randomUUID(), state: 'completed', duration: '10-60s', reason: 'none',
        ...diagnostics, tokens_exhausted: false, error_code: 'none', http_status: 0,
      } })] }),
    })
    assert.equal(ingestion.status, 202)
    const stats = await fetch(`${baseUrl}/geod-telemetry/admin/stats`, {
      headers: { authorization: 'Bearer admin-test-token' },
    }).then((response) => response.json())
    assert.equal(stats.totals.event_count, 2)
    assert.equal(stats.reporting_time_zone, 'Asia/Shanghai')
    assert.equal((await fetch(`${baseUrl}/geod-telemetry/admin/stats`)).status, 401)
    const repeated = await fetch(`${baseUrl}/geod-telemetry/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema_version: 1, events: [event({ event_id: 'not-a-uuid' })] }) })
    assert.equal(repeated.status, 400)
    assert.equal((await fetch(`${baseUrl}/geod-telemetry/v1/quota`)).status, 404)
    assert.equal((await fetch(`${baseUrl}/geod-telemetry/public/product-stats`)).status, 404)
  } finally {
    server.close()
    await once(server, 'close')
    await rm(directory, { recursive: true, force: true })
  }
})
