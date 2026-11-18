import L from 'leaflet'
import { invokeCommand } from '@/lib/tauri'
import { useAppStore } from '@/store/app-store'
import { useFoundationStore } from '@/features/foundation/foundation-store'
import { shouldUseGcjCoordinates } from '@/features/foundation/model'
import { FoundationRasterLayer } from '@/features/foundation/raster-layer'
import type { fetchFoundationRaster } from '@/features/foundation/foundation-api'
import { useOsmPreviewStore } from './osm-preview-store'

export function installOsmPreview(map: L.Map) {
  const pane = map.getPane('geod-osm-preview') ?? map.createPane('geod-osm-preview')
  pane.style.zIndex = '451'
  pane.style.pointerEvents = 'none'
  const layers = new Map<string, { key: string; layer: FoundationRasterLayer }>()
  let attribution = false
  const credit = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>'
  function sync() {
    const app = useAppStore.getState()
    const gcj = shouldUseGcjCoordinates(useFoundationStore.getState().settings.coordinates, app.selectedSourceByMode[app.mode] ?? 'google_satellite')
    const visible = useOsmPreviewStore.getState().layers.filter(l => l.visible)
    const ids = new Set(visible.map(l => l.id))
    for (const [id, value] of layers) {
      if (!ids.has(id)) { value.layer.remove(); layers.delete(id) }
    }
    for (const entry of visible) {
      const key = JSON.stringify([entry.color, gcj])
      if (layers.get(entry.id)?.key === key) continue
      layers.get(entry.id)?.layer.remove()
      const loader: typeof fetchFoundationRaster = (requestId, config, coords) => invokeCommand('osm_preview_tile', { requestId, id: entry.id, config, ...coords })
      const layer = new FoundationRasterLayer({ layers: [{ layer: 'roads', color: entry.color, width: 2, labels: true }], font_size: 12, gcj, revision: 0 },
        async () => null, status => useOsmPreviewStore.getState().status(entry.id, status), loader, 'geod-osm-preview')
      // Register before addTo because Leaflet publishes tile status synchronously.
      layers.set(entry.id, { key, layer })
      layer.addTo(map)
    }
    if (Boolean(visible.length) !== attribution) {
      attribution = Boolean(visible.length)
      if (attribution) map.attributionControl.addAttribution(credit)
      else map.attributionControl.removeAttribution(credit)
    }
  }
  const stop = useOsmPreviewStore.subscribe((s, p) => {
    if (s.layers.length !== p.layers.length || s.layers.some((l, i) => l.id !== p.layers[i]?.id || l.visible !== p.layers[i]?.visible || l.color !== p.layers[i]?.color)) sync()
  })
  const stopBase = useAppStore.subscribe((s, p) => { if (s.mode !== p.mode || s.selectedSourceByMode !== p.selectedSourceByMode) sync() })
  const stopStyle = useFoundationStore.subscribe((s, p) => { if (s.settings.coordinates !== p.settings.coordinates) sync() })
  sync()
  return () => {
    stop(); stopBase(); stopStyle()
    for (const value of layers.values()) value.layer.remove()
    if (attribution) map.attributionControl.removeAttribution(credit)
  }
}
