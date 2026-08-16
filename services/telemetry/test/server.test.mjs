import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { createTelemetryServer, replaceDatabaseFile, validateEnvelope } from '../server.mjs'
import { validateProductEnvelope } from '../product-events.mjs'

const cleanup = []

function wechatSignature(token, timestamp, nonce) {
  return createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
}

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

test('falls back to a recoverable copy when Windows rejects database replacement', async () => {
  const calls = []
  const windowsError = new Error('replacement denied')
  windowsError.code = 'EPERM'
  const replacement = Buffer.from('new database')
  const operations = {
    rename: async (source, destination) => {
      calls.push(['rename', source, destination])
      throw windowsError
    },
    copyFile: async (source, destination) => {
      calls.push(['copyFile', source, destination])
    },
    readFile: async (source) => {
      calls.push(['readFile', source])
      return replacement
    },
    writeFile: async (destination, contents) => {
      calls.push(['writeFile', destination, contents])
    },
    rm: async (target, options) => {
      calls.push(['rm', target, options])
    },
  }

  await replaceDatabaseFile('events.sqlite.tmp', 'events.sqlite', operations)

  assert.deepEqual(calls, [
    ['rename', 'events.sqlite.tmp', 'events.sqlite'],
    ['copyFile', 'events.sqlite', 'events.sqlite.bak'],
    ['readFile', 'events.sqlite.tmp'],
    ['writeFile', 'events.sqlite', replacement],
    ['rm', 'events.sqlite.tmp', { force: true }],
    ['rm', 'events.sqlite.bak', { force: true }],
  ])
})

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

test('validates product events without accepting content fields', () => {
  const eventId = crypto.randomUUID()
  const visitorId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const [normalized] = validateProductEnvelope({
    schema_version: 1,
    product: 'wechat-dialog-generator',
    events: [{
      event_id: eventId,
      event: 'dialog_created',
      occurred_at: new Date().toISOString(),
      visitor_id: visitorId,
      session_id: sessionId,
      properties: {
        message_count_bucket: '6-20',
        participant_count_bucket: '2',
        path: '/wechat-dialog-generator/',
        source: 'google',
      },
    }],
  })
  assert.equal(normalized.product, 'wechat-dialog-generator')
  assert.equal(normalized.eventName, 'dialog_created')
  assert.equal(normalized.properties.message_count_bucket, '6-20')
  assert.throws(
    () => validateProductEnvelope({
      schema_version: 1,
      product: 'wechat-dialog-generator',
      events: [{
        event_id: crypto.randomUUID(),
        event: 'dialog_created',
        occurred_at: new Date().toISOString(),
        visitor_id: visitorId,
        session_id: sessionId,
        properties: {
          message_count_bucket: '6-20',
          participant_count_bucket: '2',
          content: 'private chat text',
        },
      }],
    }),
    /properties are invalid/,
  )
})

test('validates wallpaper events without collecting search text', () => {
  const visitorId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const [normalized] = validateProductEnvelope({
    schema_version: 1,
    product: 'wallpaper-web',
    events: [{
      event_id: crypto.randomUUID(),
      event: 'wallpaper_viewed',
      occurred_at: new Date().toISOString(),
      visitor_id: visitorId,
      session_id: sessionId,
      properties: {
        path: '/detail/12345',
        wallpaper_id: '12345',
        wallpaper_kind: 'desktop',
        media_type: 'image',
      },
    }],
  })
  assert.equal(normalized.product, 'wallpaper-web')
  assert.equal(normalized.properties.wallpaper_id, '12345')
  assert.throws(
    () => validateProductEnvelope({
      schema_version: 1,
      product: 'wallpaper-web',
      events: [{
        event_id: crypto.randomUUID(),
        event: 'wallpaper_viewed',
        occurred_at: new Date().toISOString(),
        visitor_id: visitorId,
        session_id: sessionId,
        properties: {
          wallpaper_id: '12345',
          wallpaper_kind: 'desktop',
          media_type: 'image',
          search_query: 'private input',
        },
      }],
    }),
    /properties are invalid/,
  )
})

test('validates official account growth events with bounded placement', () => {
  const visitorId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const [normalized] = validateProductEnvelope({
    schema_version: 1,
    product: 'wechat-dialog-generator',
    events: [{
      event_id: crypto.randomUUID(),
      event: 'official_account_prompt_viewed',
      occurred_at: new Date().toISOString(),
      visitor_id: visitorId,
      session_id: sessionId,
      properties: { placement: 'export' },
    }],
  })
  assert.equal(normalized.eventName, 'official_account_prompt_viewed')
  assert.equal(normalized.properties.placement, 'export')

  assert.throws(() => validateProductEnvelope({
    schema_version: 1,
    product: 'wechat-dialog-generator',
    events: [{
      event_id: crypto.randomUUID(),
      event: 'official_account_id_copied',
      occurred_at: new Date().toISOString(),
      visitor_id: visitorId,
      session_id: sessionId,
      properties: { placement: 'popup-ad' },
    }],
  }), /placement is invalid/)
})

test('validates product hub clicks without accepting destination URLs', () => {
  const visitorId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const [normalized] = validateProductEnvelope({
    schema_version: 1,
    product: 'laogao-home',
    events: [{
      event_id: crypto.randomUUID(),
      event: 'product_clicked',
      occurred_at: new Date().toISOString(),
      visitor_id: visitorId,
      session_id: sessionId,
      properties: {
        path: '/',
        product_id: 'wechat-dialog',
        placement: 'featured',
      },
    }],
  })
  assert.equal(normalized.product, 'laogao-home')
  assert.equal(normalized.properties.product_id, 'wechat-dialog')
  assert.equal(normalized.properties.placement, 'featured')
  assert.throws(
    () => validateProductEnvelope({
      schema_version: 1,
      product: 'laogao-home',
      events: [{
        event_id: crypto.randomUUID(),
        event: 'product_clicked',
        occurred_at: new Date().toISOString(),
        visitor_id: visitorId,
        session_id: sessionId,
        properties: {
          product_id: 'wechat-dialog',
          placement: 'featured',
          destination_url: 'https://example.com/private',
        },
      }],
    }),
    /properties are invalid/,
  )
})

test('accepts expanded product events and rejects sensitive extra fields', () => {
  const examples = [
    event({ event: 'selection_changed', properties: { method: 'import', geometry: 'polygon', complexity: '11-100' } }),
    event({ event: 'region_imported', properties: { format: 'kml', outcome: 'success', feature_count: '2-10' } }),
    event({ event: 'bookmark_action', properties: { action: 'created' } }),
    event({ event: 'download_task_created', properties: { workflow: 'raster', output_format: 'geotiff', zoom_count: '2-10', selection: 'polygon' } }),
    event({ event: 'task_action', properties: { action: 'pause_toggle' } }),
    event({ event: 'measurement_used', properties: { action: 'distance' } }),
    event({ event: 'onboarding_event', properties: { tour: 'region', action: 'completed' } }),
  ]
  assert.equal(validateEnvelope({ schema_version: 1, events: examples }).length, examples.length)

  assert.throws(
    () => validateEnvelope({
      schema_version: 1,
      events: [event({
        event: 'download_task_created',
        properties: {
          workflow: 'raster', output_format: 'geotiff', zoom_count: '1', selection: 'bounds',
          save_path: 'C:/private/data',
        },
      })],
    }),
    /properties are invalid/,
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
  const installId = crypto.randomUUID()
  const eventDay = new Date().toISOString().slice(0, 10)
  const firstSeen = `${eventDay}T00:00:01.000Z`
  const lastActive = `${eventDay}T00:00:02.000Z`
  const payloadEvent = event({ install_id: installId, occurred_at: firstSeen })
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

  const activity = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_version: 1,
      events: [
        event({
          event: 'mode_changed',
          occurred_at: lastActive,
          install_id: installId,
          app_version: '3.6.7',
          properties: { mode: 'imagery' },
        }),
        event({
          event: 'download_task_created',
          occurred_at: lastActive,
          install_id: installId,
          app_version: '3.6.7',
          properties: {
            workflow: 'raster',
            output_format: 'geotiff',
            zoom_count: '2-10',
            selection: 'polygon',
          },
        }),
      ],
    }),
  })
  assert.equal(activity.status, 202)
  assert.deepEqual(await activity.json(), { accepted: 2, inserted: 2 })

  const unauthorized = await fetch(`${baseUrl}/admin/stats`)
  assert.equal(unauthorized.status, 401)

  const statsResponse = await fetch(`${baseUrl}/admin/stats`, {
    headers: { authorization: 'Bearer test-token' },
  })
  assert.equal(statsResponse.status, 200)
  const stats = await statsResponse.json()
  assert.equal(stats.totals.installs, 1)
  assert.equal(stats.totals.wau, 1)
  assert.equal(stats.totals.event_count, 3)
  assert.deepEqual(stats.platforms, [{ platform: 'windows', installs: 1 }])
  assert.deepEqual(stats.event_details.modes, [{ value: 'imagery', count: 1 }])
  assert.deepEqual(stats.event_details.sidebar_tabs, [])
  assert.deepEqual(stats.event_details.graticule_enabled, [])
  assert.deepEqual(stats.event_details.task_workflows, [{ value: 'raster', count: 1 }])
  assert.deepEqual(stats.event_details.task_output_formats, [{ value: 'geotiff', count: 1 }])
  assert.equal(
    stats.daily.reduce((total, row) => total + row.new_installs, 0),
    1,
  )
  assert.deepEqual(stats.devices, [
    {
      install_key: installId.slice(0, 8),
      first_seen: firstSeen,
      last_active: lastActive,
      event_count: 3,
      session_count: 3,
      active_days: 1,
      launch_count: 1,
      current_version: '3.6.7',
      platform: 'windows',
    },
  ])


  const productVisitorId = crypto.randomUUID()
  const productSessionId = crypto.randomUUID()
  const productEvents = [
    {
      event_id: crypto.randomUUID(),
      event: 'page_view',
      occurred_at: new Date().toISOString(),
      visitor_id: productVisitorId,
      session_id: productSessionId,
      properties: { path: '/', referrer_host: 'www.google.com' },
    },
    {
      event_id: crypto.randomUUID(),
      event: 'dialog_created',
      occurred_at: new Date().toISOString(),
      visitor_id: productVisitorId,
      session_id: productSessionId,
      properties: {
        path: '/',
        message_count_bucket: '6-20',
        participant_count_bucket: '2',
      },
    },
    {
      event_id: crypto.randomUUID(),
      event: 'image_exported',
      occurred_at: new Date().toISOString(),
      visitor_id: productVisitorId,
      session_id: productSessionId,
      properties: {
        path: '/',
        capture_mode: 'standard',
        message_count_bucket: '6-20',
      },
    },
  ]
  const productResponse = await fetch(`${baseUrl}/geod-telemetry/v1/product-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://chat.laogao.xyz',
    },
    body: JSON.stringify({
      schema_version: 1,
      product: 'wechat-dialog-generator',
      events: productEvents,
    }),
  })
  assert.equal(productResponse.status, 202)
  assert.deepEqual(await productResponse.json(), { accepted: 3, inserted: 3 })
  assert.equal(
    productResponse.headers.get('access-control-allow-origin'),
    'https://chat.laogao.xyz',
  )

  const wallpaperVisitorId = crypto.randomUUID()
  const wallpaperSessionId = crypto.randomUUID()
  const wallpaperResponse = await fetch(`${baseUrl}/v1/product-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://wallpaper.gpb.cc',
    },
    body: JSON.stringify({
      schema_version: 1,
      product: 'wallpaper-web',
      events: ['page_view', 'wallpaper_viewed', 'wallpaper_downloaded'].map((event) => ({
        event_id: crypto.randomUUID(),
        event,
        occurred_at: new Date().toISOString(),
        visitor_id: wallpaperVisitorId,
        session_id: wallpaperSessionId,
        properties: event === 'page_view'
          ? { path: '/' }
          : {
              path: '/detail/12345',
              wallpaper_id: '12345',
              wallpaper_kind: 'desktop',
              media_type: 'image',
            },
      })),
    }),
  })
  assert.equal(wallpaperResponse.status, 202)
  assert.deepEqual(await wallpaperResponse.json(), { accepted: 3, inserted: 3 })
  assert.equal(
    wallpaperResponse.headers.get('access-control-allow-origin'),
    'https://wallpaper.gpb.cc',
  )

  const homeVisitorId = crypto.randomUUID()
  const homeSessionId = crypto.randomUUID()
  const homeResponse = await fetch(`${baseUrl}/v1/product-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://laogao.xyz',
    },
    body: JSON.stringify({
      schema_version: 1,
      product: 'laogao-home',
      events: ['page_view', 'product_clicked'].map((event) => ({
        event_id: crypto.randomUUID(),
        event,
        occurred_at: new Date().toISOString(),
        visitor_id: homeVisitorId,
        session_id: homeSessionId,
        properties: event === 'page_view'
          ? { path: '/' }
          : { path: '/', product_id: 'geod', placement: 'featured' },
      })),
    }),
  })
  assert.equal(homeResponse.status, 202)
  assert.deepEqual(await homeResponse.json(), { accepted: 2, inserted: 2 })
  assert.equal(homeResponse.headers.get('access-control-allow-origin'), 'https://laogao.xyz')

  const productPreflight = await fetch(`${baseUrl}/v1/product-events`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://chat.laogao.xyz',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  assert.equal(productPreflight.status, 204)
  assert.equal(
    productPreflight.headers.get('access-control-allow-origin'),
    'https://chat.laogao.xyz',
  )

  const rejectedOrigin = await fetch(`${baseUrl}/v1/product-events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://example.com',
    },
    body: JSON.stringify({
      schema_version: 1,
      product: 'wechat-dialog-generator',
      events: productEvents,
    }),
  })
  assert.equal(rejectedOrigin.status, 403)

  const productStatsResponse = await fetch(`${baseUrl}/admin/product-stats`, {
    headers: { authorization: 'Bearer test-token' },
  })
  assert.equal(productStatsResponse.status, 200)
  const productStats = await productStatsResponse.json()
  const wechat = productStats.products.find(
    (item) => item.product === 'wechat-dialog-generator',
  )
  assert.equal(wechat.visitors, 1)
  assert.equal(wechat.funnel[0].event, 'page_view')
  assert.equal(wechat.funnel[0].visitors, 1)
  assert.equal(wechat.funnel[2].event, 'image_exported')
  assert.equal(wechat.funnel[2].conversion_rate, 1)
  assert.deepEqual(wechat.acquisition, [{
    channel: 'google',
    visitors: 1,
    stages: [
      { event: 'page_view', visitors: 1 },
      { event: 'dialog_created', visitors: 1 },
      { event: 'image_exported', visitors: 1 },
    ],
    conversion_rate: 1,
  }])
  assert.deepEqual(wechat.landing_pages, [{
    path: '/',
    visitors: 1,
    stages: [
      { event: 'page_view', visitors: 1 },
      { event: 'dialog_created', visitors: 1 },
      { event: 'image_exported', visitors: 1 },
    ],
    conversion_rate: 1,
  }])
  const wallpaper = productStats.products.find((item) => item.product === 'wallpaper-web')
  assert.equal(wallpaper.visitors, 1)
  assert.equal(wallpaper.funnel[2].event, 'wallpaper_downloaded')
  assert.equal(wallpaper.funnel[2].conversion_rate, 1)
  const home = productStats.products.find((item) => item.product === 'laogao-home')
  assert.equal(home.visitors, 1)
  assert.equal(home.funnel[1].event, 'product_clicked')
  assert.equal(home.funnel[1].conversion_rate, 1)

  const publicStatsResponse = await fetch(`${baseUrl}/geod-telemetry/public/product-stats`)
  assert.equal(publicStatsResponse.status, 200)
  assert.equal(publicStatsResponse.headers.get('access-control-allow-origin'), '*')
  const publicStats = await publicStatsResponse.json()
  assert.equal(publicStats.products[0].visitors, 1)
})

test('supports account sessions, daily export quota, and one-time follow rewards', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wechat-account-'))
  const wechatAudit = []
  const server = await createTelemetryServer({
    wechatAudit: (entry) => wechatAudit.push(entry),
    config: {
      host: '127.0.0.1',
      port: 0,
      databasePath: path.join(directory, 'accounts.sqlite'),
      adminTokenFile: path.join(directory, 'admin-token.txt'),
      maxBodyBytes: 131072,
      rateLimitPerMinute: 120,
      wechatCallbackToken: 'callback-test-token',
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () => new Promise((resolve) => server.close(resolve)),
    () => rm(directory, { recursive: true, force: true }),
  )

  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  const baseUrl = `http://127.0.0.1:${address.port}/geod-telemetry/v1`
  const headers = { 'content-type': 'application/json', origin: 'https://chat.laogao.xyz' }
  const registration = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: 'hello@example.com',
      password: 'correct horse battery staple',
      display_name: '测试用户',
    }),
  })
  assert.equal(registration.status, 201)
  const account = await registration.json()
  assert.equal(account.user.email, 'hello@example.com')
  assert.equal(account.quota.daily_remaining, 10)
  assert.equal(account.quota.bonus_remaining, 0)
  const authorized = { ...headers, authorization: `Bearer ${account.token}` }

  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = 'quota-test'
  const signature = wechatSignature('callback-test-token', timestamp, nonce)
  const callbackUrl = `${origin}/geod-telemetry/wechat/callback?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}`
  const verification = await fetch(`${callbackUrl}&echostr=verified`)
  assert.equal(verification.status, 200)
  assert.equal(await verification.text(), 'verified')
  assert.deepEqual(
    {
      method: wechatAudit[0].method,
      stage: wechatAudit[0].stage,
      signature_valid: wechatAudit[0].signature_valid,
      status: wechatAudit[0].status,
    },
    { method: 'GET', stage: 'verification', signature_valid: true, status: 200 },
  )

  const wechatReply = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: '<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[o-test-openid]]></FromUserName><CreateTime>1786752000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[额度]]></Content></xml>',
  })
  assert.equal(wechatReply.status, 200)
  const replyXml = await wechatReply.text()
  const code = replyXml.match(/LG-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0]
  assert.ok(code)
  const messageAudit = wechatAudit.at(-1)
  assert.deepEqual(
    {
      method: messageAudit.method,
      stage: messageAudit.stage,
      signature_valid: messageAudit.signature_valid,
      message_type: messageAudit.message_type,
      keyword_match: messageAudit.keyword_match,
      action: messageAudit.action,
      status: messageAudit.status,
    },
    {
      method: 'POST',
      stage: 'processed',
      signature_valid: true,
      message_type: 'text',
      keyword_match: true,
      action: 'issue_follow_code',
      status: 200,
    },
  )
  const forbiddenAuditFields = new Set(['openid', 'content', 'code', 'token', 'ip'])
  assert.equal(
    Object.keys(messageAudit).some((key) => forbiddenAuditFields.has(key.toLowerCase())),
    false,
  )

  const invalidOpenIdReply = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: '<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[]]></FromUserName><CreateTime>1786752000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[额度]]></Content></xml>',
  })
  assert.equal(invalidOpenIdReply.status, 400)
  assert.deepEqual(
    {
      stage: wechatAudit.at(-1).stage,
      status: wechatAudit.at(-1).status,
      error_name: wechatAudit.at(-1).error_name,
      error_code: wechatAudit.at(-1).error_code,
    },
    {
      stage: 'processing_error',
      status: 400,
      error_name: 'Error',
      error_code: 'invalid_openid',
    },
  )

  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(`${baseUrl}/quota/consume`, {
      method: 'POST',
      headers: authorized,
      body: JSON.stringify({ action_id: crypto.randomUUID() }),
    })
    assert.equal(response.status, 200)
  }
  const exhausted = await fetch(`${baseUrl}/quota/consume`, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({ action_id: crypto.randomUUID() }),
  })
  assert.equal(exhausted.status, 402)

  const redemption = await fetch(`${baseUrl}/quota/redeem`, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({ code }),
  })
  assert.equal(redemption.status, 200)
  assert.equal((await redemption.json()).quota.bonus_remaining, 20)

  const duplicate = await fetch(`${baseUrl}/quota/redeem`, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({ code }),
  })
  assert.equal(duplicate.status, 409)

  const bonusExport = await fetch(`${baseUrl}/quota/consume`, {
    method: 'POST',
    headers: authorized,
    body: JSON.stringify({ action_id: crypto.randomUUID() }),
  })
  assert.equal(bonusExport.status, 200)
  assert.equal((await bonusExport.json()).quota.bonus_remaining, 19)

  const profile = await fetch(`${baseUrl}/auth/me`, { headers: authorized })
  assert.equal(profile.status, 200)
  assert.equal((await profile.json()).quota.total_remaining, 19)

  const logout = await fetch(`${baseUrl}/auth/logout`, { method: 'POST', headers: authorized })
  assert.equal(logout.status, 200)
  const signedOut = await fetch(`${baseUrl}/auth/me`, { headers: authorized })
  assert.equal(signedOut.status, 401)
})
