import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createSafeJSONStorage } from '@/store/persist-storage'

export type AssistantRole = 'user' | 'assistant'

export interface AssistantKnowledgeAction {
  label: string
  href: string
}

export interface AssistantKnowledgeSource {
  id: string
  title: string
  summary: string
  actions: AssistantKnowledgeAction[]
}

export interface AssistantMessage {
  id: string
  role: AssistantRole
  content: string
  sources?: AssistantKnowledgeSource[]
  failed?: boolean
}

interface AssistantState {
  open: boolean
  gatewayUrl: string
  gatewayToken: string
  messages: AssistantMessage[]
  draft: string
  diagnosticContext: string | null
  setOpen: (open: boolean) => void
  toggle: () => void
  setGatewayUrl: (gatewayUrl: string) => void
  setGatewayToken: (gatewayToken: string) => void
  setDraft: (draft: string) => void
  setDiagnosticContext: (diagnosticContext: string | null) => void
  addMessage: (message: AssistantMessage) => void
  appendMessage: (id: string, content: string) => void
  setMessageSources: (id: string, sources: AssistantKnowledgeSource[]) => void
  failMessage: (id: string, content: string) => void
  clearMessages: () => void
  openWithContext: (diagnosticContext: string, draft?: string) => void
}

type PersistedAssistantState = Pick<AssistantState, 'gatewayUrl' | 'gatewayToken'>

export function createAssistantMessage(
  role: AssistantRole,
  content: string,
): AssistantMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
  }
}

export const useAssistantStore = create<AssistantState>()(
  persist(
    (set) => ({
      open: false,
      gatewayUrl: 'http://127.0.0.1:8787',
      gatewayToken: 'geod-local-test',
      messages: [],
      draft: '',
      diagnosticContext: null,
      setOpen: (open) => set({ open }),
      toggle: () => set((state) => ({ open: !state.open })),
      setGatewayUrl: (gatewayUrl) => set({ gatewayUrl }),
      setGatewayToken: (gatewayToken) => set({ gatewayToken }),
      setDraft: (draft) => set({ draft }),
      setDiagnosticContext: (diagnosticContext) => set({ diagnosticContext }),
      addMessage: (message) =>
        set((state) => ({ messages: [...state.messages, message] })),
      appendMessage: (id, content) =>
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === id
              ? { ...message, content: `${message.content}${content}` }
              : message,
          ),
        })),
      setMessageSources: (id, sources) =>
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === id ? { ...message, sources } : message,
          ),
        })),
      failMessage: (id, content) =>
        set((state) => ({
          messages: state.messages.map((message) =>
            message.id === id ? { ...message, content, failed: true } : message,
          ),
        })),
      clearMessages: () => set({ messages: [], diagnosticContext: null }),
      openWithContext: (diagnosticContext, draft = '请帮我分析这个问题，并给出排查步骤。') =>
        set({ open: true, diagnosticContext, draft }),
    }),
    {
      name: 'geo-downloader:assistant',
      version: 1,
      storage: createSafeJSONStorage(),
      partialize: (state): PersistedAssistantState => ({
        gatewayUrl: state.gatewayUrl,
        gatewayToken: state.gatewayToken,
      }),
    },
  ),
)

export function openAssistantWithContext(context: string, draft?: string) {
  useAssistantStore.getState().openWithContext(context, draft)
}
