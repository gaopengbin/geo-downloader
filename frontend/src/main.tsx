import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'

import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'

import App from './App.tsx'
import { ErrorBoundary } from '@/components/error-boundary'
import { ThemeProvider } from '@/components/theme/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { AssistantPanel } from '@/features/assistant/assistant-panel'
import { createQueryClient } from '@/lib/query-client'
import { initializeI18n } from '@/i18n'

import './index.css'

const queryClient = createQueryClient()

await initializeI18n()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <App />
          <AssistantPanel />
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
