import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createGatewayServer, loadConfig } from '../server.mjs'

const servers = []

async function start(configOverrides = {}, fetchImpl) {
  const config = {
    ...loadConfig({}),
    port: 0,
    mockMode: true,
    gatewayToken: 'test-token',
    ...configOverrides,
  }
  const server = createGatewayServer({ config, fetchImpl })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  )
})

test('health reports mock mode without exposing secrets', async () => {
  const baseUrl = await start()
  const response = await fetch(`${baseUrl}/health`)
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.status, 'ok')
  assert.equal(body.mode, 'mock')
  assert.equal(body.knowledge.articleCount > 0, true)
  assert.equal(JSON.stringify(body).includes('test-token'), false)
})

test('chat endpoint requires the gateway token', async () => {
  const baseUrl = await start()
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  })
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.equal(body.error.code, 'invalid_gateway_token')
})

test('a client provider key enables BYOK and overrides the server key', async () => {
  let forwardedAuthorization
  const fakeFetch = async (_url, options) => {
    forwardedAuthorization = options.headers.authorization
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  const baseUrl = await start(
    {
      mockMode: false,
      upstreamBaseUrl: 'https://api.deepseek.com/v1',
      upstreamApiKey: 'server-secret',
      upstreamModel: 'deepseek-chat',
    },
    fakeFetch,
  )
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-geod-provider-key': 'client-secret',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(forwardedAuthorization, 'Bearer client-secret')
})

test('mock mode returns an OpenAI-compatible completion', async () => {
  const baseUrl = await start()
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '测试一下' }],
      stream: false,
    }),
  })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.object, 'chat.completion')
  assert.match(body.choices[0].message.content, /测试一下/)
})

test('upstream requests force the configured model and output limit', async () => {
  let forwardedBody
  const fakeFetch = async (_url, options) => {
    forwardedBody = JSON.parse(options.body)
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  const baseUrl = await start(
    {
      mockMode: false,
      upstreamBaseUrl: 'https://example.invalid/v1',
      upstreamApiKey: 'upstream-secret',
      upstreamModel: 'fixed-model',
      maxOutputTokens: 256,
    },
    fakeFetch,
  )
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'expensive-model',
      max_tokens: 9999,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(forwardedBody.model, 'fixed-model')
  assert.equal(forwardedBody.max_tokens, 256)
  assert.equal(forwardedBody.messages[0].role, 'system')
})

test('gateway retrieves knowledge and ignores client system prompts', async () => {
  let forwardedBody
  const fakeFetch = async (_url, options) => {
    forwardedBody = JSON.parse(options.body)
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
  const baseUrl = await start(
    {
      mockMode: false,
      upstreamBaseUrl: 'https://example.invalid/v1',
      upstreamApiKey: 'upstream-secret',
      upstreamModel: 'fixed-model',
    },
    fakeFetch,
  )
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'CLIENT_SYSTEM_MUST_NOT_REACH_UPSTREAM' },
        { role: 'user', content: 'Wayback history download' },
      ],
    }),
  })

  assert.equal(response.status, 200)
  assert.equal(
    forwardedBody.messages.some((message) =>
      message.content.includes('CLIENT_SYSTEM_MUST_NOT_REACH_UPSTREAM'),
    ),
    false,
  )
  assert.match(forwardedBody.messages[0].content, /SOURCE wayback-workflow/)

  const metadata = JSON.parse(
    decodeURIComponent(response.headers.get('x-geod-knowledge-sources')),
  )
  assert.equal(metadata.sources[0].id, 'wayback-workflow')
})
