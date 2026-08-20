import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import initSqlJs from 'sql.js'
import { createTelemetryServer, replaceDatabaseFile, validateEnvelope } from '../server.mjs'

const require = createRequire(import.meta.url)

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

test('falls back to a recoverable copy when Windows rejects database replacement', async () => {
  const calls = []
  const error = new Error('replacement denied')
  error.code = 'EPERM'
  const replacement = Buffer.from('new database')
  await replaceDatabaseFile('events.sqlite.tmp', 'events.sqlite', {
    rename: async (...args) => { calls.push(['rename', ...args]); throw error },
    copyFile: async (...args) => { calls.push(['copyFile', ...args]) },
    readFile: async (source) => { calls.push(['readFile', source]); return replacement },
    writeFile: async (...args) => { calls.push(['writeFile', ...args]) },
    rm: async (...args) => { calls.push(['rm', ...args]) },
  })
  assert.equal(calls[0][0], 'rename')
  assert.ok(calls.some(([operation]) => operation === 'writeFile'))
})

test('accepts GeoD events and rejects unrelated properties', () => {
  const [normalized] = validateEnvelope({ schema_version: 1, events: [event()] })
  assert.equal(normalized.eventName, 'app_started')
  assert.throws(
    () => validateEnvelope({ schema_version: 1, events: [event({ properties: { url: 'https://example.com' } })] }),
    /properties must be empty/,
  )
})

test('serves only GeoD health, event ingestion, and protected statistics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geod-telemetry-'))
  const tokenPath = path.join(directory, 'admin-token.txt')
  await writeFile(tokenPath, 'admin-test-token')
  const server = await createTelemetryServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      databasePath: path.join(directory, 'geod.sqlite'),
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
    assert.deepEqual(health, { status: 'ok', schema_version: 1 })
    const ingestion = await fetch(`${baseUrl}/geod-telemetry/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: 1, events: [event()] }),
    })
    assert.equal(ingestion.status, 202)
    const stats = await fetch(`${baseUrl}/geod-telemetry/admin/stats`, {
      headers: { authorization: 'Bearer admin-test-token' },
    }).then((response) => response.json())
    assert.equal(stats.totals.event_count, 1)
    assert.equal((await fetch(`${baseUrl}/geod-telemetry/v1/quota`)).status, 404)
    assert.equal((await fetch(`${baseUrl}/geod-telemetry/public/product-stats`)).status, 404)
  } finally {
    server.close()
    await once(server, 'close')
    await rm(directory, { recursive: true, force: true })
  }
})

test('removes migrated platform tables only after the migration marker exists', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geod-split-cleanup-'))
  const databasePath = path.join(directory, 'geod.sqlite')
  const markerPath = path.join(directory, 'platform-api-migrated.txt')
  const tokenPath = path.join(directory, 'admin-token.txt')
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') })
  const legacy = new SQL.Database()
  legacy.run('CREATE TABLE accounts (id TEXT PRIMARY KEY); CREATE TABLE product_events (event_id TEXT PRIMARY KEY);')
  await writeFile(databasePath, Buffer.from(legacy.export()))
  legacy.close()
  await writeFile(markerPath, 'migration complete')
  await writeFile(tokenPath, 'admin-test-token')

  const server = await createTelemetryServer({
    config: {
      host: '127.0.0.1', port: 0, databasePath, adminTokenFile: tokenPath,
      platformMigrationMarker: markerPath, maxBodyBytes: 131072, rateLimitPerMinute: 1000,
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  server.close()
  await once(server, 'close')

  const cleaned = new SQL.Database(await readFile(databasePath))
  const tables = []
  const statement = cleaned.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  while (statement.step()) tables.push(statement.getAsObject().name)
  statement.free()
  cleaned.close()
  assert.ok(tables.includes('events'))
  assert.ok(!tables.includes('accounts'))
  assert.ok(!tables.includes('product_events'))
  await rm(directory, { recursive: true, force: true })
})
