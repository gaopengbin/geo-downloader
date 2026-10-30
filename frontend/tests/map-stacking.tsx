// Real App layout, settings consent dialog, Leaflet controls and Wayback timeline.
// Only native data/commands are isolated; no real settings, keys or imagery are used.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { initializeI18n } from '../src/i18n'
import { useAppStore } from '../src/store/app-store'
import { useTelemetryStore } from '../src/features/telemetry/telemetry-store'
import { useWaybackStore } from '../src/store/wayback-store'
import { ErrorBoundary } from '../src/components/error-boundary'
import { ThemeProvider } from '../src/components/theme/theme-provider'
import '@fontsource-variable/geist/index.css'
import '../src/index.css'

await initializeI18n()
localStorage.setItem('gd:theme-mode', location.search.includes('light') ? 'light' : 'dark')
const settings = { proxy_enabled: false, tianditu_token: null, default_concurrency: 8,
  ai_assistant_enabled: false, custom_sources: [], source_overrides: [] }
const versions = { versions: [
  { id: '3', date: '2026-10-29', title: '2026', layer_id: '3' },
  { id: '2', date: '2025-10-01', title: '2025', layer_id: '2' },
  { id: '1', date: '2014-10-01', title: '2014', layer_id: '1' },
] }
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} }, __TAURI_INTERNALS__: {
  transformCallback: () => 0,
  unregisterCallback: () => {},
  invoke: async (command: string) => {
    switch (command) {
      case 'get_settings': return settings
      case 'get_wayback_versions': return versions
      case 'get_tile_sources': case 'get_builtin_sources': return {}
      case 'get_system_memory': return null
      case 'assistant_secret_status': return { configured: false }
      case 'notifications_list': return { items: [], unreadCount: 0 }
      case 'plugin:event|listen': return 0
      case 'plugin:event|unlisten': return
      case 'get_region_tree': return []
      case 'get_active_tasks': case 'get_task_history': case 'get_resumable_tasks': return []
      default: throw new Error(`Unsupported stacking fixture command: ${command}`)
    }
  },
} })
useAppStore.setState({ mode: 'wayback', tab: 'settings' })
useWaybackStore.setState({ provider: 'esri', previewVersionId: '3' })
useTelemetryStore.setState({ consent: 'disabled', noticeAcknowledgedVersion: 999 })
const { default: App } = await import('../src/App')
const client = new QueryClient({ defaultOptions: { queries: {
  retry: false, refetchOnWindowFocus: false, staleTime: Infinity,
} } })
client.setQueryData(['settings'], settings)
client.setQueryData(['wayback-versions', ''], versions)
createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={client}><ErrorBoundary>
    <ThemeProvider>
    <App />
    </ThemeProvider>
  </ErrorBoundary></QueryClientProvider></StrictMode>,
)
