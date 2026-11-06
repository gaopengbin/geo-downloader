import L from 'leaflet'
import { useAppStore } from '@/store/app-store'
import { i18n } from '@/i18n'
import { useFoundationStore } from './foundation-store'
import {
  FOUNDATION_IDS,
  MIN_FOUNDATION_ZOOM,
  boundsKey,
  foundationQueryBounds,
  featureLabel,
  shouldUseGcjCoordinates,
  type FoundationId,
  type LayerStyle,
} from './model'
import { wgsToGcj, gcjBoundsToWgs } from './coordinates'
import {
  cancelFoundation,
  fetchFoundation,
  foundationProxy,
  foundationErrorKey,
} from './foundation-api'

/** One owner per map. Data updates never fit bounds or move the camera. */
export function installFoundationLayers(map: L.Map) {
  const pane =
    map.getPane('geod-foundation') ?? map.createPane('geod-foundation')
  pane.style.zIndex = '395'
  pane.style.pointerEvents = 'none'
  const renderer = L.canvas({ pane: 'geod-foundation' })
  const rendered = new Map<
    FoundationId,
    { layer: L.GeoJSON; labels: L.LayerGroup; data: unknown; style: string }
  >()
  const pending = new Map<FoundationId, { id: string; key: string }>()
  const applied = new Map<FoundationId, string>()
  let renderKey = ''
  let timer: ReturnType<typeof setTimeout> | undefined,
    closed = false
  let refresh = useFoundationStore.getState().refresh
  let attribution = false
  const base = () => {
    const s = useAppStore.getState()
    return s.selectedSourceByMode[s.mode] ?? 'google_satellite'
  }
  const gcj = () =>
    shouldUseGcjCoordinates(
      useFoundationStore.getState().settings.coordinates,
      base(),
    )
  const labelPane =
    map.getPane('geod-foundation-labels') ??
    map.createPane('geod-foundation-labels')
  labelPane.style.zIndex = '396'
  labelPane.style.pointerEvents = 'none'
  function clear(id: FoundationId) {
    const current = rendered.get(id)
    if (current) {
      current.labels.remove()
      current.layer.remove()
      rendered.delete(id)
    }
  }
  function stop(id: FoundationId) {
    const current = pending.get(id)
    if (current) {
      pending.delete(id)
      void cancelFoundation(current.id)
    }
  }
  function render() {
    if (closed) return
    const { settings, records } = useFoundationStore.getState()
    const shifted = gcj()
    const zoom = map.getZoom()
    const signature = JSON.stringify([
      settings,
      shifted,
      Math.floor(zoom),
      map.getBounds().toBBoxString(),
    ])
    if (
      signature === renderKey &&
      FOUNDATION_IDS.every(
        (id) =>
          !settings.layers[id].visible ||
          rendered.get(id)?.data === records[id].data,
      )
    )
      return
    renderKey = signature
    const enabled = FOUNDATION_IDS.some((id) => settings.layers[id].visible)
    if (enabled !== attribution) {
      const text =
        '基础要素 © <a href="https://www.tianditu.gov.cn/" target="_blank" rel="noreferrer">国家基础地理信息中心 / 天地图</a>'
      if (enabled) map.attributionControl.addAttribution(text)
      else map.attributionControl.removeAttribution(text)
      attribution = enabled
    }
    // Rebuild labels together so names from different reference layers also avoid one another.
    // Point names have priority; geometry itself retains its independent style and visibility.
    const occupied = new Set<string>()
    let labels = 0
    for (const id of ['settlements', 'railways', 'roads', 'water'] as const) {
      const style: LayerStyle = settings.layers[id],
        record = records[id]
      if (!style.visible || !record.data) {
        clear(id)
        continue
      }
      clear(id)
      const labelGroup = L.layerGroup()
      const view = map.getBounds()
      const layer = L.geoJSON(record.data.geojson, {
        pane: 'geod-foundation',
        interactive: false,
        coordsToLatLng: (coordinates) => {
          const [lng, lat] = shifted
            ? wgsToGcj(coordinates[0], coordinates[1])
            : [coordinates[0], coordinates[1]]
          return L.latLng(lat, lng)
        },
        style: () => ({
          renderer,
          color: style.color,
          weight: style.width,
          opacity: 0.95,
          fillOpacity: 0.12,
          dashArray: id === 'railways' ? '8 3' : undefined,
          interactive: false,
        }),
        pointToLayer: (_feature, latlng) =>
          L.circleMarker(latlng, {
            renderer,
            pane: 'geod-foundation',
            radius: style.width + 1,
            color: style.color,
            weight: 1,
            fillColor: style.color,
            fillOpacity: 0.95,
            interactive: false,
          }),
        onEachFeature: (feature) => {
          const text = featureLabel(feature.properties)
          if (
            !style.labels ||
            !text ||
            zoom < MIN_FOUNDATION_ZOOM ||
            labels >= 250
          )
            return
          let point: L.LatLng | undefined
          function find(value: unknown) {
            if (point || !Array.isArray(value)) return
            if (typeof value[0] === 'number' && typeof value[1] === 'number') {
              const [x, y] = shifted
                ? wgsToGcj(value[0], value[1])
                : [value[0], value[1]]
              const p = L.latLng(y, x)
              if (view.contains(p)) point = p
            } else
              for (const child of value) {
                find(child)
                if (point) break
              }
          }
          if (feature.geometry && 'coordinates' in feature.geometry)
            find(feature.geometry.coordinates)
          if (!point) return
          const pixel = map.latLngToContainerPoint(point)
          const width =
            [...text].reduce(
              (n, c) => n + ((c.codePointAt(0) ?? 0) > 255 ? 1 : 0.6),
              0,
            ) *
              settings.fontSize +
            10
          const cells: string[] = []
          for (
            let x = Math.floor((pixel.x - width / 2) / 25);
            x <= Math.floor((pixel.x + width / 2) / 25);
            x++
          )
            for (
              let y = Math.floor((pixel.y - settings.fontSize - 8) / 20);
              y <= Math.floor(pixel.y / 20);
              y++
            )
              cells.push(`${x}:${y}`)
          if (cells.some((k) => occupied.has(k))) return
          cells.forEach((k) => occupied.add(k))
          labels++
          const span = document.createElement('span')
          span.textContent = text
          span.style.fontSize = `${settings.fontSize}px`
          L.tooltip({
            pane: 'geod-foundation-labels',
            permanent: true,
            direction: 'top',
            className: 'geod-foundation-label',
            interactive: false,
            opacity: 1,
            offset: [0, -3],
          })
            .setLatLng(point)
            .setContent(span)
            .addTo(labelGroup)
        },
      }).addTo(map)
      labelGroup.addTo(map)
      rendered.set(id, {
        layer,
        labels: labelGroup,
        data: record.data,
        style: signature,
      })
    }
  }
  async function load() {
    if (closed) return
    const state = useFoundationStore.getState()
    const b = map.getBounds()
    const zoom = map.getZoom()
    const forced = refresh !== state.refresh
    refresh = state.refresh
    let proxy: Promise<string | null> | undefined
    let bounds = {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    }
    if (gcj()) bounds = gcjBoundsToWgs(bounds)
    const query = foundationQueryBounds(bounds, zoom)
    state.setViewport(query && zoom >= MIN_FOUNDATION_ZOOM ? { bounds, zoom } : null)
    const key = query ? `${boundsKey(query)}:${state.refresh}` : ''
    for (const id of FOUNDATION_IDS) {
      const current = useFoundationStore.getState()
      const record = current.records[id]
      if (!current.settings.layers[id].visible) {
        stop(id)
        if (record.phase !== 'off')
          current.setRecord(id, { ...record, phase: 'off' })
        continue
      }
      if (!query || zoom < MIN_FOUNDATION_ZOOM) {
        stop(id)
        current.setRecord(id, {
          phase: zoom < MIN_FOUNDATION_ZOOM ? 'zoom' : 'error',
          data: null,
          error: zoom < MIN_FOUNDATION_ZOOM ? null : 'boundsError',
        })
        continue
      }
      if (pending.get(id)?.key === key) continue
      if (record.phase === 'ready' && applied.get(id) === key) continue
      stop(id)
      const requestId = crypto.randomUUID()
      pending.set(id, { id: requestId, key })
      current.setRecord(id, { ...record, phase: 'loading', error: null })
      void (proxy ??= foundationProxy())
        .then((proxy) => {
          if (closed || pending.get(id)?.id !== requestId)
            throw Error('FOUNDATION_CANCELLED')
          return fetchFoundation(requestId, id, query, proxy, forced)
        })
        .then((data) => {
          if (closed || pending.get(id)?.id !== requestId) return
          pending.delete(id)
          applied.set(id, key)
          useFoundationStore
            .getState()
            .setRecord(id, { phase: 'ready', data, error: null })
        })
        .catch((error) => {
          if (closed || pending.get(id)?.id !== requestId) return
          pending.delete(id)
          useFoundationStore
            .getState()
            .setRecord(id, {
              data: null,
              phase: 'error',
              error: foundationErrorKey(error),
            })
        })
    }
    render()
  }
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void load(), 350)
    render()
  }
  function invalidate() {
    for (const id of FOUNDATION_IDS) stop(id)
    useFoundationStore.getState().setViewport(null)
  }
  const unsubscribe = useFoundationStore.subscribe((state, previous) => {
    if (
      state.settings !== previous.settings ||
      state.refresh !== previous.refresh
    )
      schedule()
    else if (state.records !== previous.records) render()
  })
  const unsubscribeBase = useAppStore.subscribe((state, previous) => {
    if (
      state.mode !== previous.mode ||
      state.selectedSourceByMode !== previous.selectedSourceByMode
    )
      schedule()
  })
  const language = () => render()
  i18n.on('languageChanged', language)
  map.on('movestart', invalidate)
  map.on('moveend', schedule)
  map.on('zoomend', schedule)
  void load()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    unsubscribe()
    unsubscribeBase()
    i18n.off('languageChanged', language)
    map.off('movestart', invalidate)
    map.off('moveend', schedule)
    map.off('zoomend', schedule)
    for (const id of FOUNDATION_IDS) {
      stop(id)
      clear(id)
    }
    if (attribution)
      map.attributionControl.removeAttribution(
        '基础要素 © <a href="https://www.tianditu.gov.cn/" target="_blank" rel="noreferrer">国家基础地理信息中心 / 天地图</a>',
      )
  }
}
