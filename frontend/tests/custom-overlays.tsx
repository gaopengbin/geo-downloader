// Real MapCanvas, overlay picker and source editor. Native commands/data are
// isolated; tiles are synthetic and no user settings or credentials are touched.
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import type L from 'leaflet'
import { initializeI18n, changeAppLanguage } from '../src/i18n'
import { useAppStore } from '../src/store/app-store'
import { useTelemetryStore } from '../src/features/telemetry/telemetry-store'
import { useWaybackStore } from '../src/store/wayback-store'
import { ThemeProvider } from '../src/components/theme/theme-provider'
import { Button } from '../src/components/ui/button'
import type { AppSettings, TileSource } from '../src/types/api'
import '@fontsource-variable/geist/index.css'
import '../src/index.css'

await initializeI18n()
await changeAppLanguage(location.search.includes('en') ? 'en-US' : 'zh-CN')
localStorage.setItem('gd:theme-mode', location.search.includes('dark') ? 'dark' : 'light')
let settings: AppSettings = { proxy_enabled: false, default_source: 'fixture_base', custom_sources: [], source_overrides: [] }
const sources: Record<string, TileSource> = Object.fromEntries([
  ['fixture_base', '测试底图'], ['custom_roads', '我的道路'], ['custom_grid', '我的网格'],
  ['tianditu_satellite_label', '天地图影像注记'], ['tianditu_vector_label', '天地图矢量注记'],
].map(([id, name]) => [id, { id, name, url: `https://example.invalid/${id}/{z}/{x}/{y}.png`,
  headers: { 'x-fixture': 'test-only' }, max_zoom: 18, subdomains: [], attribution: 'Local synthetic tiles' }]))
const receipt = { saves: 0, requests: [] as { id: string; z: number; x: number; y: number }[], downloadIds: [] as string[] }
function updateReceipt() {
  const node = document.getElementById('receipt')
  if (node) node.textContent = JSON.stringify({ ...receipt, requests: receipt.requests.slice(-15), totalRequests: receipt.requests.length,
    remembered: useAppStore.getState().overlayLayersByMode, customCount: settings.custom_sources?.length ?? 0 })
}
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} }, __TAURI_INTERNALS__: {
  transformCallback: () => 0, unregisterCallback: () => {},
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === 'get_settings') return structuredClone(settings)
    if (command === 'save_settings') { settings = structuredClone(args.settings as AppSettings); receipt.saves++; updateReceipt(); return }
    if (command === 'get_builtin_sources') return sources
    if (command === 'get_tile_sources') return { ...sources, ...Object.fromEntries((settings.custom_sources ?? []).map((s) => [s.id, {
      ...s, url: s.scheme === 'tms' ? s.url.replaceAll('{y}', '{-y}') : s.url, subdomains: s.subdomains?.split(',').filter(Boolean) ?? [],
    }])) }
    if (command === 'get_wayback_versions') return { versions: [{ id: '3', date: '2026-10-29', layer_id: '3' }] }
    if (command === 'plugin:event|listen') return 0
    if (command === 'plugin:event|unlisten') return
    if (command === 'geovis_status') return { configured: false, sources: [] }
    if (command === 'source_preview_tile') {
      receipt.requests.push({ id: String(args.sourceKey), z: Number(args.z), x: Number(args.x), y: Number(args.y) }); updateReceipt()
      const isBase = args.sourceKey === 'fixture_base'
      const shape = args.sourceKey === 'custom_roads'
        ? '<path d="M0 20L256 210M40 0L210 256" stroke="#e57424" stroke-width="7"/>'
        : '<path d="M0 64H256M64 0V256M192 0V256M0 192H256" stroke="#1e8d75" stroke-width="3"/>'
      return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">${isBase ? '<rect width="256" height="256" fill="#e4eadd"/>' : shape}<text x="8" y="240" fill="#25332b" font-size="13">${isBase ? 'Local base' : args.sourceKey} ${args.z}/${args.x}/${args.y}</text></svg>`)
    }
    throw new Error(`Unsupported overlay fixture command: ${command}`)
  },
} })
if (!location.search.includes('restore')) useAppStore.setState({ mode: 'imagery', selectedSourceByMode: { imagery: 'fixture_base', wayback: 'fixture_base' },
  overlayLayersByMode: { imagery: [{ sourceId: 'tianditu_satellite_label', visible: true }], wayback: [] } })
useTelemetryStore.setState({ consent: 'disabled', noticeAcknowledgedVersion: 999 })
useWaybackStore.setState({ provider: 'esri', previewVersionId: null })
const { MapCanvas } = await import('../src/features/map/map-canvas')
const { OverlayPicker } = await import('../src/features/sources/overlay-picker')
const { validOverlayIds } = await import('../src/features/sources/overlay-sources')
const { getTileSourcesMerged } = await import('../src/features/sources/sources-api')
let map: L.Map
export function Fixture() {
  const [selected, setSelected] = useState<string[]>([])
  const sourceQuery = useQuery({ queryKey: ['tile-sources-merged', null], queryFn: () => getTileSourcesMerged() })
  return <><header className="flex flex-wrap items-center gap-2 border-b p-3 text-xs">
    <span>GeoD 叠加图层隔离验证 · 合成测试瓦片</span>
    <Button size="sm" variant="outline" onClick={() => map.panBy([300, 0], { animate: false })}>向东平移</Button>
    <Button size="sm" variant="outline" onClick={() => map.setZoom(map.getZoom() + 1, { animate: false })}>放大一级</Button>
    <Button size="sm" variant="outline" onClick={() => { useAppStore.getState().setMode('wayback'); useWaybackStore.getState().setProvider('earth') }}>切换 Wayback</Button>
    <Button size="sm" variant="outline" onClick={() => useAppStore.getState().setMode('imagery')}>返回 GeoTIFF</Button>
  </header><main className="grid h-[calc(100vh-4rem)] grid-cols-[350px_1fr]">
    <section className="space-y-3 overflow-y-auto border-r p-4"><h2 className="font-semibold">下载输出叠加层</h2>
      <form onSubmit={(e) => { e.preventDefault(); throw new Error('Source management must not submit a download') }}>
        <OverlayPicker sources={sourceQuery.data ?? {}} value={selected} onChange={setSelected} baseId="fixture_base"/>
      </form>
      <Button onClick={() => { receipt.downloadIds = validOverlayIds(selected, sourceQuery.data ?? {}, 'fixture_base'); updateReceipt() }}>记录下载顺序（测试桩）</Button>
      <output id="receipt" data-testid="receipt" className="block break-all font-mono text-[10px]">尚未操作</output>
    </section>
    <section className="relative"><MapCanvas onMapReady={(value) => { map = value; map.setView([0, 0], 3, { animate: false }); map.on('moveend zoomend layeradd layerremove', updateReceipt) }}/></section>
  </main><Toaster/></>
}
useAppStore.subscribe(updateReceipt)
const root = createRoot(document.getElementById('root')!)
root.render(<StrictMode><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: {
  retry: false, staleTime: Infinity, refetchOnWindowFocus: false,
} } })}><ThemeProvider><Fixture/></ThemeProvider></QueryClientProvider></StrictMode>)
import.meta.hot?.dispose(() => root.unmount())
