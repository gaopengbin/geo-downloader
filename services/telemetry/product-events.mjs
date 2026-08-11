const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const PRODUCT_DEFINITIONS = {
  'wechat-dialog-generator': {
    events: new Set(['page_view', 'dialog_created', 'image_exported']),
    funnel: ['page_view', 'dialog_created', 'image_exported'],
  },
  'geod-web': {
    events: new Set(['page_view', 'download_clicked']),
    funnel: ['page_view', 'download_clicked'],
  },
}

const COMMON_PROPERTIES = new Set([
  'path',
  'referrer_host',
  'source',
  'medium',
  'campaign',
])

const EVENT_PROPERTIES = {
  page_view: new Set(),
  dialog_created: new Set(['message_count_bucket', 'participant_count_bucket']),
  image_exported: new Set(['capture_mode', 'message_count_bucket']),
  download_clicked: new Set(['platform', 'version', 'channel']),
}

function invalid(message) {
  const error = new Error(message)
  error.status = 400
  error.code = 'invalid_product_event'
  return error
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function optionalString(value, name, maximum, pattern) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximum || (pattern && !pattern.test(value))) {
    throw invalid(`${name} is invalid`)
  }
  return value
}

function validateProperties(eventName, properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw invalid('properties must be an object')
  }
  const allowed = new Set([...COMMON_PROPERTIES, ...EVENT_PROPERTIES[eventName]])
  if (Object.keys(properties).some((key) => !allowed.has(key))) {
    throw invalid(`${eventName} properties are invalid`)
  }

  const normalized = {}
  for (const [key, maximum] of [
    ['path', 256],
    ['referrer_host', 128],
    ['source', 64],
    ['medium', 64],
    ['campaign', 96],
  ]) {
    const value = optionalString(properties[key], key, maximum)
    if (value !== undefined) normalized[key] = value
  }

  if (eventName === 'dialog_created') {
    if (!['1-5', '6-20', '21-50', '51+'].includes(properties.message_count_bucket)) {
      throw invalid('message_count_bucket is invalid')
    }
    if (!['1', '2', '3-5', '6+'].includes(properties.participant_count_bucket)) {
      throw invalid('participant_count_bucket is invalid')
    }
    normalized.message_count_bucket = properties.message_count_bucket
    normalized.participant_count_bucket = properties.participant_count_bucket
  }

  if (eventName === 'image_exported') {
    if (!['standard', 'long', 'clipboard'].includes(properties.capture_mode)) {
      throw invalid('capture_mode is invalid')
    }
    if (!['1-5', '6-20', '21-50', '51+'].includes(properties.message_count_bucket)) {
      throw invalid('message_count_bucket is invalid')
    }
    normalized.capture_mode = properties.capture_mode
    normalized.message_count_bucket = properties.message_count_bucket
  }

  if (eventName === 'download_clicked') {
    if (!['windows', 'macos-arm64', 'macos-x64', 'linux-deb', 'linux-appimage'].includes(properties.platform)) {
      throw invalid('platform is invalid')
    }
    if (!['github', 'mirror'].includes(properties.channel)) {
      throw invalid('channel is invalid')
    }
    normalized.platform = properties.platform
    normalized.channel = properties.channel
    normalized.version = optionalString(
      properties.version,
      'version',
      32,
      /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/,
    )
  }

  return normalized
}

export function validateProductEnvelope(body, now = Date.now()) {
  if (!exactKeys(body, ['events', 'product', 'schema_version'])) {
    throw invalid('request fields are invalid')
  }
  if (body.schema_version !== 1) throw invalid('schema_version is not supported')
  const definition = PRODUCT_DEFINITIONS[body.product]
  if (!definition) throw invalid('product is not supported')
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > 50) {
    throw invalid('events must contain between 1 and 50 items')
  }

  return body.events.map((event) => {
    if (!exactKeys(event, [
      'event',
      'event_id',
      'occurred_at',
      'properties',
      'session_id',
      'visitor_id',
    ])) {
      throw invalid('event fields are invalid')
    }
    if (!UUID_PATTERN.test(event.event_id)) throw invalid('event_id is invalid')
    if (!UUID_PATTERN.test(event.visitor_id)) throw invalid('visitor_id is invalid')
    if (!UUID_PATTERN.test(event.session_id)) throw invalid('session_id is invalid')
    if (!definition.events.has(event.event)) throw invalid('event name is not allowed')

    const occurredAt = new Date(event.occurred_at)
    if (
      Number.isNaN(occurredAt.getTime()) ||
      occurredAt.getTime() > now + 24 * 60 * 60 * 1000 ||
      occurredAt.getTime() < now - 90 * 24 * 60 * 60 * 1000
    ) {
      throw invalid('occurred_at is outside the accepted range')
    }

    return {
      eventId: event.event_id,
      product: body.product,
      eventName: event.event,
      occurredAt: occurredAt.toISOString(),
      eventDay: occurredAt.toISOString().slice(0, 10),
      visitorId: event.visitor_id,
      sessionId: event.session_id,
      properties: validateProperties(event.event, event.properties),
    }
  })
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

export function initializeProductEvents(database) {
  database.run(`
    CREATE TABLE IF NOT EXISTS product_events (
      event_id TEXT PRIMARY KEY,
      product TEXT NOT NULL,
      event_name TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      event_day TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      properties_json TEXT NOT NULL,
      received_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS product_events_product_day_idx
      ON product_events(product, event_day);
    CREATE INDEX IF NOT EXISTS product_events_product_visitor_idx
      ON product_events(product, visitor_id);
    CREATE INDEX IF NOT EXISTS product_events_product_name_idx
      ON product_events(product, event_name);
  `)
}

export function insertProductEvents(database, events) {
  let inserted = 0
  database.run('BEGIN TRANSACTION')
  try {
    const statement = database.prepare(`
      INSERT OR IGNORE INTO product_events (
        event_id, product, event_name, occurred_at, event_day,
        visitor_id, session_id, properties_json, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    try {
      const receivedAt = new Date().toISOString()
      for (const event of events) {
        statement.run([
          event.eventId,
          event.product,
          event.eventName,
          event.occurredAt,
          event.eventDay,
          event.visitorId,
          event.sessionId,
          JSON.stringify(event.properties),
          receivedAt,
        ])
        inserted += database.getRowsModified()
      }
    } finally {
      statement.free()
    }
    database.run('COMMIT')
    return inserted
  } catch (error) {
    database.run('ROLLBACK')
    throw error
  }
}

export function productStats(database) {
  const products = Object.entries(PRODUCT_DEFINITIONS).map(([product, definition]) => {
    const totals = queryRows(
      database,
      `SELECT COUNT(*) AS event_count,
        COUNT(DISTINCT visitor_id) AS visitors,
        COUNT(DISTINCT session_id) AS sessions
       FROM product_events WHERE product = ?`,
      [product],
    )[0]
    const stages = definition.funnel.map((event) => {
      const row = queryRows(
        database,
        `SELECT COUNT(*) AS events, COUNT(DISTINCT visitor_id) AS visitors
         FROM product_events WHERE product = ? AND event_name = ?`,
        [product, event],
      )[0]
      return { event, events: row.events, visitors: row.visitors }
    })
    return {
      product,
      ...totals,
      funnel: stages.map((stage, index) => ({
        ...stage,
        conversion_rate: index === 0 || !stages[index - 1].visitors
          ? null
          : stage.visitors / stages[index - 1].visitors,
      })),
      events: queryRows(
        database,
        `SELECT event_name AS event, COUNT(*) AS count,
          COUNT(DISTINCT visitor_id) AS visitors
         FROM product_events WHERE product = ?
         GROUP BY event_name ORDER BY count DESC`,
        [product],
      ),
      daily: queryRows(
        database,
        `SELECT event_day AS day, COUNT(*) AS events,
          COUNT(DISTINCT visitor_id) AS visitors,
          COUNT(DISTINCT session_id) AS sessions
         FROM product_events
         WHERE product = ? AND event_day >= date('now', '-29 day')
         GROUP BY event_day ORDER BY event_day`,
        [product],
      ),
    }
  })
  return { generated_at: new Date().toISOString(), products }
}
