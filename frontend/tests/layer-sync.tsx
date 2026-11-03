// Actual sidebar, Leaflet map and source dialogs. Only native APIs/tiles are
// simulated, on a dedicated origin; no user settings, credentials or files used.
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type L from 'leaflet'
import { Toaster } from 'sonner'
import '@fontsource-variable/geist/index.css'
import '../src/index.css'

if (!location.search.includes('restore')) {
  localStorage.setItem('geo-downloader:app', JSON.stringify({ version: 1, state: { mode: 'imagery', tab: 'download',
    selectedSourceByMode: { imagery: 'google_satellite' }, overlayVisibilityByMode: { imagery: { cva: true } } } }))
  localStorage.setItem('geo-downloader:imagery-params', JSON.stringify({ version: 1, state: {
    overlaySourcesByMode: { imagery: ['tianditu_satellite_label'], wayback: [] },
    savePathByMode: { imagery: 'Q:\\isolated-test', wayback: 'Q:\\isolated-test' }, zoomLevelsByMode: { imagery: [3], wayback: [3] },
  } }))
}
const { initializeI18n, changeAppLanguage } = await import('../src/i18n')
await initializeI18n(); await changeAppLanguage(location.search.includes('en') ? 'en-US' : 'zh-CN')
localStorage.setItem('gd:theme-mode', location.search.includes('dark') ? 'dark' : 'light')
const { useAppStore } = await import('../src/store/app-store')
const { useWaybackStore } = await import('../src/store/wayback-store')
const { useSelectionStore } = await import('../src/store/selection-store')
const { useTelemetryStore } = await import('../src/features/telemetry/telemetry-store')
const { useBatchStore } = await import('../src/store/batch-store')
useTelemetryStore.setState({ consent: 'disabled', noticeAcknowledgedVersion: 999 })
if (!location.search.includes('restore')) useWaybackStore.setState({ provider: 'esri', previewVersionId: null })
useSelectionStore.getState().setExternalSelection({ bounds: { west: -.1, east: .1, south: -.1, north: .1 }, polygon: null })
const { Button } = await import('../src/components/ui/button')
const { ThemeProvider } = await import('../src/components/theme/theme-provider')
let settings = { proxy_enabled: false, default_source: 'google_satellite', default_zoom: 3, empty_tile_probe_action: 'continue', custom_sources: [], source_overrides: [] }
const sources = Object.fromEntries([
  ['google_satellite', 'Google 卫星'], ['tianditu_satellite', '天地图 卫星'], ['custom_roads', '我的道路'], ['custom_grid', '我的网格'],
  ['tianditu_satellite_label', '天地图影像注记'], ['tianditu_vector_label', '天地图矢量注记'],
  ['nasa_weld_1990', 'NASA 1990'], ['nasa_weld_2000', 'NASA 2000'],
].map(([id, name]) => [id, { id, name, url: `https://example.invalid/${id}/{z}/{x}/{y}.png`, max_zoom: 18, headers: { 'x-fixture': 'only' }, subdomains: [], attribution: 'Synthetic validation tiles' }]))
const earthSource = (date: string) => {
  const id = 'earth_keyhole_'+(date === '2013-10-16' ? 'a' : 'b').repeat(64)
  const source = { id, name: `Earth ${date}`, url: `https://example.invalid/${id}/{z}/{x}/{y}.png`, max_zoom: 18, headers: { 'x-fixture': 'only' }, subdomains: [], attribution: 'Synthetic historical tiles' }
  sources[id] = source
  return source
}
const receipt = { tasks: [] as unknown[], errors: [] as string[], requests: [] as string[], saves: 0 }
let map: L.Map | undefined
function updateReceipt() {
  const layers: unknown[] = []
  map?.eachLayer((layer) => { const options = layer.options as { sourceKey?: string; zIndex?: number }; if (options.sourceKey) layers.push({ source: options.sourceKey, zIndex: options.zIndex }) })
  const node = document.getElementById('receipt')
  if (node) node.textContent = JSON.stringify({ ...receipt, requests: receipt.requests.slice(-6), requestCount: receipt.requests.length,
    base: useAppStore.getState().selectedSourceByMode, layers: useAppStore.getState().overlayLayersByMode, rendered: layers })
}
window.addEventListener('error', (event) => { receipt.errors.push(event.message); updateReceipt() })
window.addEventListener('unhandledrejection', (event) => { receipt.errors.push(String(event.reason)); updateReceipt() })
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} }, __TAURI_INTERNALS__: {
  transformCallback: () => 0, unregisterCallback: () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === 'get_settings') return structuredClone(settings)
    if (command === 'plugin:dialog|open') return 'Q:\\isolated-test'
    if (command === 'save_settings') { settings = structuredClone(args.settings as typeof settings); receipt.saves++; updateReceipt(); return }
    if (command === 'get_builtin_sources') return structuredClone(sources)
    if (command === 'get_tile_sources') return structuredClone(sources)
    if (command === 'plugin:event|listen') return 0
    if (command === 'plugin:event|unlisten') return
    if (command === 'geovis_status') return { configured: false, sources: [] }
    if (command === 'estimate_download') return { tile_count: 4, estimated_size_mb: .2, warning: null }
    if (command === 'probe_tile') return { has_data: true, status_code: 200, content_length: 4096, message: 'fixture' }
    if (command === 'create_download_task' || command === 'create_wayback_task') {
      receipt.tasks.push({ command, ...structuredClone(args) }); updateReceipt(); return { task_id: `fixture-${receipt.tasks.length}`, tile_count: 4 }
    }
    if (command === 'get_wayback_versions') return { versions: [{ id: '3', date: '2026-10-29', layer_id: '3' }, { id: '2', date: '2025-10-29', layer_id: '2' }] }
    if (command === 'probe_wayback_max_zoom') return 18
    if (command === 'start_tile_proxy') return `${location.origin}/tests/fixture-wayback.svg?tile=`
    if (command === 'fetch_and_cache_tile' || command === 'cache_put_tile' || command === 'earth_history_cancel') return
    if (command === 'keyhole_history_dates') return { rootId: 'fixture-root', path: 'fixture', level: 12, catalogLevel: 12, dates: [{ date: '2013-10-16' }, { date: '1996-12-31' }], scope: 'view-centre' }
    if (command === 'keyhole_history_session') return { id: 'fixture-'+args.date, requestedDate: args.date, source: earthSource(String(args.date)) }
    if (command === 'keyhole_history_status') return { loaded: 16, cacheHits: 0, noData: 0, fallbackTiles: 0, errors: 0, providers: ['Synthetic validation session'] }
    if (command === 'source_preview_tile') {
      const id = String(args.sourceKey); receipt.requests.push(id); updateReceipt()
      const base = id === 'google_satellite' || id === 'tianditu_satellite' || id.startsWith('nasa_') || id.startsWith('wayback_') || id.startsWith('earth_')
      const shape = id === 'custom_roads' ? '<path d="M0 20L256 210M40 0L210 256" stroke="#e57424" stroke-width="7"/>'
        : '<path d="M0 64H256M64 0V256M192 0V256M0 192H256" stroke="#1e8d75" stroke-width="3"/>'
      return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">${base ? `<rect width="256" height="256" fill="${id === 'tianditu_satellite' ? '#cfdfeb' : '#e4eadd'}"/>` : shape}<text x="8" y="240" fill="#25332b" font-size="13">${id} ${args.z}/${args.x}/${args.y}</text></svg>`)
    }
    if (command === 'get_active_tasks' || command.includes('regions') || command.includes('provinces')) return []
    throw new Error(`Unsupported layer-sync fixture command: ${command}`)
  },
} })
const { ImageryPage } = await import('../src/features/imagery/imagery-page')
const { WaybackPage } = await import('../src/features/wayback/wayback-page')
const { MapCanvas } = await import('../src/features/map/map-canvas')
const { BatchDialog } = await import('../src/features/batch/batch-dialog')
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } } })
function Fixture() {
  const mode = useAppStore((state) => state.mode)
  useEffect(() => updateReceipt(), [])
  return <div className="fixed inset-0 flex flex-col"><header className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2 text-xs">
    <span>图层联动隔离验证 · 合成瓦片与模拟任务 API</span>
    <Button size="sm" variant="outline" onClick={() => useAppStore.getState().setMode('imagery')}>GeoTIFF</Button>
    <Button size="sm" variant="outline" onClick={() => useAppStore.getState().setMode('wayback')}>Wayback</Button>
    <Button size="sm" variant="outline" onClick={() => map?.panBy([256,0], { animate: false })}>平移地图</Button>
    <Button size="sm" variant="outline" onClick={() => map?.setZoom(map.getZoom()+1)}>放大地图</Button>
    <Button size="sm" variant="outline" onClick={() => useBatchStore.getState().open([0,1].map((index)=>({type:'Feature',properties:{name:`Area ${index+1}`},geometry:{type:'Polygon',coordinates:[[[index*.03,0],[index*.03+.02,0],[index*.03+.02,.02],[index*.03,.02],[index*.03,0]]]}})),'fixture.geojson')}>批量边界测试</Button>
    <a href={location.pathname+'?restore'+(location.search.includes('en')?'&en':'')}>重新加载并恢复</a>
  </header><main className="grid min-h-0 flex-1 grid-cols-[360px_1fr]">
    <section data-task-sidebar className="overflow-y-auto border-r p-3">{mode === 'wayback' ? <WaybackPage/> : <ImageryPage key={mode} mode="imagery"/>}
      <output id="receipt" className="mt-3 block break-all text-[10px]"/>
    </section>
    <section className="relative"><MapCanvas onMapReady={(value) => { map=value; value.setView([0,0],3,{animate:false}); value.on('moveend zoomend layeradd layerremove',updateReceipt) }}/></section>
  </main><BatchDialog/><Toaster/></div>
}
useAppStore.subscribe(updateReceipt)
const root=createRoot(document.getElementById('root')!)
root.render(<StrictMode><QueryClientProvider client={client}><ThemeProvider><Fixture/></ThemeProvider></QueryClientProvider></StrictMode>)
import.meta.hot?.dispose(()=>root.unmount())
