import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

export const SERVICE = 'geod-telemetry'
export const TIME_ZONE = 'Asia/Shanghai'
export const EVENT_COLUMNS = ['event_id', 'event_name', 'occurred_at', 'event_day', 'install_id', 'session_id', 'app_version', 'platform', 'properties_json', 'received_at']
const EVENTS_SCHEMA = `CREATE TABLE events (
  event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL, occurred_at TEXT NOT NULL,
  event_day TEXT NOT NULL, install_id TEXT NOT NULL, session_id TEXT NOT NULL,
  app_version TEXT NOT NULL, platform TEXT NOT NULL, properties_json TEXT NOT NULL,
  received_at TEXT NOT NULL
)`

function requireOptions({ databasePath, databaseId, environment }) {
  if (!databasePath || !path.isAbsolute(databasePath)) throw new Error('TELEMETRY_DB_PATH must be an explicit absolute path')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(databaseId || '')) throw new Error('TELEMETRY_DATABASE_ID is required (8-128 safe characters)')
  if (!['production', 'development', 'test'].includes(environment)) throw new Error('NODE_ENV must explicitly select production, development, or test')
}

function assertEventsSchema(database) {
  const columns = database.prepare('PRAGMA table_info(events)').all()
  if (columns.length !== EVENT_COLUMNS.length || columns.some((column, index) => column.name !== EVENT_COLUMNS[index] || column.type.toUpperCase() !== 'TEXT') || columns[0]?.pk !== 1) {
    throw new Error('GeoD events schema mismatch; refusing to use this database')
  }
  if (database.prepare('SELECT count(*) AS count FROM events WHERE event_id IS NULL OR occurred_at IS NULL OR date(occurred_at) IS NULL').get().count) {
    throw new Error('GeoD events contain invalid identity or timestamp rows')
  }
}

function assertIdentity(database, { databaseId, environment }) {
  const hasIdentity = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_service_identity'").get()
  if (!hasIdentity) throw new Error('Database identity missing; use the explicit offline initialization tool')
  const rows = database.prepare('SELECT * FROM _service_identity').all()
  const identity = rows[0]
  if (rows.length !== 1 || identity.service !== SERVICE || identity.database_id !== databaseId || identity.environment !== environment || identity.schema_version !== 1) {
    throw new Error('Database identity mismatch; refusing to start')
  }
  return identity
}

function quickCheck(database) {
  const rows = database.prepare('PRAGMA quick_check').all()
  if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('Database integrity check failed')
}

// Deliberately separate from startup: an existing file is never silently trusted.
// Existing databases must be quiesced and backed up by the deployment operator first.
export function initializeDatabase(options) {
  requireOptions(options)
  const { databasePath, databaseId, environment, createNew = false, expectedSha256, expectedEventCount, offlineConfirmed = false } = options
  if (!offlineConfirmed) throw new Error('Explicit offline confirmation is required')
  const exists = existsSync(databasePath)
  if (createNew && exists) throw new Error('Refusing to overwrite an existing database')
  if (!createNew && !exists) throw new Error('Database missing; adoption cannot create an empty replacement')
  if (!createNew && (!/^[a-f0-9]{64}$/i.test(expectedSha256 || '') || !Number.isSafeInteger(expectedEventCount) || expectedEventCount < 0)) {
    throw new Error('Adoption requires expected SHA256 and event count from a verified offline snapshot')
  }
  if (!createNew && ['-wal', '-journal'].some(suffix => existsSync(databasePath + suffix))) {
    throw new Error('Checkpoint/close the database before adoption; WAL or journal sidecar exists')
  }
  if (!createNew && createHash('sha256').update(readFileSync(databasePath)).digest('hex') !== expectedSha256.toLowerCase()) {
    throw new Error('Database source hash mismatch')
  }
  if (createNew) {
    mkdirSync(path.dirname(databasePath), { recursive: true })
    closeSync(openSync(databasePath, 'wx', 0o600))
  }
  let database
  let committed = false
  try {
    database = new DatabaseSync(databasePath, { timeout: 2000 })
    quickCheck(database)
    if (!createNew) assertEventsSchema(database)
    database.exec('PRAGMA synchronous=FULL; BEGIN EXCLUSIVE')
    if (createNew) database.exec(EVENTS_SCHEMA)
    const eventCount = database.prepare('SELECT count(*) AS count FROM events').get().count
    if (!createNew && eventCount !== expectedEventCount) throw new Error('Database source event count mismatch')
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='_service_identity'").get()) throw new Error('Database already has identity; adoption must not overwrite it')
    database.exec(`CREATE TABLE _service_identity (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), service TEXT NOT NULL,
      database_id TEXT NOT NULL, environment TEXT NOT NULL, schema_version INTEGER NOT NULL,
      initialized_at TEXT NOT NULL, adopted_event_count INTEGER NOT NULL, source_sha256 TEXT
    )`)
    database.prepare('INSERT INTO _service_identity VALUES (1, ?, ?, ?, 1, ?, ?, ?)').run(SERVICE, databaseId, environment, new Date().toISOString(), eventCount, createNew ? null : expectedSha256.toLowerCase())
    database.exec('COMMIT')
    committed = true
    quickCheck(database)
    return { service: SERVICE, database_id: databaseId, environment, events: eventCount, initialized: true }
  } catch (error) {
    if (database && !committed) { try { database.exec('ROLLBACK') } catch {} }
    throw error
  } finally {
    database?.close()
    if (createNew && !committed) { try { unlinkSync(databasePath) } catch {} }
  }
}

export function openTelemetryDatabase(options) {
  requireOptions(options)
  const { databasePath, databaseId, environment } = options
  const canonicalPath = realpathSync(databasePath) // ENOENT is fatal; no create-on-missing fallback.
  const originalFile = statSync(canonicalPath)
  if (!originalFile.isFile() || originalFile.size === 0) throw new Error('Database must be an existing non-empty regular file')
  const readonly = new DatabaseSync(canonicalPath, { readOnly: true, timeout: 2000 })
  try { quickCheck(readonly); assertEventsSchema(readonly); assertIdentity(readonly, options) } finally { readonly.close() }
  const database = new DatabaseSync(canonicalPath, { timeout: 2000 })
  try {
    assertIdentity(database, options)
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=2000; PRAGMA wal_autocheckpoint=1000; PRAGMA trusted_schema=OFF;
      CREATE INDEX IF NOT EXISTS events_day_idx ON events(event_day);
      CREATE INDEX IF NOT EXISTS events_install_idx ON events(install_id);
      CREATE INDEX IF NOT EXISTS events_name_idx ON events(event_name);
      CREATE INDEX IF NOT EXISTS events_received_idx ON events(received_at);
      CREATE INDEX IF NOT EXISTS events_beijing_day_idx ON events(date(occurred_at, '+8 hours'));
    `)
    if (database.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal' || database.prepare('PRAGMA synchronous').get().synchronous !== 2) throw new Error('Required WAL/FULL durability settings unavailable')
  } catch (error) { database.close(); throw error }
  let closed = false
  const state = { consecutive_write_failures: 0, last_write_error_at: null, last_write_error_code: null, last_success_at: null, last_received_at: database.prepare('SELECT MAX(received_at) AS at FROM events').get().at }
  const statement = database.prepare(`INSERT INTO events (${EVENT_COLUMNS.join(', ')}) VALUES (${EVENT_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(event_id) DO NOTHING`)

  function checkFile() {
    if (closed) throw new Error('Database is closed')
    const file = statSync(canonicalPath)
    if (file.dev !== originalFile.dev || file.ino !== originalFile.ino || realpathSync(databasePath) !== canonicalPath) throw new Error('Database file changed while service was running')
  }
  function readiness() {
    let available = false
    try { checkFile(); assertIdentity(database, options); database.prepare('SELECT 1 FROM events LIMIT 1').get(); available = true } catch {}
    return { status: available && state.consecutive_write_failures === 0 ? 'ok' : 'unavailable', service: SERVICE, schema_version: 1, storage: 'sqlite-wal', time_zone: TIME_ZONE, database_available: available, ...state, last_write_error_code: undefined }
  }
  return {
    database,
    readiness,
    diagnostics() {
      return { ...readiness(), database_path: canonicalPath, database_id: databaseId, environment, last_write_error_code: state.last_write_error_code, events: database.prepare('SELECT count(*) AS count FROM events').get().count }
    },
    insert(events) {
      let inTransaction = false
      try {
        checkFile()
        database.exec('BEGIN IMMEDIATE'); inTransaction = true
        const receivedAt = new Date().toISOString()
        let inserted = 0
        for (const event of events) {
          inserted += Number(statement.run(event.eventId, event.eventName, event.occurredAt, event.eventDay, event.installId, event.sessionId, event.appVersion, event.platform, JSON.stringify(event.properties), receivedAt).changes)
        }
        database.exec('COMMIT'); inTransaction = false
        state.last_success_at = receivedAt
        if (inserted) state.last_received_at = receivedAt
        state.consecutive_write_failures = 0
        return inserted
      } catch (error) {
        if (inTransaction) { try { database.exec('ROLLBACK') } catch {} }
        state.consecutive_write_failures += 1
        state.last_write_error_at = new Date().toISOString()
        state.last_write_error_code = /^[A-Z_]+$/.test(error.code || '') ? error.code : 'STORAGE_WRITE_FAILED'
        throw error
      }
    },
    close() {
      if (closed) return
      try { database.exec('PRAGMA wal_checkpoint(TRUNCATE)') } finally { database.close(); closed = true }
    },
  }
}
