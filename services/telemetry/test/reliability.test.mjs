import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createTelemetryServer, loadConfig, validateEnvelope } from '../server.mjs'
import { initializeDatabase, openTelemetryDatabase } from '../database.mjs'

const databaseId = 'geod-test-database-20260907'
function event(overrides = {}) {
  return { event_id: randomUUID(), event: 'app_started', occurred_at: new Date().toISOString(), install_id: randomUUID(), session_id: randomUUID(), app_version: '3.6.6', platform: 'windows', properties: {}, ...overrides }
}
const envelope = events => ({ schema_version: 1, events })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t, { initialize = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'geod-native-test-'))
  const config = { host: '127.0.0.1', port: 0, databasePath: path.join(directory, 'geod.sqlite'), databaseId, environment: 'test', adminTokenFile: path.join(directory, 'admin-token.txt'), maxBodyBytes: 131072, rateLimitPerMinute: 1000 }
  await writeFile(config.adminTokenFile, 'admin-test-token')
  if (initialize) initializeDatabase({ ...config, createNew: true, offlineConfirmed: true })
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  return { directory, config }
}
async function start(t, config) {
  const server = await createTelemetryServer({ config })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.shutdown())
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}
const authenticated = { headers: { authorization: 'Bearer admin-test-token' } }

test('explicit config is required and a missing database is never created', async t => {
  const { config } = await fixture(t, { initialize: false })
  assert.equal(loadConfig({}).databasePath, undefined)
  assert.throws(() => openTelemetryDatabase({ ...config, databasePath: undefined }), /explicit absolute path/)
  assert.throws(() => openTelemetryDatabase({ ...config, databaseId: undefined }), /DATABASE_ID/)
  assert.throws(() => openTelemetryDatabase({ ...config, environment: undefined }), /NODE_ENV/)
  assert.throws(() => openTelemetryDatabase(config), /ENOENT/)
  await assert.rejects(stat(config.databasePath), { code: 'ENOENT' })
  assert.throws(() => initializeDatabase({ ...config, offlineConfirmed: true }), /missing/)
})

test('initialization is explicit and wrong identity/environment is rejected without changes', async t => {
  const { config } = await fixture(t)
  assert.throws(() => initializeDatabase({ ...config, createNew: true }), /offline confirmation/)
  assert.throws(() => initializeDatabase({ ...config, createNew: true, offlineConfirmed: true }), /overwrite/)
  const before = digest(await readFile(config.databasePath))
  assert.throws(() => openTelemetryDatabase({ ...config, databaseId: 'different-identity' }), /identity mismatch/)
  assert.throws(() => openTelemetryDatabase({ ...config, environment: 'production' }), /identity mismatch/)
  assert.equal(digest(await readFile(config.databasePath)), before)
})

test('accepts existing GeoD/assistant events and rejects private properties', () => {
  assert.equal(validateEnvelope(envelope([event()]))[0].eventName, 'app_started')
  assert.throws(() => validateEnvelope(envelope([event({ properties: { url: 'https://example.com' } })])), /properties must be empty/)
  const assistant = event({ event: 'assistant_request', properties: { outcome: 'success', diagnostics_attached: true, source_count: '2-10', duration: '3-10s' } })
  assert.deepEqual(validateEnvelope(envelope([assistant]))[0].properties, assistant.properties)
  assert.throws(() => validateEnvelope(envelope([{ ...assistant, properties: { ...assistant.properties, prompt: 'private user content' } }])), /properties are invalid/)
})

test('HTTP preserves idempotence, protected statistics, route boundaries, and graceful restart', async t => {
  const { config } = await fixture(t)
  const { server, base } = await start(t, config)
  const health = await fetch(`${base}/geod-telemetry/health`).then(r => r.json())
  assert.equal(health.status, 'ok'); assert.equal(health.schema_version, 1); assert.equal(health.storage, 'sqlite-wal')
  assert(!JSON.stringify(health).includes(config.databasePath)); assert(!JSON.stringify(health).includes(databaseId))
  const e = event()
  for (const expected of [1, 0]) {
    const r = await fetch(`${base}/geod-telemetry/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope([e, e])) })
    assert.equal(r.status, 202); assert.deepEqual(await r.json(), { accepted: 2, inserted: expected })
  }
  assert.equal((await fetch(`${base}/admin/stats`)).status, 401)
  assert.equal((await fetch(`${base}/admin/storage`)).status, 401)
  const stats = await fetch(`${base}/admin/stats`, authenticated).then(r => r.json())
  assert.equal(stats.totals.event_count, 1); assert.equal(stats.reporting_time_zone, 'Asia/Shanghai')
  assert.match(stats.metric_definitions.installs, /not natural persons/)
  assert.match(stats.metric_definitions.download_task_created, /not completed/)
  const diagnostics = await fetch(`${base}/admin/storage`, authenticated).then(r => r.json())
  assert.equal(diagnostics.database_id, databaseId); assert(diagnostics.last_received_at)
  for (const route of ['/geod-telemetry/v1/quota', '/geod-telemetry/public/product-stats', '/geod-telemetry/wechat/callback']) assert.equal((await fetch(base + route)).status, 404)
  await server.shutdown()
  const reopened = openTelemetryDatabase(config)
  assert.equal(reopened.database.prepare('SELECT count(*) AS n FROM events').get().n, 1)
  assert.equal(reopened.database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(reopened.database.prepare('PRAGMA synchronous').get().synchronous, 2)
  reopened.close()
})

function buildLegacy(databasePath) {
  const db = new DatabaseSync(databasePath)
  db.exec(`CREATE TABLE events (event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL, occurred_at TEXT NOT NULL, event_day TEXT NOT NULL, install_id TEXT NOT NULL, session_id TEXT NOT NULL, app_version TEXT NOT NULL, platform TEXT NOT NULL, properties_json TEXT NOT NULL, received_at TEXT NOT NULL);
    CREATE TABLE unrelated_evidence (id TEXT PRIMARY KEY, value TEXT); INSERT INTO unrelated_evidence VALUES ('preserve', 'exactly');`)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const rows = ['15:59:59.000', '16:00:00.000', '23:59:59.000'].map((time, i) => [randomUUID(), 'app_started', `${yesterday}T${time}Z`, yesterday, `historic-install-${i}`, `historic-session-${i}`, '3.6.6', 'windows', '{}', new Date().toISOString()])
  const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  rows.forEach(row => insert.run(...row))
  const before = db.prepare('SELECT * FROM events ORDER BY event_id').all().map(row => ({ ...row }))
  db.close(); return { before, yesterday }
}

test('legacy adoption verifies provenance, preserves full history, and fixes historical daily aggregation', async t => {
  const { config } = await fixture(t, { initialize: false })
  const { before, yesterday } = buildLegacy(config.databasePath)
  assert.throws(() => openTelemetryDatabase(config), /identity missing/)
  const expectedSha256 = digest(await readFile(config.databasePath))
  assert.throws(() => initializeDatabase({ ...config, offlineConfirmed: true, expectedSha256: 'f'.repeat(64), expectedEventCount: 3 }), /hash mismatch/)
  assert.throws(() => initializeDatabase({ ...config, offlineConfirmed: true, expectedSha256, expectedEventCount: 4 }), /count mismatch/)
  assert.equal(digest(await readFile(config.databasePath)), expectedSha256)
  initializeDatabase({ ...config, offlineConfirmed: true, expectedSha256, expectedEventCount: 3 })
  const { base, server } = await start(t, config)
  const stats = await fetch(`${base}/admin/stats`, authenticated).then(r => r.json())
  const following = new Date(Date.parse(yesterday) + 86400000).toISOString().slice(0, 10)
  assert.equal(stats.daily.find(row => row.day === yesterday).events, 1)
  assert.equal(stats.daily.find(row => row.day === following).events, 2)
  await server.shutdown()
  const read = new DatabaseSync(config.databasePath, { readOnly: true })
  assert.deepEqual(read.prepare('SELECT * FROM events ORDER BY event_id').all().map(row => ({ ...row })), before)
  assert.equal(read.prepare('SELECT value FROM unrelated_evidence').get().value, 'exactly')
  assert.equal(read.prepare('SELECT count(*) AS n FROM _service_identity').get().n, 1)
  read.close()
})

test('new event dates use Beijing midnight and do not roll again at 08:00', () => {
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10)
  for (const [iso, expected] of [[`${day}T15:59:59Z`, day], [`${day}T16:00:00Z`, next], [`${day}T23:59:59Z`, next], [`${next}T00:00:00Z`, next]]) {
    const normalized = validateEnvelope(envelope([event({ occurred_at: iso })]))[0]
    assert.equal(normalized.eventDay, expected); assert.equal(normalized.occurredAt, new Date(iso).toISOString())
  }
})

test('batch errors roll back and readiness stays degraded until a durable write succeeds', async t => {
  const { config } = await fixture(t)
  const storage = openTelemetryDatabase(config)
  try {
    storage.database.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON events WHEN NEW.app_version='fail' BEGIN SELECT RAISE(ABORT, 'test'); END")
    assert.throws(() => storage.insert(validateEnvelope(envelope([event(), event({ app_version: 'fail' })]))))
    assert.equal(storage.database.prepare('SELECT count(*) AS n FROM events').get().n, 0)
    assert.equal(storage.readiness().status, 'unavailable'); assert.equal(storage.readiness().consecutive_write_failures, 1)
    assert(storage.diagnostics().last_write_error_code)
    storage.database.exec('DROP TRIGGER injected_failure')
    assert.equal(storage.insert(validateEnvelope(envelope([event()]))), 1)
    assert.equal(storage.readiness().status, 'ok'); assert.equal(storage.readiness().consecutive_write_failures, 0)
  } finally { storage.close() }
})

test('a different product schema is not adopted or modified', async t => {
  const { config } = await fixture(t, { initialize: false })
  const db = new DatabaseSync(config.databasePath)
  db.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY)'); db.close()
  const hash = digest(await readFile(config.databasePath))
  assert.throws(() => initializeDatabase({ ...config, offlineConfirmed: true, expectedSha256: hash, expectedEventCount: 0 }), /schema mismatch/)
  assert.equal(digest(await readFile(config.databasePath)), hash)
})

test('committed WAL events survive an abrupt process kill and reopening', async t => {
  const { config } = await fixture(t)
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../database.mjs')).href
  const events = validateEnvelope(envelope([event(), event()]))
  const code = `import { openTelemetryDatabase } from ${JSON.stringify(moduleUrl)}; const db = openTelemetryDatabase(${JSON.stringify(config)}); db.insert(${JSON.stringify(events)}); process.send({ committed: true }); setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) })
  assert.equal(message.committed, true)
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
  const storage = openTelemetryDatabase(config)
  try {
    assert.equal(storage.database.prepare('SELECT count(*) AS n FROM events').get().n, 2)
    assert.equal(storage.insert(events), 0)
    assert.equal(storage.database.prepare('PRAGMA quick_check').get().quick_check, 'ok')
    assert.equal(storage.readiness().status, 'ok')
  } finally { storage.close() }
})

test('graceful shutdown drains an already accepted request before closing storage', async t => {
  const { config } = await fixture(t)
  const { server, base } = await start(t, config)
  const body = JSON.stringify(envelope([event()]))
  const reachedServer = once(server, 'request')
  const response = new Promise((resolve, reject) => {
    const req = request(base + '/v1/events', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let bytes = ''; res.on('data', c => { bytes += c }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(bytes) }))
    })
    req.on('error', reject)
    req.write(body.slice(0, 30))
    reachedServer.then(() => { server.shutdown(); req.end(body.slice(30)) }).catch(reject)
  })
  assert.deepEqual(await response, { status: 202, body: { accepted: 1, inserted: 1 } })
  await server.shutdown()
  const storage = openTelemetryDatabase(config)
  assert.equal(storage.database.prepare('SELECT count(*) AS n FROM events').get().n, 1)
  storage.close()
})
