import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import '../src/index.css'
import { initializeI18n, changeAppLanguage } from '../src/i18n'
import { FoundationControls } from '../src/features/foundation/foundation-controls'
import { installFoundationLayers } from '../src/features/foundation/foundation-map'
import { useFoundationStore } from '../src/features/foundation/foundation-store'
import { SourcesDialog } from '../src/features/sources/sources-dialog'
import { Button } from '../src/components/ui/button'
import { Toaster } from 'sonner'
if (!import.meta.env.DEV || location.hostname !== '127.0.0.1')
  throw Error('Local isolated acceptance only')
let settings: Record<string, unknown> = {
  proxy_enabled: false,
  custom_sources: [],
  source_overrides: [],
  default_source: 'google_satellite',
}
let callback = 0
const callbacks = new Map<number, unknown>()
const originalWindow = window as unknown as Record<string, unknown>
originalWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
}
originalWindow.__TAURI_INTERNALS__ = {
  transformCallback: (fn: unknown) => {
    callbacks.set(++callback, fn)
    return callback
  },
  unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'get_settings') return settings
    if (command === 'save_settings') {
      settings = args.settings as Record<string, unknown>
      return null
    }
    if (command === 'get_tile_sources' || command === 'get_builtin_sources')
      return {
        google_satellite: {
          id: 'google_satellite',
          name: 'Google 卫星',
          url: 'https://example.invalid/{z}/{x}/{y}.png',
          max_zoom: 20,
          subdomains: [],
        },
      }
    if (command.startsWith('plugin:dialog|'))
      return 'G:/code/tif-downloader/artifacts/foundation-20261106/ui-export.geojson'
    if (command.startsWith('plugin:event|')) return 1
    if (command === 'open_file_location') return null
    const route = (
      {
        foundation_preview: 'preview',
        foundation_cancel: 'cancel',
        foundation_export: 'export',
      } as Record<string, string>
    )[command]
    if (!route) throw Error(`Unsupported isolated command: ${command}`)
    const response = await fetch(`/__foundation_qa/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    })
    const data = await response.json()
    if (!data.ok) throw Error(data.error)
    return data.value
  },
}
await initializeI18n()
export function Harness() {
  const ref = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null)
  const [view, setView] = useState('')
  const [dark, setDark] = useState(false)
  const state = useFoundationStore()
  useEffect(() => {
    const m = L.map(ref.current!).setView([39.9, 116.4], 11)
    map.current = m
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri' },
    ).addTo(m)
    const remove = installFoundationLayers(m)
    const report = () =>
      setView(
        `${m.getCenter().lat.toFixed(6)},${m.getCenter().lng.toFixed(6)} / z${m.getZoom()}`,
      )
    m.on('moveend', report)
    report()
    return () => {
      remove()
      m.remove()
    }
  }, [])
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])
  return (
    <main
      className="h-screen bg-background text-foreground"
      style={{ display: 'grid', gridTemplateColumns: '400px minmax(0,1fr)' }}
    >
      <aside
        className="space-y-3 overflow-y-auto border-r p-4"
        aria-label="左侧基础要素"
      >
        <h1 className="font-semibold">本地功能验收</h1>
        <p className="text-xs text-muted-foreground">
          原生测试桥 → 真实 WFS → 实际渲染与 GeoJSON
          另存。不会修改用户设置或发布。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDark((v) => !v)}>
            深浅主题
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void changeAppLanguage('en-US')}
          >
            English
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void changeAppLanguage('zh-CN')}
          >
            中文
          </Button>
        </div>
        <SourcesDialog triggerLabel="图源管理" listenForActions={false} />
        <FoundationControls />
        <output className="block text-xs" data-qa-view>
          {view}
        </output>
        <pre
          className="max-h-44 overflow-auto whitespace-pre-wrap text-[10px]"
          data-qa-state
        >
          {JSON.stringify(
            {
              layers: Object.fromEntries(
                Object.entries(state.records).map(([id, r]) => [
                  id,
                  {
                    phase: r.phase,
                    count: r.data?.feature_count,
                    cache: r.data?.cache_hits,
                    bounds: r.data?.bounds,
                  },
                ]),
              ),
              export: state.exportState,
            },
            null,
            2,
          )}
        </pre>
      </aside>
      <section className="relative min-w-0">
        <div className="absolute inset-0" ref={ref} />
        <div className="absolute bottom-5 left-4 z-[10] flex gap-2">
          <Button
            onClick={() => map.current?.panBy([180, 0], { animate: false })}
          >
            向东平移
          </Button>
          <Button
            onClick={() => {
              map.current?.panBy([120, 0], { animate: false })
              setTimeout(
                () => map.current?.panBy([120, 0], { animate: false }),
                80,
              )
            }}
          >
            快速切换范围
          </Button>
        </div>
        <section
          className="absolute right-3 top-3 z-[10] w-52 rounded-md border bg-background p-3 shadow-md"
          aria-label="地图基础要素"
        >
          <FoundationControls compact />
        </section>
      </section>
      <Toaster />
    </main>
  )
}
const root = createRoot(document.getElementById('root')!)
root.render(
  <QueryClientProvider client={new QueryClient()}>
    <Harness />
  </QueryClientProvider>,
)
import.meta.hot?.dispose(() => root.unmount())
