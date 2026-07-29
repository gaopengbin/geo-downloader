import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { createTelemetryServer, validateEnvelope } from '../server.mjs'

const cleanup = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => item()))
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

test('accepts the documented event envelope', () => {
  const [normalized] = validateEnvelope({ schema_version: 1, events: [event()] })
  assert.equal(normalized.eventName, 'app_started')
  assert.equal(normalized.platform, 'windows')
})

test('rejects unknown event properties', () => {
  assert.throws(
    () =>
      validateEnvelope({
        schema_version: 1,
        events: [event({ properties: { url: 'https://example.com' } })],
      }),
    /properties must be empty/,
  )
})

test('ingests, deduplicates, and reports aggregate statistics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geod-telemetry-'))
  const tokenPath = path.join(directory, 'admin-token.txt')
  await writeFile(tokenPath, 'test-token')
  const server = await createTelemetryServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      databasePath: path.join(directory, 'events.sqlite'),
      adminTokenFile: tokenPath,
      maxBodyBytes: 131072,
      rateLimitPerMinute: 120,
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () => new Promise((resolve) => server.close(resolve)),
    () => rm(directory, { recursive: true, force: true }),
  )

  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const payloadEvent = event()
  const payload = JSON.stringify({ schema_version: 1, events: [payloadEvent] })

  const health = await fetch(`${baseUrl}/geod-telemetry/health`)
  assert.equal(health.status, 200)

  const first = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
  assert.equal(first.status, 202)
  assert.deepEqual(await first.json(), { accepted: 1, inserted: 1 })

  const duplicate = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
  assert.equal(duplicate.status, 202)
  assert.deepEqual(await duplicate.json(), { accepted: 1, inserted: 0 })

  const unauthorized = await fetch(`${baseUrl}/admin/stats`)
  assert.equal(unauthorized.status, 401)

  const statsResponse = await fetch(`${baseUrl}/admin/stats`, {
    headers: { authorization: 'Bearer test-token' },
  })
  assert.equal(statsResponse.status, 200)
  const stats = await statsResponse.json()
  assert.equal(stats.totals.installs, 1)
  assert.equal(stats.totals.event_count, 1)
  assert.deepEqual(stats.platforms, [{ platform: 'windows', installs: 1 }])
})
