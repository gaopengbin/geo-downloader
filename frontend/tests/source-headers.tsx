// Isolated UI fixture; real HTTP behavior is covered by Rust's local auth server.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import '@fontsource-variable/geist/index.css'
import '../src/index.css'
import { initializeI18n } from '../src/i18n'
import type { AppSettings, CustomTileSource, TileSource } from '../src/types/api'
import { Button } from '../src/components/ui/button'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

await initializeI18n()
let settings: AppSettings = { custom_sources: [], source_overrides: [] }
const builtin: TileSource = { id: 'fixture_builtin', name: '内置测试图源',
  url: 'https://tiles.example.test/{z}/{x}/{y}.png', max_zoom: 18, subdomains: [] }
const receipts = { saves: 0, tests: 0, testedHeaders: 0, previewCalls: 0, loadedTiles: 0 }
function receipt() {
  document.getElementById('qa-receipt')!.textContent = JSON.stringify({ ...receipts,
    customCount: settings.custom_sources?.length ?? 0,
    customHeaders: Object.keys(settings.custom_sources?.[0]?.headers ?? {}).sort(),
    overrideHeaders: Object.keys(settings.source_overrides?.[0]?.headers ?? {}).sort() })
}
function convert(source: CustomTileSource): TileSource {
  return { ...source, subdomains: source.subdomains?.split(',').filter(Boolean) ?? [] }
}
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args?: Record<string, unknown>) => {
  switch (command) {
    case 'get_settings': return structuredClone(settings)
    case 'save_settings': settings = structuredClone(args?.settings as AppSettings); receipts.saves++; receipt(); return
    case 'get_builtin_sources': return { fixture_builtin: builtin }
    case 'get_tile_sources': return Object.fromEntries([
      ['fixture_builtin', settings.source_overrides?.[0] ? convert(settings.source_overrides[0]) : builtin],
      ...(settings.custom_sources ?? []).map((s) => [s.id, convert(s)]),
    ])
    case 'analyze_tile_source_url': {
      receipts.tests++
      receipts.testedHeaders = Object.keys((args?.headers ?? {}) as object).length
      receipt()
      return { url_template: args?.rawUrl, sample_url: args?.rawUrl, suggested_name: '认证图源',
        suggested_max_zoom: 18, subdomains: '', test_ok: true, status_code: 200,
        content_type: 'image/png', content_length: 1024, tile_format: 'png', message: '界面测试桩：已收到请求头' }
    }
    case 'geovis_status': return { configured: false, sources: [] }
    case 'source_preview_tile':
      if (Object.keys(args ?? {}).some((key) => !['sourceKey','z','x','y'].includes(key))) {
        throw new Error('Preview must pass only the saved source ID and coordinates')
      }
      receipts.previewCalls++; receipt()
      return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#d0e7dc"/><text x="50" y="130">Local UI test tile</text></svg>')
    default: throw new Error(`Unsupported fixture command: ${command}`)
  }
} } })
const { SourcesDialog } = await import('../src/features/sources/sources-dialog')
const { createCachedTileLayer } = await import('../src/features/map/cached-tile-layer')
let map: L.Map | undefined
function preview() {
  map?.remove()
  map = L.map('qa-map').setView([0,0],1)
  const layer = createCachedTileLayer('https://tiles.example.test/{z}/{x}/{y}.png', {
    sourceKey:'fixture_builtin', requestHeaders: { authorization: 'Bearer test-only' },
    maxZoom: 3, attribution: 'Local UI test fixture',
  })
  layer.on('tileload', () => { receipts.loadedTiles++; receipt() })
  layer.addTo(map)
}
const root = createRoot(document.getElementById('root')!)
root.render(<StrictMode><QueryClientProvider client={new QueryClient({ defaultOptions: {
  queries: { retry: false, refetchOnWindowFocus: false },
} })}>
  <main className="space-y-3 p-6">
    <p>浏览器界面测试：隔离配置，请求结果为测试桩，不修改真实图源。</p>
    <SourcesDialog />
    <Button onClick={preview}>验证地图预览</Button>
    <div id="qa-map" className="h-64 w-full max-w-lg" />
    <output id="qa-receipt" className="block break-all font-mono text-xs">尚未保存</output>
  </main><Toaster />
</QueryClientProvider></StrictMode>)
import.meta.hot?.dispose(() => root.unmount())
