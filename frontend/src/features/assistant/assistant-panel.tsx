import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  BookOpen,
  CircleStop,
  Loader2,
  SendHorizontal,
  Sparkles,
  Stethoscope,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  checkAssistantHealth,
  streamAssistant,
  type AssistantHealth,
} from '@/features/assistant/assistant-api'
import { executeAssistantActionHref } from '@/features/assistant/assistant-actions'
import { useAssistantConfig } from '@/features/assistant/assistant-config'
import { collectAssistantDiagnostics } from '@/features/assistant/assistant-diagnostics'
import { AssistantMarkdown } from '@/features/assistant/assistant-markdown'
import {
  createAssistantMessage,
  useAssistantStore,
} from '@/features/assistant/assistant-store'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'

type ConnectionState =
  | { status: 'checking' }
  | { status: 'ready'; health: AssistantHealth }
  | { status: 'error'; message: string }

const SUGGESTIONS = [
  '下载任务为什么会中断？',
  '如何迁移瓦片缓存目录？',
  '图源 URL 应该怎么配置？',
]

export function AssistantPanel() {
  const { enabled } = useAssistantConfig()
  const open = useAssistantStore((state) => state.open)
  const setOpen = useAssistantStore((state) => state.setOpen)
  const messages = useAssistantStore((state) => state.messages)
  const draft = useAssistantStore((state) => state.draft)
  const setDraft = useAssistantStore((state) => state.setDraft)
  const diagnosticContext = useAssistantStore((state) => state.diagnosticContext)
  const setDiagnosticContext = useAssistantStore((state) => state.setDiagnosticContext)
  const addMessage = useAssistantStore((state) => state.addMessage)
  const appendMessage = useAssistantStore((state) => state.appendMessage)
  const setMessageSources = useAssistantStore((state) => state.setMessageSources)
  const failMessage = useAssistantStore((state) => state.failMessage)
  const clearMessages = useAssistantStore((state) => state.clearMessages)
  const mode = useAppStore((state) => state.mode)
  const tab = useAppStore((state) => state.tab)

  const [connection, setConnection] = useState<ConnectionState>({ status: 'checking' })
  const [streaming, setStreaming] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void checkAssistantHealth()
      .then((health) => setConnection({ status: 'ready', health }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setConnection({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
    return () => controller.abort()
  }, [open])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, streaming])

  useEffect(
    () => () => {
      requestRef.current?.abort()
    },
    [],
  )

  const attachDiagnostics = async () => {
    const context = await collectAssistantDiagnostics(mode, tab)
    setDiagnosticContext(context)
    toast.success('已附加当前运行环境')
  }

  const stopStreaming = () => {
    requestRef.current?.abort()
  }

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault()
    const content = draft.trim()
    if (!content || streaming) return
    if (connection.status !== 'ready' || !connection.health.configured) {
      toast.error('请先在设置的开发者选项中填写 DeepSeek API Key')
      return
    }

    const userMessage = createAssistantMessage('user', content)
    const assistantMessage = createAssistantMessage('assistant', '')
    const conversation = [...messages, userMessage]
    addMessage(userMessage)
    addMessage(assistantMessage)
    setDraft('')
    setStreaming(true)

    const controller = new AbortController()
    requestRef.current = controller
    let receivedContent = false

    try {
      await streamAssistant({
        messages: conversation,
        diagnosticContext,
        signal: controller.signal,
        onDelta: (delta) => {
          receivedContent = true
          appendMessage(assistantMessage.id, delta)
        },
        onSources: (sources) => {
          setMessageSources(assistantMessage.id, sources)
        },
      })
      if (!receivedContent) {
        failMessage(assistantMessage.id, '模型没有返回可显示的内容，请重试。')
      } else {
        setDiagnosticContext(null)
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (!receivedContent) failMessage(assistantMessage.id, '已停止生成。')
      } else {
        failMessage(
          assistantMessage.id,
          `请求失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } finally {
      requestRef.current = null
      setStreaming(false)
    }
  }

  if (!enabled || !open) return null

  return (
    <aside
      aria-label="GeoD AI 助手"
      className="fixed bottom-0 right-0 top-12 z-[55] flex w-[min(420px,100vw)] flex-col border-l bg-background shadow-2xl"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Sparkles className="size-3.5" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">GeoD 助手</div>
          <ConnectionLabel connection={connection} />
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            title="清空会话"
            aria-label="清空会话"
            disabled={streaming || messages.length === 0}
            onClick={clearMessages}
          >
            <Trash2 className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            title="关闭"
            aria-label="关闭助手"
            onClick={() => setOpen(false)}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col justify-center">
            <div className="mb-5">
              <div className="mb-2 flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Sparkles className="size-4" />
              </div>
              <h2 className="text-base font-semibold">有什么需要排查的？</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                可以询问下载、图源、缓存和任务恢复等 GeoD 使用问题。
              </p>
            </div>
            <div className="space-y-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="block w-full rounded-md border px-3 py-2.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-primary/5"
                  onClick={() => setDraft(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  'max-w-[88%] min-w-0 break-words rounded-md px-3 py-2.5 text-sm leading-6',
                  message.role === 'user'
                    ? 'ml-auto whitespace-pre-wrap bg-primary text-primary-foreground'
                    : 'mr-auto bg-muted text-foreground',
                  message.failed && 'border border-destructive/30 bg-destructive/5 text-destructive',
                )}
              >
                {message.content ? (
                  message.role === 'assistant' ? (
                    <>
                      <AssistantMarkdown
                        content={message.content}
                        onAction={executeAssistantActionHref}
                      />
                      {message.sources && message.sources.length > 0 && (
                        <div className="mt-2.5 border-t border-border/60 pt-2">
                          <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                            <BookOpen className="size-3" />
                            参考知识
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {message.sources.map((source) => (
                              <span
                                key={source.id}
                                className="inline-flex max-w-full items-center rounded border bg-background/70 px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground"
                                title={source.summary}
                              >
                                {source.title}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    message.content
                  )
                ) : streaming && message.role === 'assistant' ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : null}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <form className="shrink-0 border-t bg-background p-3" onSubmit={sendMessage}>
        {diagnosticContext && (
          <div className="mb-2 flex items-center gap-2 rounded-md border border-primary/25 bg-primary/5 px-2.5 py-2 text-xs text-foreground">
            <Stethoscope className="size-3.5 text-primary" />
            <span className="min-w-0 flex-1 truncate">已附加当前运行环境</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label="移除诊断信息"
              onClick={() => setDiagnosticContext(null)}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        <div className="rounded-md border bg-background focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10">
          <textarea
            value={draft}
            rows={3}
            maxLength={8000}
            placeholder="描述问题，Enter 发送，Shift+Enter 换行"
            className="block max-h-40 min-h-20 w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-5 outline-none placeholder:text-muted-foreground"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void sendMessage()
              }
            }}
          />
          <div className="flex h-10 items-center justify-between border-t px-2">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              title="附加当前运行环境"
              aria-label="附加当前运行环境"
              onClick={() => void attachDiagnostics()}
            >
              <Stethoscope className="size-3.5" />
            </Button>
            {streaming ? (
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="size-7"
                title="停止生成"
                aria-label="停止生成"
                onClick={stopStreaming}
              >
                <CircleStop className="size-3.5" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                className="size-7"
                title="发送"
                aria-label="发送消息"
                disabled={!draft.trim()}
              >
                <SendHorizontal className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          AI 回答可能有误，请结合实际数据和图源规则判断
        </p>
      </form>
    </aside>
  )
}

function ConnectionLabel({ connection }: { connection: ConnectionState }) {
  if (connection.status === 'checking') {
    return (
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        正在连接
      </div>
    )
  }

  if (connection.status === 'error') {
    return (
      <div className="flex max-w-52 items-center gap-1 text-[11px] text-destructive" title={connection.message}>
        <WifiOff className="size-3 shrink-0" />
        <span className="truncate">助手不可用</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
      <Wifi className="size-3" />
      <span
        className="max-w-64 truncate"
        title={
          connection.health.knowledge
            ? `知识库 ${connection.health.knowledge.version} · ${connection.health.knowledge.articleCount} 篇`
            : undefined
        }
      >
        {connection.health.model || '已连接'}
        {connection.health.knowledge
          ? ` · 知识库 ${connection.health.knowledge.version}`
          : ''}
      </span>
    </div>
  )
}
