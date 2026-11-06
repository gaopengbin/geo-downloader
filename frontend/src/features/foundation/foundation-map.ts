import L from 'leaflet'
import { useAppStore } from '@/store/app-store'
import { useFoundationStore } from './foundation-store'
import {
  FOUNDATION_IDS,
  MIN_FOUNDATION_ZOOM,
  foundationQueryBounds,
  shouldUseGcjCoordinates,
  type LayerRecord,
} from './model'
import { gcjBoundsToWgs } from './coordinates'
import { foundationProxy, type RasterConfig } from './foundation-api'
import { FoundationRasterLayer, type RasterStatus } from './raster-layer'

const ATTRIBUTION =
  '基础要素 © <a href="https://www.tianditu.gov.cn/" target="_blank" rel="noreferrer">国家基础地理信息中心 / 天地图</a>'
/** This controller only owns an image grid. All geographic and glyph work runs natively. */
export function installFoundationLayers(
  map: L.Map,
  onMeasure?: (sample: {
    durationMs: number
    kind: 'images'
    images: number
  }) => void,
) {
  const pane =
    map.getPane('geod-foundation') ?? map.createPane('geod-foundation')
  pane.style.zIndex = '450'
  pane.style.pointerEvents = 'none'
  let layer: FoundationRasterLayer | undefined,
    signature = '',
    generation = 0,
    closed = false,
    attribution = false
  let status: RasterStatus = {
    loaded: 0,
    pending: 0,
    failed: 0,
    cached: 0,
    fontMissing: false,
    error: null,
  }
  let frame: number | undefined
  let proxyRequest: Promise<string | null> | undefined
  const proxy = () =>
    proxyRequest ??
    (proxyRequest = foundationProxy().finally(() => {
      proxyRequest = undefined
    }))
  const gcj = () => {
    const state = useAppStore.getState()
    return shouldUseGcjCoordinates(
      useFoundationStore.getState().settings.coordinates,
      state.selectedSourceByMode[state.mode] ?? 'google_satellite',
    )
  }
  function publishViewport() {
    if (closed) return
    const view = map.getBounds(),
      zoom = map.getZoom()
    let bounds = {
      west: view.getWest(),
      south: view.getSouth(),
      east: view.getEast(),
      north: view.getNorth(),
    }
    if (gcj()) bounds = gcjBoundsToWgs(bounds)
    useFoundationStore
      .getState()
      .setViewport(
        zoom >= MIN_FOUNDATION_ZOOM && foundationQueryBounds(bounds, zoom)
          ? { bounds, zoom }
          : null,
      )
    scheduleStatus()
  }
  function scheduleStatus() {
    if (closed || frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (closed) return
      const started = performance.now(),
        state = useFoundationStore.getState(),
        zoom = map.getZoom()
      const view = map.getBounds()
      const valid =
        foundationQueryBounds(
          {
            west: view.getWest(),
            south: view.getSouth(),
            east: view.getEast(),
            north: view.getNorth(),
          },
          zoom,
        ) !== null
      const records = Object.fromEntries(
        FOUNDATION_IDS.map((id) => {
          let record: LayerRecord
          if (!state.settings.layers[id].visible)
            record = { phase: 'off', error: null }
          else if (zoom < MIN_FOUNDATION_ZOOM)
            record = { phase: 'zoom', error: null }
          else if (!valid) record = { phase: 'error', error: 'boundsError' }
          else
            record = {
              phase:
                status.pending > 0
                  ? 'loading'
                  : status.failed > 0
                    ? 'error'
                    : status.loaded > 0
                      ? 'ready'
                      : 'loading',
              error:
                status.error ?? (status.fontMissing ? 'fontMissing' : null),
              tiles: status.loaded,
              pending: status.pending,
              cached: status.cached,
            }
          return [id, record]
        }),
      ) as typeof state.records
      useFoundationStore.setState({ records })
      onMeasure?.({
        durationMs: performance.now() - started,
        kind: 'images',
        images: status.loaded,
      })
    })
  }
  function configure() {
    if (closed) return
    const { settings, refresh } = useFoundationStore.getState()
    const config: RasterConfig = {
      font_size: settings.fontSize,
      gcj: gcj(),
      revision: refresh,
      layers: FOUNDATION_IDS.filter((id) => settings.layers[id].visible).map(
        (id) => ({
          layer: id,
          color: settings.layers[id].color,
          width: settings.layers[id].width,
          labels: settings.layers[id].labels,
        }),
      ),
    }
    const key = JSON.stringify(config)
    if (key === signature) return
    signature = key
    const current = ++generation
    layer?.remove()
    layer = undefined
    status = {
      loaded: 0,
      pending: 0,
      failed: 0,
      cached: 0,
      fontMissing: false,
      error: null,
    }
    if (config.layers.length) {
      layer = new FoundationRasterLayer(config, proxy, (value) => {
        if (!closed && generation === current) {
          status = value
          scheduleStatus()
        }
      })
      layer.addTo(map)
    }
    const enabled = config.layers.length > 0
    if (enabled !== attribution) {
      if (enabled) map.attributionControl.addAttribution(ATTRIBUTION)
      else map.attributionControl.removeAttribution(ATTRIBUTION)
      attribution = enabled
    }
    publishViewport()
  }
  function moving() {
    useFoundationStore.getState().setViewport(null)
  }
  const unsubscribe = useFoundationStore.subscribe((state, previous) => {
    if (
      state.settings !== previous.settings ||
      state.refresh !== previous.refresh
    )
      configure()
  })
  const unsubscribeBase = useAppStore.subscribe((state, previous) => {
    if (
      state.mode !== previous.mode ||
      state.selectedSourceByMode !== previous.selectedSourceByMode
    )
      configure()
  })
  map.on('movestart zoomstart', moving)
  map.on('moveend zoomend resize', publishViewport)
  configure()
  return () => {
    closed = true
    generation++
    unsubscribe()
    unsubscribeBase()
    if (frame !== undefined) cancelAnimationFrame(frame)
    layer?.remove()
    map.off('movestart zoomstart', moving)
    map.off('moveend zoomend resize', publishViewport)
    if (attribution) map.attributionControl.removeAttribution(ATTRIBUTION)
    useFoundationStore.getState().setViewport(null)
  }
}
