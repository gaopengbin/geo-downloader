import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import initSqlJs from 'sql.js'

const SERVICE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/
const EVENT_NAMES = new Set([
  'app_started',
  'mode_changed',
  'sidebar_tab_changed',
  'graticule_changed',
])
const PLATFORMS = new Set(['windows', 'macos', 'linux', 'web', 'unknown'])
const MODES = new Set(['imagery', 'dem', 'wayback', 'tiles3d', 'vector', 'mvt'])
const SIDEBAR_TABS = new Set(['download', 'history', 'settings'])

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
    maxBodyBytes: envInteger(env.MAX_BODY_BYTES, 131072, 1024, 1024 * 1024),
    rateLimitPerMinute: envInteger(env.RATE_LIMIT_PER_MINUTE, 120, 10, 5000),
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

  if (
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

function setCors(response) {
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader('access-control-allow-headers', 'content-type')
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS')
  response.setHeader('access-control-max-age', '86400')
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

async function createDatabase(databasePath) {
  const wasmPath = fileURLToPath(import.meta.resolve('sql.js/dist/sql-wasm.wasm'))
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

  await mkdir(path.dirname(databasePath), { recursive: true })
  let writeChain = Promise.resolve()

  async function persist() {
    const temporaryPath = `${databasePath}.tmp`
    await writeFile(temporaryPath, Buffer.from(database.export()))
    await rename(temporaryPath, databasePath)
  }

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

  return {
    insert(events) {
      const operation = writeChain.then(() => insert(events))
      writeChain = operation.catch(() => {})
      return operation
    },
    stats() {
      const totals = queryRows(
        database,
        `SELECT
          COUNT(*) AS event_count,
          COUNT(DISTINCT install_id) AS installs,
          COUNT(DISTINCT CASE WHEN event_day >= date('now', '-0 day') THEN install_id END) AS dau,
          COUNT(DISTINCT CASE WHEN event_day >= date('now', '-29 day') THEN install_id END) AS mau
        FROM events`,
      )[0]
      return {
        generated_at: new Date().toISOString(),
        totals,
        daily: queryRows(
          database,
          `SELECT event_day AS day, COUNT(DISTINCT install_id) AS active_installs,
             COUNT(*) AS events
           FROM events
           WHERE event_day >= date('now', '-29 day')
           GROUP BY event_day ORDER BY event_day`,
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
*{box-sizing:border-box}body{margin:0;background:#f5f7fb;color:#172033;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 20px 60px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
h1{margin:0;font-size:24px}.muted{color:#667085}.login{display:flex;gap:8px}input,button{height:38px;border:1px solid #d0d5dd;border-radius:6px;padding:0 12px;background:#fff}
button{cursor:pointer;background:#2563eb;color:#fff;border-color:#2563eb;font-weight:600}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
.card,.panel{background:#fff;border:1px solid #e4e7ec;border-radius:8px}.card{padding:18px}.value{font-size:28px;font-weight:700;margin-top:4px}
.grid{display:grid;grid-template-columns:2fr 1fr;gap:16px}.panel{padding:18px;margin-bottom:16px}h2{font-size:16px;margin:0 0 14px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #eef0f3;padding:8px 4px}th{color:#667085;font-weight:500}
.error{color:#b42318}@media(max-width:720px){.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}header{align-items:flex-start;gap:16px;flex-direction:column}}
</style>
</head>
<body><main>
<header><div><h1>GeoD 匿名使用统计</h1><div class="muted" id="updated">等待载入</div></div>
<div class="login"><input id="token" type="password" placeholder="管理口令"><button id="load">查看统计</button></div></header>
<div id="content"></div>
</main><script>
const tokenInput=document.getElementById('token')
tokenInput.value=localStorage.getItem('geod_telemetry_admin_token')||''
document.getElementById('load').onclick=load
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function table(rows,columns){return '<table><thead><tr>'+columns.map(c=>'<th>'+esc(c[0])+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+columns.map(c=>'<td>'+esc(row[c[1]])+'</td>').join('')+'</tr>').join('')+'</tbody></table>'}
async function load(){
 const token=tokenInput.value.trim();localStorage.setItem('geod_telemetry_admin_token',token)
 const content=document.getElementById('content');content.innerHTML='<div class="muted">载入中...</div>'
 try{
  const response=await fetch('stats',{headers:{authorization:'Bearer '+token}})
  if(!response.ok)throw new Error(response.status===401?'管理口令不正确':'载入失败：HTTP '+response.status)
  const data=await response.json(),t=data.totals
  document.getElementById('updated').textContent='更新时间：'+new Date(data.generated_at).toLocaleString()
  content.innerHTML='<div class="cards">'+
   [['累计安装',t.installs],['今日活跃',t.dau],['30 日活跃',t.mau],['累计事件',t.event_count]].map(x=>'<div class="card"><div class="muted">'+x[0]+'</div><div class="value">'+esc(x[1])+'</div></div>').join('')+
   '</div><div class="grid"><div><section class="panel"><h2>近 30 天活跃</h2>'+table(data.daily,[['日期','day'],['活跃安装','active_installs'],['事件数','events']])+'</section></div>'+
   '<div><section class="panel"><h2>版本分布</h2>'+table(data.versions,[['版本','version'],['安装','installs']])+'</section>'+
   '<section class="panel"><h2>平台分布</h2>'+table(data.platforms,[['平台','platform'],['安装','installs']])+'</section>'+
   '<section class="panel"><h2>功能事件</h2>'+table(data.events,[['事件','event'],['次数','count']])+'</section></div></div>'
 }catch(error){content.innerHTML='<div class="error">'+esc(error.message)+'</div>'}
}
if(tokenInput.value)load()
</script></body></html>`)
}

export async function createTelemetryServer(options = {}) {
  const config = options.config || loadConfig()
  const database = await createDatabase(config.databasePath)
  const checkRateLimit = createRateLimiter(config.rateLimitPerMinute)

  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    const url = new URL(request.url || '/', 'http://telemetry.local')

    if (
      request.method === 'GET' &&
      ['/health', '/geod-telemetry/health'].includes(url.pathname)
    ) {
      sendJson(response, 200, { status: 'ok', schema_version: 1 })
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

    const isEventsPath = ['/v1/events', '/geod-telemetry/v1/events'].includes(url.pathname)
    if (isEventsPath) setCors(response)
    if (request.method === 'OPTIONS' && isEventsPath) {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.method !== 'POST' || !isEventsPath) {
      sendError(response, 404, 'not found', 'not_found')
      return
    }
    if (!checkRateLimit(requestAddress(request))) {
      sendError(response, 429, 'too many requests', 'rate_limit_exceeded')
      return
    }

    try {
      const events = validateEnvelope(await readJsonBody(request, config.maxBodyBytes))
      const inserted = await database.insert(events)
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
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (launchedDirectly) {
  const config = loadConfig()
  const server = await createTelemetryServer({ config })
  server.listen(config.port, config.host, () => {
    console.log(`GeoD telemetry listening on http://${config.host}:${config.port}`)
  })
}
