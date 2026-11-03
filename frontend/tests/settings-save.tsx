// The actual settings page, with isolated test storage instead of the user's settings.
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import '@fontsource-variable/geist/index.css'
import '../src/index.css'
import { initializeI18n, i18n } from '../src/i18n'
import type { AppSettings } from '../src/types/api'

await initializeI18n()
const params = new URLSearchParams(location.search)
await i18n.changeLanguage(params.get('lang') || 'zh-CN')
let stored: AppSettings = {
  tianditu_token: null, cesium_ion_token: null, default_format: 'geotiff',
  default_concurrency: 30, default_zoom: 15, memory_budget_mb: 2048,
  tile_count_warning: 500000, ai_assistant_enabled: false,
  ai_model: params.get('invalid') === 'ai_model' ? '' : 'deepseek-v4-flash',
}
const storageKey = 'geod-qa-tianditu-backup-settings'
if (params.get('persist') === '1') {
  const previous = sessionStorage.getItem(storageKey)
  if (previous) stored = JSON.parse(previous) as AppSettings
}
let saves = 0
Object.assign(window, { __TAURI_INTERNALS__: {
  invoke: async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'get_settings': return structuredClone(saves > 0 && params.get('mismatch') === '1'
        ? {...stored,tianditu_token:null}
        : saves > 0 && params.get('mismatch') === 'backups' ? {...stored,tianditu_backup_tokens:[]}
        : saves > 0 && params.get('mismatch') === 'scheduling' ? {...stored,download_rate_limit:0} : stored)
      case 'save_settings':
        if (params.get('fail') === '1') throw new Error('测试：保存目录不可写')
        stored = structuredClone(args?.settings as AppSettings)
        if (params.get('persist') === '1') sessionStorage.setItem(storageKey, JSON.stringify(stored))
        saves++
        document.getElementById('qa-receipt')!.textContent = `saves=${saves}; tokenSaved=${Boolean(stored.tianditu_token)}; backups=${stored.tianditu_backup_tokens?.length ?? 0}; rate=${stored.download_rate_limit}; batch=${stored.download_batch_size}; pause=${stored.download_batch_pause_ms}`
        return null
      case 'assistant_secret_status': return {configured:false}
      case 'get_system_memory': return {total_mb:98302,available_mb:92656}
      case 'cache_stats': return {rootDir:'test-cache',enabled:true,max_total_bytes:5368709120,used_bytes:0,sources:[]}
      case 'cache_migration_status': return {running:false}
      case 'get_builtin_sources':
      case 'get_tile_sources': return {}
      case 'plugin:app|version': return 'test'
      case 'plugin:app|tauri_version': return 'test'
      default: throw new Error(`Unsupported test command: ${command}`)
    }
  },
} })
const { SettingsPanel } = await import('../src/features/settings/settings-panel')
const root = createRoot(document.getElementById('root')!)
root.render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}})}>
  <main style={{height:'100vh',width:380,maxWidth:'100%',overflowY:'auto',padding:12}}>
    <p className="mb-3 text-xs text-muted-foreground">设置测试 · 使用隔离存储，不修改真实配置</p>
    <SettingsPanel />
    <output id="qa-receipt" className="block break-all">saves=0</output>
  </main>
  <Toaster />
</QueryClientProvider>)
import.meta.hot?.dispose(() => root.unmount())
