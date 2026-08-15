const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const PRODUCT_DEFINITIONS = {
  'wechat-dialog-generator': {
    events: new Set([
      'page_view',
      'dialog_created',
      'image_exported',
      'official_account_prompt_viewed',
      'official_account_id_copied',
    ]),
    funnel: ['page_view', 'dialog_created', 'image_exported'],
  },
  'geod-web': {
    events: new Set(['page_view', 'download_clicked']),
    funnel: ['page_view', 'download_clicked'],
  },
  'wallpaper-web': {
    events: new Set(['page_view', 'wallpaper_viewed', 'wallpaper_downloaded']),
    funnel: ['page_view', 'wallpaper_viewed', 'wallpaper_downloaded'],
  },
  'laogao-home': {
    events: new Set(['page_view', 'product_clicked']),
    funnel: ['page_view', 'product_clicked'],
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
  official_account_prompt_viewed: new Set(['placement']),
  official_account_id_copied: new Set(['placement']),
  download_clicked: new Set(['platform', 'version', 'channel']),
  wallpaper_viewed: new Set(['wallpaper_id', 'wallpaper_kind', 'media_type']),
  wallpaper_downloaded: new Set(['wallpaper_id', 'wallpaper_kind', 'media_type']),
  product_clicked: new Set(['product_id', 'placement']),
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

  if (eventName === 'wallpaper_viewed' || eventName === 'wallpaper_downloaded') {
    normalized.wallpaper_id = optionalString(
      properties.wallpaper_id,
      'wallpaper_id',
      64,
      /^[0-9A-Za-z_-]{1,64}$/,
    )
    if (!normalized.wallpaper_id) throw invalid('wallpaper_id is invalid')
    if (!['desktop', 'mobile'].includes(properties.wallpaper_kind)) {
      throw invalid('wallpaper_kind is invalid')
    }
    if (!['image', 'video'].includes(properties.media_type)) {
      throw invalid('media_type is invalid')
    }
    normalized.wallpaper_kind = properties.wallpaper_kind
    normalized.media_type = properties.media_type
  }

  if (eventName === 'official_account_prompt_viewed' || eventName === 'official_account_id_copied') {
    if (!['header', 'export'].includes(properties.placement)) {
      throw invalid('placement is invalid')
    }
    normalized.placement = properties.placement
  }

  if (eventName === 'product_clicked') {
    normalized.product_id = optionalString(
      properties.product_id,
      'product_id',
      64,
      /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/,
    )
    if (!normalized.product_id) throw invalid('product_id is invalid')
    if (!['featured', 'side-project', 'open-source', 'control-room', 'footer'].includes(properties.placement)) {
      throw invalid('placement is invalid')
    }
    normalized.placement = properties.placement
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

const CHANNEL_ORDER = [
  'google',
  'bing',
  'github',
  'wechat',
  'xiaohongshu',
  'bilibili',
  'juejin',
  'campaign',
  'direct',
  'other',
]

function acquisitionChannel(properties) {
  const source = String(properties.source || '').toLowerCase()
  const referrer = String(properties.referrer_host || '').toLowerCase()
  const value = `${source} ${referrer}`

  if (value.includes('google')) return 'google'
  if (value.includes('bing')) return 'bing'
  if (value.includes('github')) return 'github'
  if (/(weixin|wechat|mp\.weixin|weixin\.qq)/.test(value)) return 'wechat'
  if (/(xiaohongshu|xhslink|rednote)/.test(value)) return 'xiaohongshu'
  if (value.includes('bilibili')) return 'bilibili'
  if (value.includes('juejin')) return 'juejin'
  if (source) return 'campaign'
  if (!referrer || referrer === 'gaopengbin.github.io' || referrer === 'geodownloader.pages.dev') {
    return 'direct'
  }
  return 'other'
}

function acquisitionStats(database, product, funnel) {
  const rows = queryRows(
    database,
    `SELECT event_name, visitor_id, occurred_at, properties_json
     FROM product_events
     WHERE product = ?
     ORDER BY occurred_at`,
    [product],
  )
  const firstPageByVisitor = new Map()
  const eventVisitors = new Map(funnel.map((event) => [event, new Set()]))

  for (const row of rows) {
    if (eventVisitors.has(row.event_name)) {
      eventVisitors.get(row.event_name).add(row.visitor_id)
    }
    if (row.event_name !== 'page_view' || firstPageByVisitor.has(row.visitor_id)) continue
    let properties = {}
    try {
      properties = JSON.parse(row.properties_json)
    } catch {
      properties = {}
    }
    firstPageByVisitor.set(row.visitor_id, acquisitionChannel(properties))
  }

  const channels = new Map()
  for (const [visitor, channel] of firstPageByVisitor) {
    if (!channels.has(channel)) channels.set(channel, new Set())
    channels.get(channel).add(visitor)
  }

  return [...channels.entries()]
    .map(([channel, visitors]) => {
      const stages = funnel.map((event) => ({
        event,
        visitors: [...visitors].filter((visitor) => eventVisitors.get(event).has(visitor)).length,
      }))
      const finalVisitors = stages.at(-1)?.visitors || 0
      return {
        channel,
        visitors: visitors.size,
        stages,
        conversion_rate: visitors.size ? finalVisitors / visitors.size : 0,
      }
    })
    .sort((left, right) => (
      right.visitors - left.visitors ||
      CHANNEL_ORDER.indexOf(left.channel) - CHANNEL_ORDER.indexOf(right.channel)
    ))
}

function landingPageStats(database, product, funnel) {
  const rows = queryRows(
    database,
    `SELECT event_name, visitor_id, occurred_at, properties_json
     FROM product_events
     WHERE product = ?
     ORDER BY occurred_at`,
    [product],
  )
  const firstPathByVisitor = new Map()
  const eventVisitors = new Map(funnel.map((event) => [event, new Set()]))

  for (const row of rows) {
    if (eventVisitors.has(row.event_name)) {
      eventVisitors.get(row.event_name).add(row.visitor_id)
    }
    if (row.event_name !== 'page_view' || firstPathByVisitor.has(row.visitor_id)) continue
    let properties = {}
    try {
      properties = JSON.parse(row.properties_json)
    } catch {
      properties = {}
    }
    const path = typeof properties.path === 'string' && properties.path.startsWith('/')
      ? properties.path
      : '/'
    firstPathByVisitor.set(row.visitor_id, path)
  }

  const paths = new Map()
  for (const [visitor, path] of firstPathByVisitor) {
    if (!paths.has(path)) paths.set(path, new Set())
    paths.get(path).add(visitor)
  }

  return [...paths.entries()]
    .map(([path, visitors]) => {
      const stages = funnel.map((event) => ({
        event,
        visitors: [...visitors].filter((visitor) => eventVisitors.get(event).has(visitor)).length,
      }))
      const finalVisitors = stages.at(-1)?.visitors || 0
      return {
        path,
        visitors: visitors.size,
        stages,
        conversion_rate: visitors.size ? finalVisitors / visitors.size : 0,
      }
    })
    .sort((left, right) => right.visitors - left.visitors || left.path.localeCompare(right.path))
    .slice(0, 20)
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
      acquisition: acquisitionStats(database, product, definition.funnel),
      landing_pages: landingPageStats(database, product, definition.funnel),
    }
  })
  return { generated_at: new Date().toISOString(), products }
}
