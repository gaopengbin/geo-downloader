import { Channel } from '@tauri-apps/api/core'

import type {
  AssistantKnowledgeSource,
  AssistantMessage,
} from '@/features/assistant/assistant-store'
import { invokeCommand } from '@/lib/tauri'

interface StreamAssistantOptions {
  messages: AssistantMessage[]
  diagnosticContext?: string | null
  signal?: AbortSignal
  onDelta: (content: string) => void
  onSources?: (sources: AssistantKnowledgeSource[]) => void
}

export interface AssistantHealth {
  status: string
  mode: 'desktop'
  configured: boolean
  model: string
  knowledge: {
    version: string
    articleCount: number
  }
}

type AssistantStreamEvent =
  | { type: 'sources'; sources: AssistantKnowledgeSource[] }
  | { type: 'delta'; content: string }
  | { type: 'done' }

function requestId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function checkAssistantHealth(): Promise<AssistantHealth> {
  return invokeCommand<AssistantHealth>('assistant_status')
}

export async function streamAssistant({
  messages,
  diagnosticContext,
  signal,
  onDelta,
  onSources,
}: StreamAssistantOptions) {
  const id = requestId()
  const onEvent = new Channel<AssistantStreamEvent>()
  onEvent.onmessage = (event) => {
    if (event.type === 'delta') onDelta(event.content)
    if (event.type === 'sources') onSources?.(event.sources)
  }

  const cancel = () => {
    void invokeCommand<boolean>('assistant_cancel', { requestId: id })
  }
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  signal?.addEventListener('abort', cancel, { once: true })

  try {
    await invokeCommand<void>('assistant_chat', {
      request: {
        requestId: id,
        messages: messages.slice(-16).map(({ role, content }) => ({ role, content })),
        diagnosticContext: diagnosticContext || null,
      },
      onEvent,
    })
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
