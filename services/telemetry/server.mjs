import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import initSqlJs from 'sql.js'
import { createAccountService, initializeAccounts } from './account-service.mjs'
import {
  initializeProductEvents,
  insertProductEvents,
  productStats,
  validateProductEnvelope,
} from './product-events.mjs'

const SERVICE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/
const EVENT_NAMES = new Set([
  'app_started',
  'mode_changed',
  'sidebar_tab_changed',
  'graticule_changed',
  'selection_changed',
  'region_imported',
  'bookmark_action',
  'download_task_created',
  'task_action',
  'measurement_used',
  'onboarding_event',
])
const PLATFORMS = new Set(['windows', 'macos', 'linux', 'web', 'unknown'])
const MODES = new Set(['imagery', 'dem', 'wayback', 'tiles3d', 'vector', 'mvt'])
const SIDEBAR_TABS = new Set(['download', 'history', 'settings'])
const PRODUCT_EVENT_ORIGINS = new Set([
  'https://gaopengbin.github.io',
  'https://chat.laogao.xyz',
  'https://geodownloader.pages.dev',
  'https://wallpaper.gpb.cc',
  'https://laogao.xyz',
  'http://127.0.0.1:4178',
])
const COUNT_BUCKETS = new Set(['0', '1', '2-10', '11-100', '100+'])
const SELECTION_METHODS = new Set([
  'draw_rectangle', 'draw_polygon', 'admin', 'search', 'import', 'bookmark',
])
const GEOMETRIES = new Set(['bounds', 'polygon'])
const IMPORT_FORMATS = new Set(['geojson', 'shapefile', 'kml', 'kmz', 'unknown'])
const IMPORT_OUTCOMES = new Set(['success', 'no_area', 'error'])
const BOOKMARK_ACTIONS = new Set(['created', 'restored', 'renamed', 'deleted'])
const DOWNLOAD_WORKFLOWS = new Set(['raster', 'wayback', 'osm', 'tiles3d'])
const OUTPUT_FORMATS = new Set([
  'geotiff', 'png', 'jpeg', 'tiles', 'mbtiles', 'gpkg', 'pbf', 'unknown',
])
const TASK_ACTIONS = new Set([
  'pause_toggle', 'cancel', 'delete', 'resume', 'discard', 'export_partial',
])
const MEASUREMENT_ACTIONS = new Set(['distance', 'area', 'clear'])
const ONBOARDING_TOURS = new Set([
  'main', 'region', 'download_center', 'imagery', 'mvt', 'osm', 'tiles3d', 'wayback',
])
const ONBOARDING_ACTIONS = new Set(['started', 'completed', 'dismissed'])

function envInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: envInteger(env.PORT, 9091, 0, 65535),
    databasePath:
      env.TELEMETRY_DB_PATH || 'C:/nginx-1.30.2/data/geod-telemetry.sqlite',
    adminTokenFile:
      env.TELEMETRY_ADMIN_TOKEN_FILE ||
      'C:/nginx-1.30.2/geod-telemetry-admin-token.txt',
    wechatCallbackTokenFile:
      env.WECHAT_CALLBACK_TOKEN_FILE ||
      'C:/nginx-1.30.2/wechat-callback-token.txt',
    maxBodyBytes: envInteger(env.MAX_BODY_BYTES, 131072, 1024, 1024 * 1024),
    rateLimitPerMinute: envInteger(env.RATE_LIMIT_PER_MINUTE, 120, 10, 5000),
    wechatCallbackToken: env.WECHAT_CALLBACK_TOKEN || '',
  }
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function invalid(message) {
  const error = new Error(message)
  error.status = 400
  error.code = 'invalid_event'
  return error
}

function validateProperties(eventName, properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw invalid('properties must be an object')
  }

  if (eventName === 'app_started') {
    if (!exactKeys(properties, [])) throw invalid('app_started properties must be empty')
    return {}
  }

  if (eventName === 'mode_changed') {
    if (!exactKeys(properties, ['mode']) || !MODES.has(properties.mode)) {
      throw invalid('mode_changed properties are invalid')
    }
    return { mode: properties.mode }
  }

  if (eventName === 'sidebar_tab_changed') {
    if (!exactKeys(properties, ['tab']) || !SIDEBAR_TABS.has(properties.tab)) {
      throw invalid('sidebar_tab_changed properties are invalid')
    }
    return { tab: properties.tab }
  }

  if (eventName === 'selection_changed') {
    if (
      !exactKeys(properties, ['complexity', 'geometry', 'method']) ||
      !SELECTION_METHODS.has(properties.method) ||
      !GEOMETRIES.has(properties.geometry) ||
      !COUNT_BUCKETS.has(properties.complexity)
    ) throw invalid('selection_changed properties are invalid')
    return { method: properties.method, geometry: properties.geometry, complexity: properties.complexity }
  }

  if (eventName === 'region_imported') {
    if (
      !exactKeys(properties, ['feature_count', 'format', 'outcome']) ||
      !IMPORT_FORMATS.has(properties.format) ||
      !IMPORT_OUTCOMES.has(properties.outcome) ||
      !COUNT_BUCKETS.has(properties.feature_count)
    ) throw invalid('region_imported properties are invalid')
    return { format: properties.format, outcome: properties.outcome, feature_count: properties.feature_count }
  }

  if (eventName === 'bookmark_action') {
    if (!exactKeys(properties, ['action']) || !BOOKMARK_ACTIONS.has(properties.action)) {
      throw invalid('bookmark_action properties are invalid')
    }
    return { action: properties.action }
  }

  if (eventName === 'download_task_created') {
    if (
      !exactKeys(properties, ['output_format', 'selection', 'workflow', 'zoom_count']) ||
      !DOWNLOAD_WORKFLOWS.has(properties.workflow) ||
      !OUTPUT_FORMATS.has(properties.output_format) ||
      !COUNT_BUCKETS.has(properties.zoom_count) ||
      !GEOMETRIES.has(properties.selection)
    ) throw invalid('download_task_created properties are invalid')
    return {
      workflow: properties.workflow,
      output_format: properties.output_format,
      zoom_count: properties.zoom_count,
      selection: properties.selection,
    }
  }

  if (eventName === 'task_action') {
    if (!exactKeys(properties, ['action']) || !TASK_ACTIONS.has(properties.action)) {
      throw invalid('task_action properties are invalid')
    }
    return { action: properties.action }
  }

  if (eventName === 'measurement_used') {
    if (!exactKeys(properties, ['action']) || !MEASUREMENT_ACTIONS.has(properties.action)) {
      throw invalid('measurement_used properties are invalid')
    }
    return { action: properties.action }
  }

  if (eventName === 'onboarding_event') {
    if (
      !exactKeys(properties, ['action', 'tour']) ||
      !ONBOARDING_TOURS.has(properties.tour) ||
      !ONBOARDING_ACTIONS.has(properties.action)
    ) throw invalid('onboarding_event properties are invalid')
    return { tour: properties.tour, action: properties.action }
  }

  if (eventName !== 'graticule_changed' ||
    !exactKeys(properties, ['enabled', 'interval', 'interval_mode']) ||
    typeof properties.enabled !== 'boolean' ||
    !['auto', 'fixed'].includes(properties.interval_mode) ||
    typeof properties.interval !== 'number' ||
    !Number.isFinite(properties.interval) ||
    properties.interval <= 0 ||
    properties.interval > 180
  ) {
    throw invalid('graticule_changed properties are invalid')
  }
  return {
    enabled: properties.enabled,
    interval_mode: properties.interval_mode,
    interval: properties.interval,
  }
}

function validateEvent(event) {
  const keys = [
    'app_version',
    'event',
    'event_id',
    'install_id',
    'occurred_at',
    'platform',
    'properties',
    'session_id',
  ]
  if (!exactKeys(event, keys)) throw invalid('event fields are invalid')
  if (!UUID_PATTERN.test(event.event_id)) throw invalid('event_id is invalid')
  if (!UUID_PATTERN.test(event.install_id)) throw invalid('install_id is invalid')
  if (!UUID_PATTERN.test(event.session_id)) throw invalid('session_id is invalid')
  if (!EVENT_NAMES.has(event.event)) throw invalid('event name is not allowed')
  if (!PLATFORMS.has(event.platform)) throw invalid('platform is invalid')
  if (typeof event.app_version !== 'string' || !VERSION_PATTERN.test(event.app_version)) {
    throw invalid('app_version is invalid')
  }

  const occurredAt = new Date(event.occurred_at)
  if (
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.getTime() > Date.now() + 24 * 60 * 60 * 1000 ||
    occurredAt.getTime() < Date.now() - 90 * 24 * 60 * 60 * 1000
  ) {
    throw invalid('occurred_at is outside the accepted range')
  }

  return {
    eventId: event.event_id,
    eventName: event.event,
    occurredAt: occurredAt.toISOString(),
    eventDay: occurredAt.toISOString().slice(0, 10),
    installId: event.install_id,
    sessionId: event.session_id,
    appVersion: event.app_version,
    platform: event.platform,
    properties: validateProperties(event.event, event.properties),
  }
}

export function validateEnvelope(body) {
  if (!exactKeys(body, ['events', 'schema_version'])) {
    throw invalid('request fields are invalid')
  }
  if (body.schema_version !== 1) throw invalid('schema_version is not supported')
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > 50) {
    throw invalid('events must contain between 1 and 50 items')
  }
  return body.events.map(validateEvent)
}

async function readJsonBody(request, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error('request body is too large')
      error.status = 413
      error.code = 'body_too_large'
      throw error
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('request body is not valid JSON')
    error.status = 400
    error.code = 'invalid_json'
    throw error
  }
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  response.end(JSON.stringify(body))
}

function sendError(response, status, message, code) {
  sendJson(response, status, { error: { code, message } })
}

function setCors(response, origin = '*') {
  response.setHeader('access-control-allow-origin', origin)
  response.setHeader('access-control-allow-headers', 'authorization, content-type')
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  response.setHeader('access-control-max-age', '86400')
}

async function readTextBody(request, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error('request body is too large')
      error.status = 413
      error.code = 'body_too_large'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function bearerToken(request) {
  const value = typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : ''
  return value.startsWith('Bearer ') ? value.slice(7).trim() : ''
}

function validWechatSignature(token, timestamp, nonce, signature) {
  if (!token || !timestamp || !nonce || !signature) return false
  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false
  const expected = createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
  const left = Buffer.from(expected)
  const right = Buffer.from(signature)
  return left.length === right.length && timingSafeEqual(left, right)
}

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tag}>`, 'i'))
  return (match?.[1] ?? match?.[2] ?? '').trim()
}

function cdata(value) {
  return String(value).replaceAll(']]>', ']]&gt;')
}

function wechatTextReply(toUser, fromUser, content) {
  return `<xml><ToUserName><![CDATA[${cdata(toUser)}]]></ToUserName><FromUserName><![CDATA[${cdata(fromUser)}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${cdata(content)}]]></Content></xml>`
}

function requestAddress(request) {
  const realIp = request.headers['x-real-ip']
  if (typeof realIp === 'string' && realIp.length <= 64) return realIp
  return request.socket.remoteAddress || 'unknown'
}

function createRateLimiter(limit) {
  const windows = new Map()
  return (key) => {
    const now = Date.now()
    const previous = windows.get(key)
    if (!previous || previous.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + 60_000 })
      return true
    }
    previous.count += 1
    return previous.count <= limit
  }
}

function queryRows(database, sql, parameters = []) {
  const statement = database.prepare(sql)
  try {
    statement.bind(parameters)
    const rows = []
    while (statement.step()) rows.push(statement.getAsObject())
    return rows
  } finally {
    statement.free()
  }
}

function propertyDistribution(database, eventName, propertyName) {
  if (!/^[a-z_]+$/.test(propertyName)) throw new Error('invalid telemetry property name')
  return queryRows(
    database,
    `SELECT json_extract(properties_json, '$.${propertyName}') AS value, COUNT(*) AS count
     FROM events
     WHERE event_name = ?
     GROUP BY value ORDER BY count DESC`,
    [eventName],
  )
}

export async function replaceDatabaseFile(
  temporaryPath,
  databasePath,
  operations = { copyFile, readFile, rename, rm, writeFile },
) {
  try {
    await operations.rename(temporaryPath, databasePath)
    return
  } catch (error) {
    if (!['EPERM', 'EEXIST'].includes(error?.code)) throw error
  }

  const backupPath = `${databasePath}.bak`
  let backupCreated = false
  try {
    await operations.copyFile(databasePath, backupPath)
    backupCreated = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  try {
    const contents = await operations.readFile(temporaryPath)
    await operations.writeFile(databasePath, contents)
  } catch (error) {
    if (backupCreated) {
      const backup = await operations.readFile(backupPath).catch(() => null)
      if (backup) await operations.writeFile(databasePath, backup).catch(() => {})
    }
    throw error
  } finally {
    await operations.rm(temporaryPath, { force: true }).catch(() => {})
  }

  if (backupCreated) {
    await operations.rm(backupPath, { force: true }).catch(() => {})
  }
}

async function createDatabase(databasePath) {
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
  const SQL = await initSqlJs({ locateFile: () => wasmPath })
  let database
  try {
    database = new SQL.Database(await readFile(databasePath))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    database = new SQL.Database()
  }

  database.run(`
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      event_day TEXT NOT NULL,
      install_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      app_version TEXT NOT NULL,
      platform TEXT NOT NULL,
      properties_json TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_day_idx ON events(event_day);
    CREATE INDEX IF NOT EXISTS events_install_idx ON events(install_id);
    CREATE INDEX IF NOT EXISTS events_name_idx ON events(event_name);
  `)
  initializeProductEvents(database)
  initializeAccounts(database)

  await mkdir(path.dirname(databasePath), { recursive: true })
  let writeChain = Promise.resolve()

  async function persist() {
    const temporaryPath = `${databasePath}.tmp`
    await writeFile(temporaryPath, Buffer.from(database.export()))
    await replaceDatabaseFile(temporaryPath, databasePath)
  }

  await persist()

  async function insert(events) {
    let inserted = 0
    database.run('BEGIN TRANSACTION')
    try {
      const statement = database.prepare(`
        INSERT OR IGNORE INTO events (
          event_id, event_name, occurred_at, event_day, install_id,
          session_id, app_version, platform, properties_json, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      try {
        const receivedAt = new Date().toISOString()
        for (const event of events) {
          statement.run([
            event.eventId,
            event.eventName,
            event.occurredAt,
            event.eventDay,
            event.installId,
            event.sessionId,
            event.appVersion,
            event.platform,
            JSON.stringify(event.properties),
            receivedAt,
          ])
          inserted += database.getRowsModified()
        }
      } finally {
        statement.free()
      }
      database.run('COMMIT')
    } catch (error) {
      database.run('ROLLBACK')
      throw error
    }
    await persist()
    return inserted
  }

  function serializedWrite(operation) {
    const queued = writeChain.then(async () => {
      const result = await operation()
      await persist()
      return result
    })
    writeChain = queued.catch(() => {})
    return queued
  }

  const accounts = createAccountService(database, serializedWrite)

  return {
    accounts,
    insert(events) {
      const operation = writeChain.then(() => insert(events))
      writeChain = operation.catch(() => {})
      return operation
    },
    insertProduct(events) {
      const operation = writeChain.then(async () => {
        const inserted = insertProductEvents(database, events)
        await persist()
        return inserted
      })
      writeChain = operation.catch(() => {})
      return operation
    },
    productStats() {
      return productStats(database)
    },
    stats() {
      const totals = queryRows(
        database,
        `SELECT
          COUNT(*) AS event_count,
          COUNT(DISTINCT install_id) AS installs,
          COUNT(DISTINCT CASE WHEN julianday(occurred_at) >= julianday('now', '-24 hours') THEN install_id END) AS dau,
          COUNT(DISTINCT CASE WHEN julianday(occurred_at) >= julianday('now', '-7 days') THEN install_id END) AS wau,
          COUNT(DISTINCT CASE WHEN julianday(occurred_at) >= julianday('now', '-30 days') THEN install_id END) AS mau
        FROM events`,
      )[0]
      return {
        generated_at: new Date().toISOString(),
        totals,
        daily: queryRows(
          database,
          `WITH daily_activity AS (
             SELECT event_day AS day, COUNT(DISTINCT install_id) AS active_installs,
               COUNT(*) AS events
             FROM events
             WHERE event_day >= date('now', '-29 day')
             GROUP BY event_day
           ),
           first_seen AS (
             SELECT install_id, MIN(event_day) AS first_day
             FROM events
             GROUP BY install_id
           ),
           daily_installs AS (
             SELECT first_day AS day, COUNT(*) AS new_installs
             FROM first_seen
             WHERE first_day >= date('now', '-29 day')
             GROUP BY first_day
           )
           SELECT daily_activity.day, daily_activity.active_installs, daily_activity.events,
             COALESCE(daily_installs.new_installs, 0) AS new_installs
           FROM daily_activity
           LEFT JOIN daily_installs ON daily_installs.day = daily_activity.day
           ORDER BY daily_activity.day`,
        ),
        versions: queryRows(
          database,
          `SELECT app_version AS version, COUNT(DISTINCT install_id) AS installs
           FROM events GROUP BY app_version ORDER BY installs DESC, app_version LIMIT 20`,
        ),
        platforms: queryRows(
          database,
          `SELECT platform, COUNT(DISTINCT install_id) AS installs
           FROM events GROUP BY platform ORDER BY installs DESC`,
        ),
        events: queryRows(
          database,
          `SELECT event_name AS event, COUNT(*) AS count
           FROM events GROUP BY event_name ORDER BY count DESC`,
        ),
        event_details: {
          modes: queryRows(
            database,
            `SELECT json_extract(properties_json, '$.mode') AS value, COUNT(*) AS count
             FROM events
             WHERE event_name = 'mode_changed'
             GROUP BY value ORDER BY count DESC`,
          ),
          sidebar_tabs: queryRows(
            database,
            `SELECT json_extract(properties_json, '$.tab') AS value, COUNT(*) AS count
             FROM events
             WHERE event_name = 'sidebar_tab_changed'
             GROUP BY value ORDER BY count DESC`,
          ),
          graticule_enabled: queryRows(
            database,
            `SELECT json_extract(properties_json, '$.enabled') AS value, COUNT(*) AS count
             FROM events
             WHERE event_name = 'graticule_changed'
             GROUP BY value ORDER BY count DESC`,
          ),
          graticule_modes: queryRows(
            database,
            `SELECT json_extract(properties_json, '$.interval_mode') AS value, COUNT(*) AS count
             FROM events
             WHERE event_name = 'graticule_changed'
             GROUP BY value ORDER BY count DESC`,
          ),
          graticule_intervals: queryRows(
            database,
            `SELECT json_extract(properties_json, '$.interval') AS value, COUNT(*) AS count
             FROM events
             WHERE event_name = 'graticule_changed'
             GROUP BY value ORDER BY count DESC LIMIT 12`,
          ),
          selection_methods: propertyDistribution(database, 'selection_changed', 'method'),
          selection_geometries: propertyDistribution(database, 'selection_changed', 'geometry'),
          selection_complexities: propertyDistribution(database, 'selection_changed', 'complexity'),
          import_formats: propertyDistribution(database, 'region_imported', 'format'),
          import_outcomes: propertyDistribution(database, 'region_imported', 'outcome'),
          import_feature_counts: propertyDistribution(database, 'region_imported', 'feature_count'),
          bookmark_actions: propertyDistribution(database, 'bookmark_action', 'action'),
          task_workflows: propertyDistribution(database, 'download_task_created', 'workflow'),
          task_output_formats: propertyDistribution(database, 'download_task_created', 'output_format'),
          task_zoom_counts: propertyDistribution(database, 'download_task_created', 'zoom_count'),
          task_selections: propertyDistribution(database, 'download_task_created', 'selection'),
          task_actions: propertyDistribution(database, 'task_action', 'action'),
          measurement_actions: propertyDistribution(database, 'measurement_used', 'action'),
          onboarding_tours: propertyDistribution(database, 'onboarding_event', 'tour'),
          onboarding_actions: propertyDistribution(database, 'onboarding_event', 'action'),
        },
        devices: queryRows(
          database,
          `WITH device_summary AS (
             SELECT install_id,
               MIN(occurred_at) AS first_seen,
               MAX(occurred_at) AS last_active,
               COUNT(*) AS event_count,
               COUNT(DISTINCT session_id) AS session_count,
               COUNT(DISTINCT event_day) AS active_days,
               SUM(CASE WHEN event_name = 'app_started' THEN 1 ELSE 0 END) AS launch_count
             FROM events
             GROUP BY install_id
           )
           SELECT
             substr(device_summary.install_id, 1, 8) AS install_key,
             device_summary.first_seen,
             device_summary.last_active,
             device_summary.event_count,
             device_summary.session_count,
             device_summary.active_days,
             device_summary.launch_count,
             (
               SELECT app_version FROM events latest
               WHERE latest.install_id = device_summary.install_id
               ORDER BY latest.occurred_at DESC, latest.received_at DESC
               LIMIT 1
             ) AS current_version,
             (
               SELECT platform FROM events latest
               WHERE latest.install_id = device_summary.install_id
               ORDER BY latest.occurred_at DESC, latest.received_at DESC
               LIMIT 1
             ) AS platform
           FROM device_summary
           ORDER BY device_summary.last_active DESC
           LIMIT 200`,
        ),
      }
    },
    close() {
      database.close()
    },
  }
}

async function readAdminToken(tokenFile) {
  try {
    return (await readFile(tokenFile, 'utf8')).trim()
  } catch {
    return ''
  }
}

function serveAdmin(response) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  })
  response.end(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GeoD 匿名使用统计</title>
<style>
*{box-sizing:border-box}
:root{color-scheme:light;--blue:#2563eb;--blue-soft:#eff6ff;--green:#059669;--amber:#d97706;--ink:#172033;--muted:#667085;--line:#e4e7ec;--surface:#fff;--page:#f5f7fb}
body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:1240px;margin:0 auto;padding:28px 20px 56px}
header{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:22px}
h1{margin:0;font-size:24px;line-height:1.25}.brand{color:var(--blue)}.muted{color:var(--muted)}
.login{display:flex;gap:8px;flex:0 0 auto}input,button{height:38px;border:1px solid #d0d5dd;border-radius:6px;padding:0 12px;background:#fff;font:inherit}
input{width:195px}input:focus,button:focus-visible{outline:3px solid #bfdbfe;outline-offset:1px}
button{cursor:pointer;background:var(--blue);color:#fff;border-color:var(--blue);font-weight:600;transition:background .18s ease}
button:hover{background:#1d4ed8}
.cards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:16px}
.card,.panel{background:var(--surface);border:1px solid var(--line);border-radius:8px}
.card{padding:16px 18px;min-height:108px;position:relative;overflow:hidden}
.card:before{content:"";position:absolute;left:0;top:0;width:100%;height:3px;background:var(--accent,var(--blue))}
.card-label{color:var(--muted);font-size:13px}.value{font-size:28px;font-weight:700;line-height:1.2;margin-top:7px;font-variant-numeric:tabular-nums}
.card-note{color:var(--muted);font-size:12px;margin-top:5px}
.dashboard-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:16px;align-items:start}
.dashboard-grid>*{min-width:0}.panel{padding:18px;min-width:0}.side-stack{display:grid;gap:16px;min-width:0}.full{grid-column:1/-1}
.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
h2{font-size:16px;margin:0}.panel-note{font-size:12px;color:var(--muted)}
.chart-wrap{width:100%;max-width:100%;aspect-ratio:3/1;min-height:220px;overflow:hidden}.chart-wrap svg{display:block;width:100%;max-width:100%;height:100%;overflow:hidden}
.legend{display:flex;gap:16px;align-items:center;color:var(--muted);font-size:12px}.legend-item{display:flex;gap:6px;align-items:center}
.legend-swatch{width:10px;height:10px;border-radius:2px;background:var(--swatch)}
.distribution{display:grid;gap:12px}.bar-row{display:grid;gap:5px}.bar-meta{display:flex;justify-content:space-between;gap:12px;font-size:13px}
.bar-value{font-variant-numeric:tabular-nums;color:var(--muted)}.bar-track{height:7px;background:#eef2f7;border-radius:4px;overflow:hidden}
.bar-fill{height:100%;width:0;background:var(--bar,var(--blue));border-radius:4px}
.event-group{display:grid;gap:8px}.event-group+.event-group{padding-top:12px;border-top:1px solid #eef0f3}
.event-details{display:grid;gap:7px;padding:2px 0 0 12px;border-left:2px solid #dbeafe}.event-detail-title{color:var(--muted);font-size:11px;font-weight:600}
.detail-list{display:grid;gap:6px}.detail-row{display:grid;grid-template-columns:minmax(72px,1fr) minmax(60px,1.5fr) auto;gap:8px;align-items:center;font-size:12px}
.detail-track{height:4px;background:#eef2f7;border-radius:2px;overflow:hidden}.detail-fill{height:100%;background:#60a5fa;border-radius:2px}
.table-scroll{width:100%;max-width:100%;overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap}
th,td{text-align:left;border-bottom:1px solid #eef0f3;padding:10px 8px}th{color:var(--muted);font-size:12px;font-weight:600;background:#fafbfc;position:sticky;top:0}
td{font-variant-numeric:tabular-nums}.device{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#344054}
.badge{display:inline-flex;align-items:center;min-height:24px;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;background:#f2f4f7;color:#475467}
.badge.active{background:#ecfdf3;color:#027a48}.badge.recent{background:#eff6ff;color:#1d4ed8}.badge.quiet{background:#fff7ed;color:#b45309}
.empty{padding:28px 12px;text-align:center;color:var(--muted)}.error{padding:14px;border:1px solid #fecdca;background:#fef3f2;color:#b42318;border-radius:8px}
details{margin-top:10px}summary{cursor:pointer;color:var(--blue);font-size:12px}.skeleton{height:160px;border-radius:8px;background:#eef2f7}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
@media(max-width:900px){.cards{grid-template-columns:repeat(3,minmax(0,1fr))}.dashboard-grid{grid-template-columns:1fr}.full{grid-column:auto}}
@media(max-width:640px){main{padding:20px 12px 40px}header{align-items:stretch;flex-direction:column}.login{width:100%}.login input{min-width:0;flex:1}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.card{min-height:100px}.panel{padding:14px}.chart-wrap{aspect-ratio:4/3;min-height:230px}}
</style>
</head>
<body><main>
<header><div><h1><span class="brand">GeoD</span> 匿名使用统计</h1><div class="muted" id="updated">等待载入</div></div>
<div class="login"><input id="token" type="password" placeholder="管理口令"><button id="load">查看统计</button></div></header>
<div id="content"></div>
</main><script>
const tokenInput=document.getElementById('token')
tokenInput.value=localStorage.getItem('geod_telemetry_admin_token')||''
document.getElementById('load').onclick=load
tokenInput.addEventListener('keydown',function(event){if(event.key==='Enter')load()})
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0}
function table(rows,columns){if(!rows.length)return '<div class="empty">暂无数据</div>';return '<div class="table-scroll"><table><thead><tr>'+columns.map(c=>'<th>'+esc(c[0])+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+columns.map(c=>'<td>'+esc(row[c[1]])+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'}
function formatTime(value){const date=new Date(value);return Number.isNaN(date.getTime())?'-':date.toLocaleString('zh-CN',{hour12:false})}
function fillDaily(rows){
 const byDay=new Map(rows.map(row=>[row.day,row])),result=[],today=new Date()
 for(let offset=29;offset>=0;offset--){const date=new Date(today);date.setHours(12,0,0,0);date.setDate(date.getDate()-offset);const day=date.toISOString().slice(0,10);result.push(byDay.get(day)||{day,active_installs:0,events:0,new_installs:0})}
 return result
}
function trendChart(rows){
 const data=fillDaily(rows),width=760,height=250,left=38,right=14,top=18,bottom=34,plotWidth=width-left-right,plotHeight=height-top-bottom
 const maxActive=Math.max(1,...data.map(row=>number(row.active_installs))),maxEvents=Math.max(1,...data.map(row=>number(row.events)))
 const x=index=>left+(index/(data.length-1))*plotWidth
 const y=value=>top+plotHeight-(number(value)/maxActive)*plotHeight
 const eventHeight=value=>(number(value)/maxEvents)*plotHeight
 const points=data.map((row,index)=>x(index).toFixed(1)+','+y(row.active_installs).toFixed(1)).join(' ')
 const area=left+','+(top+plotHeight)+' '+points+' '+(left+plotWidth)+','+(top+plotHeight)
 let grid='',bars='',dots=''
 for(let index=0;index<5;index++){const gy=top+(index/4)*plotHeight;const label=Math.round(maxActive*(1-index/4));grid+='<line x1="'+left+'" y1="'+gy+'" x2="'+(left+plotWidth)+'" y2="'+gy+'" stroke="#e9edf3"/><text x="'+(left-8)+'" y="'+(gy+4)+'" text-anchor="end" fill="#98a2b3" font-size="11">'+label+'</text>'}
 data.forEach(function(row,index){const barWidth=Math.max(3,plotWidth/data.length-4),barHeight=eventHeight(row.events),cx=x(index);bars+='<rect x="'+(cx-barWidth/2)+'" y="'+(top+plotHeight-barHeight)+'" width="'+barWidth+'" height="'+barHeight+'" rx="2" fill="#dbeafe"><title>'+esc(row.day)+'：'+number(row.events)+' 个事件</title></rect>';if(number(row.active_installs)>0)dots+='<circle cx="'+cx+'" cy="'+y(row.active_installs)+'" r="3.5" fill="#2563eb" stroke="#fff" stroke-width="2"><title>'+esc(row.day)+'：'+number(row.active_installs)+' 个活跃设备，'+number(row.new_installs)+' 个首次出现</title></circle>'})
 const labels=[0,9,19,29].map(index=>'<text x="'+x(index)+'" y="'+(height-9)+'" text-anchor="'+(index===0?'start':index===29?'end':'middle')+'" fill="#98a2b3" font-size="11">'+esc(data[index].day.slice(5))+'</text>').join('')
 return '<div class="chart-wrap"><svg viewBox="0 0 '+width+' '+height+'" role="img" aria-label="近 30 天活跃设备与事件趋势">'+grid+bars+'<polygon points="'+area+'" fill="#eff6ff"/><polyline points="'+points+'" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'+dots+labels+'</svg></div>'
}
const platformLabels={windows:'Windows',macos:'macOS',linux:'Linux',web:'Web',unknown:'未知'}
const eventLabels={app_started:'应用启动',mode_changed:'功能模式切换',sidebar_tab_changed:'侧栏切换',graticule_changed:'经纬网设置',selection_changed:'下载范围选择',region_imported:'范围文件导入',bookmark_action:'范围书签操作',download_task_created:'创建下载任务',task_action:'下载任务操作',measurement_used:'地图量测',onboarding_event:'新手引导'}
const modeLabels={imagery:'GeoTIFF',dem:'DEM',wayback:'Wayback',tiles3d:'3D',vector:'OSM',mvt:'MVT'}
const sidebarLabels={download:'资源下载',history:'下载中心',settings:'设置'}
const graticuleEnabledLabels={'1':'启用','0':'关闭'}
const graticuleModeLabels={auto:'自动间隔',fixed:'固定间隔'}
const selectionMethodLabels={draw_rectangle:'绘制矩形',draw_polygon:'绘制多边形',admin:'行政区划',search:'地名搜索',import:'导入文件',bookmark:'范围书签'}
const geometryLabels={bounds:'矩形范围',polygon:'多边形范围'}
const importFormatLabels={geojson:'GeoJSON',shapefile:'Shapefile',kml:'KML',kmz:'KMZ',unknown:'其他'}
const importOutcomeLabels={success:'成功',no_area:'未识别到面',error:'失败'}
const bookmarkActionLabels={created:'保存',restored:'恢复',renamed:'重命名',deleted:'删除'}
const workflowLabels={raster:'影像 / DEM / MVT',wayback:'Wayback',osm:'OSM',tiles3d:'3D Tiles'}
const outputFormatLabels={geotiff:'GeoTIFF',png:'PNG',jpeg:'JPEG',tiles:'瓦片目录',mbtiles:'MBTiles',gpkg:'GeoPackage',pbf:'PBF',unknown:'不适用 / 其他'}
const taskActionLabels={pause_toggle:'暂停 / 继续',cancel:'取消',delete:'删除',resume:'恢复中断任务',discard:'丢弃记录',export_partial:'按现状导出'}
const measurementActionLabels={distance:'距离',area:'面积',clear:'清除结果'}
const onboardingTourLabels={main:'主界面',region:'区域与地图',download_center:'下载中心',imagery:'影像 / DEM',mvt:'MVT',osm:'OSM',tiles3d:'3D Tiles',wayback:'Wayback'}
const onboardingActionLabels={started:'开始',completed:'完成',dismissed:'中途关闭'}
function distribution(rows,labelKey,valueKey,color,labelMap){
 if(!rows.length)return '<div class="empty">暂无数据</div>'
 const max=Math.max(1,...rows.map(row=>number(row[valueKey])))
 return '<div class="distribution">'+rows.map(function(row){const value=number(row[valueKey]),label=labelMap?.[row[labelKey]]||row[labelKey];return '<div class="bar-row"><div class="bar-meta"><span>'+esc(label)+'</span><span class="bar-value">'+value+'</span></div><div class="bar-track"><div class="bar-fill" style="--bar:'+color+';width:'+Math.max(3,value/max*100).toFixed(1)+'%"></div></div></div>'}).join('')+'</div>'
}
function detailList(title,rows,labelMap,suffix){
 if(!rows?.length)return ''
 const max=Math.max(1,...rows.map(row=>number(row.count)))
 return '<div><div class="event-detail-title">'+esc(title)+'</div><div class="detail-list">'+rows.map(function(row){const value=String(row.value),label=labelMap?.[value]||value+(suffix||'');return '<div class="detail-row"><span>'+esc(label)+'</span><span class="detail-track"><i class="detail-fill" style="display:block;width:'+Math.max(4,number(row.count)/max*100).toFixed(1)+'%"></i></span><span class="bar-value">'+number(row.count)+'</span></div>'}).join('')+'</div></div>'
}
function eventDetail(event,details){
 if(event==='mode_changed')return detailList('功能模式',details.modes,modeLabels)
 if(event==='sidebar_tab_changed')return detailList('侧栏页面',details.sidebar_tabs,sidebarLabels)
 if(event==='graticule_changed')return detailList('显示状态',details.graticule_enabled,graticuleEnabledLabels)+detailList('间隔方式',details.graticule_modes,graticuleModeLabels)+detailList('固定间隔',details.graticule_intervals,null,'°')
 if(event==='selection_changed')return detailList('选择方式',details.selection_methods,selectionMethodLabels)+detailList('范围类型',details.selection_geometries,geometryLabels)+detailList('坐标点数量区间',details.selection_complexities)
 if(event==='region_imported')return detailList('文件格式',details.import_formats,importFormatLabels)+detailList('结果',details.import_outcomes,importOutcomeLabels)+detailList('面要素数量区间',details.import_feature_counts)
 if(event==='bookmark_action')return detailList('操作',details.bookmark_actions,bookmarkActionLabels)
 if(event==='download_task_created')return detailList('下载类型',details.task_workflows,workflowLabels)+detailList('输出格式',details.task_output_formats,outputFormatLabels)+detailList('缩放级别数量区间',details.task_zoom_counts)+detailList('范围类型',details.task_selections,geometryLabels)
 if(event==='task_action')return detailList('操作',details.task_actions,taskActionLabels)
 if(event==='measurement_used')return detailList('工具',details.measurement_actions,measurementActionLabels)
 if(event==='onboarding_event')return detailList('引导',details.onboarding_tours,onboardingTourLabels)+detailList('结果',details.onboarding_actions,onboardingActionLabels)
 return ''
}
function eventDistribution(rows,details){
 if(!rows.length)return '<div class="empty">暂无数据</div>'
 const max=Math.max(1,...rows.map(row=>number(row.count)))
 return '<div class="distribution">'+rows.map(function(row){const value=number(row.count),detail=eventDetail(row.event,details);return '<div class="event-group"><div class="bar-row"><div class="bar-meta"><span>'+esc(eventLabels[row.event]||row.event)+'</span><span class="bar-value">'+value+'</span></div><div class="bar-track"><div class="bar-fill" style="--bar:#d97706;width:'+Math.max(3,value/max*100).toFixed(1)+'%"></div></div></div>'+(detail?'<div class="event-details">'+detail+'</div>':'')+'</div>'}).join('')+'</div>'
}
function activity(lastActive){
 const age=Date.now()-new Date(lastActive).getTime()
 if(age<=24*60*60*1000)return ['24 小时','active']
 if(age<=7*24*60*60*1000)return ['近 7 日','recent']
 if(age<=30*24*60*60*1000)return ['近 30 日','quiet']
 return ['较早','']
}
function deviceTable(rows){
 if(!rows.length)return '<div class="empty">暂无设备数据</div>'
 return '<div class="table-scroll"><table><thead><tr><th>匿名设备</th><th>首次出现</th><th>最后活跃</th><th>状态</th><th>启动</th><th>会话</th><th>活跃天数</th><th>事件</th><th>版本</th><th>平台</th></tr></thead><tbody>'+rows.map(function(row){const state=activity(row.last_active);return '<tr><td class="device">'+esc(row.install_key)+'</td><td>'+esc(formatTime(row.first_seen))+'</td><td>'+esc(formatTime(row.last_active))+'</td><td><span class="badge '+state[1]+'">'+state[0]+'</span></td><td>'+number(row.launch_count)+'</td><td>'+number(row.session_count)+'</td><td>'+number(row.active_days)+'</td><td>'+number(row.event_count)+'</td><td>'+esc(row.current_version)+'</td><td>'+esc(platformLabels[row.platform]||row.platform)+'</td></tr>'}).join('')+'</tbody></table></div>'
}
async function load(){
 const token=tokenInput.value.trim();localStorage.setItem('geod_telemetry_admin_token',token)
 const content=document.getElementById('content');content.innerHTML='<div class="skeleton"></div>'
 try{
  const response=await fetch('stats',{headers:{authorization:'Bearer '+token}})
  if(!response.ok)throw new Error(response.status===401?'管理口令不正确':'载入失败：HTTP '+response.status)
  const data=await response.json(),t=data.totals
  document.getElementById('updated').textContent='更新时间：'+new Date(data.generated_at).toLocaleString()
  content.innerHTML='<div class="cards">'+
   [['匿名设备',t.installs,'去重安装实例','#2563eb'],['24 小时活跃',t.dau,'滚动时间窗','#059669'],['7 日活跃',t.wau,'最近 7 天','#0d9488'],['30 日活跃',t.mau,'最近 30 天','#7c3aed'],['累计事件',t.event_count,'已接收事件','#d97706']].map(x=>'<div class="card" style="--accent:'+x[3]+'"><div class="card-label">'+x[0]+'</div><div class="value">'+esc(x[1])+'</div><div class="card-note">'+x[2]+'</div></div>').join('')+
   '</div><div class="dashboard-grid"><section class="panel"><div class="panel-head"><div><h2>活跃趋势</h2><div class="panel-note">最近 30 天，缺失日期按 0 计</div></div><div class="legend"><span class="legend-item"><i class="legend-swatch" style="--swatch:#2563eb"></i>活跃设备</span><span class="legend-item"><i class="legend-swatch" style="--swatch:#dbeafe"></i>事件量</span></div></div>'+trendChart(data.daily)+'<details><summary>每日数据</summary>'+table(data.daily,[['日期','day'],['活跃设备','active_installs'],['首次出现','new_installs'],['事件数','events']])+'</details></section>'+
   '<div class="side-stack"><section class="panel"><div class="panel-head"><h2>版本分布</h2><span class="panel-note">匿名设备</span></div>'+distribution(data.versions,'version','installs','#2563eb')+'</section>'+
   '<section class="panel"><div class="panel-head"><h2>平台分布</h2><span class="panel-note">匿名设备</span></div>'+distribution(data.platforms,'platform','installs','#059669',platformLabels)+'</section>'+
   '<section class="panel"><div class="panel-head"><h2>功能使用</h2><span class="panel-note">事件次数</span></div>'+eventDistribution(data.events,data.event_details)+'</section></div>'+
   '<section class="panel full"><div class="panel-head"><div><h2>设备活跃明细</h2><div class="panel-note">首次出现为首次成功上报时间，不等同于系统安装时间</div></div><span class="panel-note">最多显示 200 个匿名设备</span></div>'+deviceTable(data.devices)+'</section></div>'
 }catch(error){content.innerHTML='<div class="error">'+esc(error.message)+'</div>'}
}
if(tokenInput.value)load()
</script></body></html>`)
}

export async function createTelemetryServer(options = {}) {
  const config = options.config || loadConfig()
  const wechatCallbackToken = config.wechatCallbackToken ||
    await readAdminToken(config.wechatCallbackTokenFile)
  const database = await createDatabase(config.databasePath)
  const checkRateLimit = createRateLimiter(config.rateLimitPerMinute)
  const writeWechatAudit = typeof options.wechatAudit === 'function'
    ? options.wechatAudit
    : (entry) => console.log(JSON.stringify({ type: 'wechat_callback', ...entry }))

  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    const url = new URL(request.url || '/', 'http://telemetry.local')
    const apiPath = url.pathname.replace(/^\/geod-telemetry/, '')
    if (apiPath === '/wechat/callback') {
      const auditStartedAt = Date.now()
      const audit = (entry) => {
        try {
          writeWechatAudit({
            at: new Date().toISOString(),
            method: ['GET', 'POST'].includes(request.method) ? request.method : 'OTHER',
            duration_ms: Date.now() - auditStartedAt,
            ...entry,
          })
        } catch {
          // Diagnostics must never interrupt the callback response.
        }
      }
      const timestamp = url.searchParams.get('timestamp') || ''
      const nonce = url.searchParams.get('nonce') || ''
      const signature = url.searchParams.get('signature') || ''
      if (!wechatCallbackToken) {
        audit({ stage: 'configuration', signature_valid: false, status: 503 })
        sendError(response, 503, 'wechat callback is not configured', 'wechat_callback_unavailable')
        return
      }
      if (!validWechatSignature(wechatCallbackToken, timestamp, nonce, signature)) {
        audit({ stage: 'signature', signature_valid: false, status: 403 })
        sendError(response, 403, 'invalid wechat signature', 'invalid_wechat_signature')
        return
      }
      if (request.method === 'GET') {
        audit({ stage: 'verification', signature_valid: true, status: 200 })
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        response.end(url.searchParams.get('echostr') || '')
        return
      }
      if (request.method !== 'POST') {
        audit({ stage: 'method', signature_valid: true, status: 405 })
        sendError(response, 405, 'method not allowed', 'method_not_allowed')
        return
      }
      try {
        const xml = await readTextBody(request, config.maxBodyBytes)
        const fromUser = xmlValue(xml, 'FromUserName')
        const toUser = xmlValue(xml, 'ToUserName')
        const messageType = xmlValue(xml, 'MsgType').toLowerCase()
        const event = xmlValue(xml, 'Event').toLowerCase()
        const normalizedContent = xmlValue(xml, 'Content').replaceAll('【', '').replaceAll('】', '').trim()
        const keywordMatched = messageType === 'text' && normalizedContent === '额度'
        let action = 'ignored'
        let reply = ''
        if (messageType === 'event' && event === 'subscribe') {
          await database.accounts.recordWechatFollow(fromUser, true)
          action = 'subscribe'
          reply = '欢迎关注老高 Vibe Coding！回复【额度】可领取微信创作工具箱 20 次额外导出额度。'
        } else if (messageType === 'event' && event === 'unsubscribe') {
          await database.accounts.recordWechatFollow(fromUser, false)
          action = 'unsubscribe'
        } else if (keywordMatched) {
          const issued = await database.accounts.issueFollowCode(fromUser)
          action = 'issue_follow_code'
          reply = `你的导出额度兑换码：${issued.code}\n15 分钟内有效，每个账户限领一次。`
        } else if (messageType === 'text') {
          action = 'fallback_reply'
          reply = '回复【额度】领取微信创作工具箱 20 次额外导出额度。'
        }
        const auditMessageType = ['text', 'event'].includes(messageType) ? messageType : 'other'
        const auditEvent = ['subscribe', 'unsubscribe'].includes(event) ? event : 'other'
        if (!reply) {
          audit({
            stage: 'processed',
            signature_valid: true,
            message_type: auditMessageType,
            event: auditEvent,
            keyword_match: keywordMatched,
            action,
            status: 200,
          })
          response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('success')
          return
        }
        audit({
          stage: 'processed',
          signature_valid: true,
          message_type: auditMessageType,
          event: auditEvent,
          keyword_match: keywordMatched,
          action,
          status: 200,
        })
        response.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' })
        response.end(wechatTextReply(fromUser, toUser, reply))
      } catch (error) {
        const errorName = /^[a-z0-9_.-]{1,64}$/i.test(String(error.name || ''))
          ? String(error.name)
          : 'Error'
        const errorCode = /^[a-z0-9_.-]{1,64}$/i.test(String(error.code || ''))
          ? String(error.code)
          : 'unknown'
        audit({
          stage: 'processing_error',
          signature_valid: true,
          status: error.status || 500,
          error_name: errorName,
          error_code: errorCode,
        })
        sendError(
          response,
          error.status || 500,
          error.status ? error.message : 'internal server error',
          error.code || 'internal_error',
        )
      }
      return
    }
    const accountPaths = new Set([
      '/v1/auth/register',
      '/v1/auth/login',
      '/v1/auth/me',
      '/v1/auth/logout',
      '/v1/quota',
      '/v1/quota/consume',
      '/v1/quota/redeem',
    ])
    const isAccountPath = accountPaths.has(apiPath)
    const accountOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : ''

    if (isAccountPath && PRODUCT_EVENT_ORIGINS.has(accountOrigin)) {
      setCors(response, accountOrigin)
    }
    if (request.method === 'OPTIONS' && isAccountPath) {
      if (!PRODUCT_EVENT_ORIGINS.has(accountOrigin)) {
        sendError(response, 403, 'origin is not allowed', 'origin_not_allowed')
        return
      }
      response.writeHead(204)
      response.end()
      return
    }
    if (isAccountPath) {
      if (!PRODUCT_EVENT_ORIGINS.has(accountOrigin)) {
        sendError(response, 403, 'origin is not allowed', 'origin_not_allowed')
        return
      }
      if (!checkRateLimit(requestAddress(request))) {
        sendError(response, 429, 'too many requests', 'rate_limit_exceeded')
        return
      }
      try {
        const token = bearerToken(request)
        let result
        let status = 200
        if (request.method === 'POST' && apiPath === '/v1/auth/register') {
          result = await database.accounts.register(await readJsonBody(request, config.maxBodyBytes))
          status = 201
        } else if (request.method === 'POST' && apiPath === '/v1/auth/login') {
          result = await database.accounts.login(await readJsonBody(request, config.maxBodyBytes))
        } else if (request.method === 'GET' && apiPath === '/v1/auth/me') {
          result = database.accounts.profile(token)
        } else if (request.method === 'POST' && apiPath === '/v1/auth/logout') {
          result = await database.accounts.logout(token)
        } else if (request.method === 'GET' && apiPath === '/v1/quota') {
          result = database.accounts.profile(token).quota
        } else if (request.method === 'POST' && apiPath === '/v1/quota/consume') {
          const body = await readJsonBody(request, config.maxBodyBytes)
          result = await database.accounts.consume(token, body.action_id)
        } else if (request.method === 'POST' && apiPath === '/v1/quota/redeem') {
          const body = await readJsonBody(request, config.maxBodyBytes)
          result = await database.accounts.redeem(token, body.code)
        } else {
          sendError(response, 405, 'method not allowed', 'method_not_allowed')
          return
        }
        sendJson(response, status, result)
      } catch (error) {
        sendError(
          response,
          error.status || 500,
          error.status ? error.message : 'internal server error',
          error.code || 'internal_error',
        )
      }
      return
    }

    if (
      request.method === 'GET' &&
      ['/health', '/geod-telemetry/health'].includes(url.pathname)
    ) {
      sendJson(response, 200, {
        status: 'ok',
        schema_version: 1,
        product_schema_version: 1,
        account_schema_version: 1,
        wechat_callback_configured: Boolean(wechatCallbackToken),
      })
      return
    }

    if (
      request.method === 'GET' &&
      ['/admin', '/admin/', '/geod-telemetry/admin', '/geod-telemetry/admin/'].includes(
        url.pathname,
      )
    ) {
      serveAdmin(response)
      return
    }

    if (
      request.method === 'GET' &&
      ['/admin/stats', '/geod-telemetry/admin/stats'].includes(url.pathname)
    ) {
      const token = await readAdminToken(config.adminTokenFile)
      if (!token || request.headers.authorization !== `Bearer ${token}`) {
        sendError(response, 401, 'unauthorized', 'unauthorized')
        return
      }
      sendJson(response, 200, database.stats())
      return
    }

    if (
      request.method === 'GET' &&
      ['/public/product-stats', '/geod-telemetry/public/product-stats'].includes(url.pathname)
    ) {
      setCors(response)
      sendJson(response, 200, database.productStats())
      return
    }

    if (
      request.method === 'GET' &&
      ['/admin/product-stats', '/geod-telemetry/admin/product-stats'].includes(url.pathname)
    ) {
      const token = await readAdminToken(config.adminTokenFile)
      if (!token || request.headers.authorization !== `Bearer ${token}`) {
        sendError(response, 401, 'unauthorized', 'unauthorized')
        return
      }
      sendJson(response, 200, database.productStats())
      return
    }

    const isEventsPath = ['/v1/events', '/geod-telemetry/v1/events'].includes(url.pathname)
    const isProductEventsPath = [
      '/v1/product-events',
      '/geod-telemetry/v1/product-events',
    ].includes(url.pathname)
    const productOrigin = typeof request.headers.origin === 'string'
      ? request.headers.origin
      : ''
    if (isEventsPath) setCors(response)
    if (isProductEventsPath && PRODUCT_EVENT_ORIGINS.has(productOrigin)) {
      setCors(response, productOrigin)
    }
    if (request.method === 'OPTIONS' && (isEventsPath || isProductEventsPath)) {
      if (isProductEventsPath && !PRODUCT_EVENT_ORIGINS.has(productOrigin)) {
        sendError(response, 403, 'origin is not allowed', 'origin_not_allowed')
        return
      }
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method !== 'POST' || (!isEventsPath && !isProductEventsPath)) {
      sendError(response, 404, 'not found', 'not_found')
      return
    }
    if (isProductEventsPath && !PRODUCT_EVENT_ORIGINS.has(productOrigin)) {
      sendError(response, 403, 'origin is not allowed', 'origin_not_allowed')
      return
    }
    if (!checkRateLimit(requestAddress(request))) {
      sendError(response, 429, 'too many requests', 'rate_limit_exceeded')
      return
    }

    try {
      const body = await readJsonBody(request, config.maxBodyBytes)
      const events = isProductEventsPath
        ? validateProductEnvelope(body)
        : validateEnvelope(body)
      const inserted = isProductEventsPath
        ? await database.insertProduct(events)
        : await database.insert(events)
      sendJson(response, 202, { accepted: events.length, inserted })
    } catch (error) {
      sendError(
        response,
        error.status || 500,
        error.status ? error.message : 'internal server error',
        error.code || 'internal_error',
      )
    }
  })

  server.on('close', () => database.close())
  return server
}

const launchedDirectly =
  typeof process !== 'undefined' &&
  process.argv?.[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (launchedDirectly) {
  const config = loadConfig()
  const server = await createTelemetryServer({ config })
  server.listen(config.port, config.host, () => {
    console.log(`GeoD telemetry listening on http://${config.host}:${config.port}`)
  })
}
