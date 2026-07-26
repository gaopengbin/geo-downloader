import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildKnowledgeContext,
  DEFAULT_KNOWLEDGE_BASE,
  publicKnowledgeSources,
  searchKnowledge,
} from './knowledge-base.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const testPagePath = join(here, 'public', 'index.html')
const agentPolicy = `
You are the built-in assistant for GeoD (technical application name: GeoDownloader).
Answer in Chinese unless the user explicitly asks for another language.
Prefer short, concrete steps that match the current GeoD interface.
Treat the retrieved GeoD knowledge as the product source of truth and state uncertainty when it is insufficient.
Never claim to inspect local files, logs, tasks or settings unless explicit diagnostic context is attached.
Never request provider API keys or help bypass authorization, access controls, usage terms or copyright restrictions.
GeoD navigation links are user-invoked actions, not ordinary web links. Only reproduce exact geod:// links supplied by retrieved knowledge.
Do not claim an action already happened. Explain what the link will open and let the user click it.
`.trim()

function envBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function envInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: envInteger(env.PORT, 8787, 0, 65535),
    mockMode: envBoolean(env.MOCK_MODE, false),
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL || '').replace(/\/+$/, ''),
    upstreamApiKey: env.UPSTREAM_API_KEY || '',
    upstreamModel: env.UPSTREAM_MODEL || '',
    gatewayToken: env.GATEWAY_TOKEN || '',
    rateLimitPerMinute: envInteger(env.RATE_LIMIT_PER_MINUTE, 20, 1, 1000),
    maxBodyBytes: envInteger(env.MAX_BODY_BYTES, 262144, 1024, 2 * 1024 * 1024),
    maxInputChars: envInteger(env.MAX_INPUT_CHARS, 30000, 1000, 200000),
    maxOutputTokens: envInteger(env.MAX_OUTPUT_TOKENS, 2048, 128, 32768),
    requestTimeoutMs: envInteger(env.REQUEST_TIMEOUT_MS, 120000, 5000, 600000),
    allowedOrigins: new Set(
      (env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
    systemPrompt:
      env.SYSTEM_PROMPT ||
      'You are the GeoD assistant. Reply in Chinese unless the user asks otherwise. Be concise, factual, and clear about uncertainty.',
  }
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

function sendError(response, status, message, code = 'gateway_error', headers = {}) {
  sendJson(
    response,
    status,
    { error: { message, type: 'gateway_error', code } },
    headers,
  )
}

function setCorsHeaders(request, response, config) {
  const origin = request.headers.origin
  if (!origin || !config.allowedOrigins.has(origin)) return false

  response.setHeader('access-control-allow-origin', origin)
  response.setHeader('access-control-allow-headers', 'authorization, content-type')
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  response.setHeader('access-control-expose-headers', 'x-geod-knowledge-sources')
  response.setHeader('access-control-max-age', '600')
  response.setHeader('vary', 'origin')
  return true
}

function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
  return request.socket.remoteAddress || 'unknown'
}

function createRateLimiter(limit) {
  const windows = new Map()

  return (key) => {
    const now = Date.now()
    const current = windows.get(key)
    if (!current || current.resetAt <= now) {
      const next = { count: 1, resetAt: now + 60_000 }
      windows.set(key, next)
      return { allowed: true, remaining: limit - 1, resetAt: next.resetAt }
    }

    current.count += 1
    return {
      allowed: current.count <= limit,
      remaining: Math.max(0, limit - current.count),
      resetAt: current.resetAt,
    }
  }
}

async function readJsonBody(request, maxBytes) {
  const chunks = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error('请求内容过大')
      error.status = 413
      error.code = 'body_too_large'
      throw error
    }
    chunks.push(chunk)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('请求不是合法的 JSON')
    error.status = 400
    error.code = 'invalid_json'
    throw error
  }
}

function normalizeMessages(messages, config) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) {
    const error = new Error('messages 必须包含 1 至 30 条消息')
    error.status = 400
    error.code = 'invalid_messages'
    throw error
  }

  let inputChars = 0
  const normalized = messages.map((message) => {
    if (
      !message ||
      !['system', 'user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string'
    ) {
      const error = new Error('当前测试版仅支持文本类型的 system、user 和 assistant 消息')
      error.status = 400
      error.code = 'unsupported_message'
      throw error
    }

    inputChars += message.content.length
    return { role: message.role, content: message.content }
  })

  if (inputChars > config.maxInputChars) {
    const error = new Error(`输入内容超过 ${config.maxInputChars} 个字符`)
    error.status = 413
    error.code = 'input_too_large'
    throw error
  }

  const conversation = normalized.filter((message) => message.role !== 'system')
  if (!conversation.some((message) => message.role === 'user')) {
    const error = new Error('messages 必须包含用户消息')
    error.status = 400
    error.code = 'missing_user_message'
    throw error
  }
  return conversation
}

function normalizeContext(context, config) {
  if (context == null || context === '') return ''
  if (typeof context !== 'string') {
    const error = new Error('context 必须是文本')
    error.status = 400
    error.code = 'invalid_context'
    throw error
  }
  if (context.length > Math.min(12000, config.maxInputChars)) {
    const error = new Error('诊断上下文过长')
    error.status = 413
    error.code = 'context_too_large'
    throw error
  }
  return context
}

function normalizePayload(body, config, knowledgeBase) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('请求体必须是 JSON 对象')
    error.status = 400
    error.code = 'invalid_request'
    throw error
  }

  const requestedMaxTokens = Number.isFinite(body.max_tokens)
    ? Math.floor(body.max_tokens)
    : config.maxOutputTokens
  const conversation = normalizeMessages(body.messages, config)
  const context = normalizeContext(body.context, config)
  const latestQuestion = [...conversation]
    .reverse()
    .find((message) => message.role === 'user')
    ?.content.trim()
  const knowledgeResults = searchKnowledge(latestQuestion, knowledgeBase)
  const knowledgeContext = buildKnowledgeContext(
    knowledgeResults,
    knowledgeBase.contentVersion,
  )
  const systemContent = [
    config.systemPrompt,
    agentPolicy,
    knowledgeContext,
    context ? `The desktop client explicitly attached this diagnostic context:\n${context}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    payload: {
      model: config.upstreamModel || body.model,
      messages: [{ role: 'system', content: systemContent }, ...conversation],
      stream: body.stream === true,
      temperature: Number.isFinite(body.temperature) ? body.temperature : 0.3,
      top_p: Number.isFinite(body.top_p) ? body.top_p : undefined,
      stop: body.stop,
      max_tokens: Math.min(config.maxOutputTokens, Math.max(1, requestedMaxTokens)),
    },
    sources: publicKnowledgeSources(knowledgeResults),
  }
}

function setKnowledgeSourcesHeader(response, knowledgeBase, sources) {
  const metadata = {
    version: knowledgeBase.contentVersion,
    sources,
  }
  response.setHeader(
    'x-geod-knowledge-sources',
    encodeURIComponent(JSON.stringify(metadata)),
  )
}

function mockAnswer(payload) {
  const latest = [...payload.messages].reverse().find((message) => message.role === 'user')
  const question = latest?.content.trim() || '空消息'
  return [
    '### GeoD AI 网关连接正常',
    '',
    '- 流式输出：正常',
    '- Markdown 渲染：正常',
    '',
    '```text',
    question.replaceAll('```', "'''"),
    '```',
  ].join('\n')
}

async function sendMockResponse(response, payload) {
  const answer = mockAnswer(payload)
  if (!payload.stream) {
    sendJson(response, 200, {
      id: `mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'geod-mock',
      choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
    return
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
  })
  const id = `mock-${Date.now()}`
  for (const piece of answer.match(/[\s\S]{1,6}/gu) || []) {
    response.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      })}\n\n`,
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  response.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`,
  )
  response.end('data: [DONE]\n\n')
}

async function proxyUpstream(response, payload, config, fetchImpl) {
  if (!config.upstreamBaseUrl || !config.upstreamApiKey || !payload.model) {
    sendError(
      response,
      503,
      '真实模型尚未配置，请设置 UPSTREAM_BASE_URL、UPSTREAM_API_KEY 和 UPSTREAM_MODEL',
      'upstream_not_configured',
    )
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs)
  let upstream
  try {
    upstream = await fetchImpl(`${config.upstreamBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.upstreamApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timeout)
    const timedOut = error?.name === 'AbortError'
    sendError(
      response,
      timedOut ? 504 : 502,
      timedOut ? '上游模型响应超时' : '无法连接上游模型',
      timedOut ? 'upstream_timeout' : 'upstream_unreachable',
    )
    return
  }
  clearTimeout(timeout)

  const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8'
  response.writeHead(upstream.status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })

  if (!upstream.body) {
    response.end()
    return
  }

  const reader = upstream.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!response.write(Buffer.from(value))) {
      await new Promise((resolve) => response.once('drain', resolve))
    }
  }
  response.end()
}

function serveTestPage(response) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
  })
  createReadStream(testPagePath).pipe(response)
}

export function createGatewayServer(options = {}) {
  const config = options.config || loadConfig()
  const fetchImpl = options.fetchImpl || fetch
  const knowledgeBase = options.knowledgeBase || DEFAULT_KNOWLEDGE_BASE
  const checkRateLimit = createRateLimiter(config.rateLimitPerMinute)

  return createServer(async (request, response) => {
    setCorsHeaders(request, response, config)
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')

    const url = new URL(request.url || '/', 'http://gateway.local')
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    if (request.method === 'GET' && url.pathname === '/') {
      serveTestPage(response)
      return
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        mode: config.mockMode ? 'mock' : 'upstream',
        configured:
          config.mockMode ||
          Boolean(config.upstreamBaseUrl && config.upstreamApiKey && config.upstreamModel),
        model: config.mockMode ? 'geod-mock' : config.upstreamModel || null,
        knowledge: {
          version: knowledgeBase.contentVersion,
          articleCount: knowledgeBase.articles.length,
        },
      })
      return
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      sendError(response, 404, '接口不存在', 'not_found')
      return
    }

    if (
      config.gatewayToken &&
      request.headers.authorization !== `Bearer ${config.gatewayToken}`
    ) {
      sendError(
        response,
        401,
        '访问令牌无效',
        'invalid_gateway_token',
        { 'www-authenticate': 'Bearer' },
      )
      return
    }

    const rate = checkRateLimit(clientIp(request))
    response.setHeader('x-ratelimit-limit', String(config.rateLimitPerMinute))
    response.setHeader('x-ratelimit-remaining', String(rate.remaining))
    response.setHeader('x-ratelimit-reset', String(Math.ceil(rate.resetAt / 1000)))
    if (!rate.allowed) {
      sendError(response, 429, '请求过于频繁，请稍后再试', 'rate_limit_exceeded', {
        'retry-after': String(Math.ceil((rate.resetAt - Date.now()) / 1000)),
      })
      return
    }

    try {
      const body = await readJsonBody(request, config.maxBodyBytes)
      const { payload, sources } = normalizePayload(body, config, knowledgeBase)
      setKnowledgeSourcesHeader(response, knowledgeBase, sources)
      if (config.mockMode) {
        await sendMockResponse(response, payload)
      } else {
        await proxyUpstream(response, payload, config, fetchImpl)
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      sendError(
        response,
        error.status || 500,
        error.status ? error.message : '网关处理请求失败',
        error.code || 'internal_error',
      )
    }
  })
}

const launchedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (launchedDirectly) {
  const config = loadConfig()
  await readFile(testPagePath)
  const server = createGatewayServer({ config })
  server.listen(config.port, config.host, () => {
    const mode = config.mockMode ? 'mock' : 'upstream'
    console.log(`GeoD AI gateway (${mode}) listening on http://${config.host}:${config.port}`)
    if (!config.mockMode && !config.gatewayToken) {
      console.warn('GATEWAY_TOKEN is empty. Do not expose this service publicly.')
    }
  })
}
