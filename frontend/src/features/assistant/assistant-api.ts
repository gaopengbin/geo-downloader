import type {
  AssistantKnowledgeSource,
  AssistantMessage,
} from '@/features/assistant/assistant-store'

interface StreamAssistantOptions {
  gatewayUrl: string
  gatewayToken: string
  messages: AssistantMessage[]
  diagnosticContext?: string | null
  signal?: AbortSignal
  onDelta: (content: string) => void
  onSources?: (sources: AssistantKnowledgeSource[]) => void
}

export interface AssistantHealth {
  status: string
  mode: 'mock' | 'upstream'
  configured: boolean
  model: string | null
  knowledge?: {
    version: string
    articleCount: number
  }
}

function gatewayEndpoint(gatewayUrl: string, path: string) {
  const base = gatewayUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('请先配置 AI 网关地址')
  return `${base}${path}`
}

async function responseError(response: Response) {
  const data = (await response.json().catch(() => null)) as {
    error?: { message?: string }
  } | null
  return data?.error?.message || `网关请求失败 (${response.status})`
}

function responseKnowledgeSources(response: Response) {
  const value = response.headers.get('x-geod-knowledge-sources')
  if (!value) return []
  try {
    const metadata = JSON.parse(decodeURIComponent(value)) as {
      sources?: AssistantKnowledgeSource[]
    }
    return Array.isArray(metadata.sources) ? metadata.sources : []
  } catch {
    return []
  }
}

export async function checkAssistantHealth(
  gatewayUrl: string,
  signal?: AbortSignal,
): Promise<AssistantHealth> {
  const response = await fetch(gatewayEndpoint(gatewayUrl, '/health'), {
    signal,
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(await responseError(response))
  return (await response.json()) as AssistantHealth
}

export async function streamAssistant({
  gatewayUrl,
  gatewayToken,
  messages,
  diagnosticContext,
  signal,
  onDelta,
  onSources,
}: StreamAssistantOptions) {
  const response = await fetch(gatewayEndpoint(gatewayUrl, '/v1/chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${gatewayToken.trim()}`,
    },
    body: JSON.stringify({
      messages: messages.slice(-16).map(({ role, content }) => ({ role, content })),
      context: diagnosticContext || undefined,
      stream: true,
      max_tokens: 1200,
      temperature: 0.25,
    }),
    signal,
  })

  if (!response.ok) throw new Error(await responseError(response))
  if (!response.body) throw new Error('网关未返回可读取的响应')
  onSources?.(responseKnowledgeSources(response))

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''

    for (const event of events) {
      const lines = event
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))

      for (const data of lines) {
        if (data === '[DONE]') return
        const chunk = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string | null } }>
        }
        const content = chunk.choices?.[0]?.delta?.content
        if (content) onDelta(content)
      }
    }
  }
}
