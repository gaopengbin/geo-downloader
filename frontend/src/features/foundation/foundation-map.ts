import L from 'leaflet'
import { useAppStore } from '@/store/app-store'
import { i18n } from '@/i18n'
import { useFoundationStore } from './foundation-store'
import {
  FOUNDATION_IDS,
  MIN_FOUNDATION_ZOOM,
  boundsKey,
  foundationQueryBounds,
  shouldUseGcjCoordinates,
  type FoundationId,
  type FoundationPreview,
  type LayerStyle,
} from './model'
import { wgsToGcj, gcjBoundsToWgs } from './coordinates'
import {
  cancelFoundation,
  fetchFoundation,
  foundationProxy,
  foundationErrorKey,
} from './foundation-api'
import {
  createFoundationLabels,
  type LabelCandidate,
} from './foundation-labels'
import { forEachFrame } from './frame-batch'

export interface FoundationRenderMeasurement {
  durationMs: number
  features: number
  labels: number
  kind?: 'geometry' | 'labels' | 'style' | 'clear'
}
const ATTRIBUTION =
  '基础要素 © <a href="https://www.tianditu.gov.cn/" target="_blank" rel="noreferrer">国家基础地理信息中心 / 天地图</a>'
const LABEL_ORDER: FoundationId[] = [
  'settlements',
  'railways',
  'roads',
  'water',
]

/** Geometry is retained across pans. Only new data is built, in cancellable frame batches. */
export function installFoundationLayers(
  map: L.Map,
  onMeasure?: (sample: FoundationRenderMeasurement) => void,
) {
  const pane =
    map.getPane('geod-foundation') ?? map.createPane('geod-foundation')
  pane.style.zIndex = '450'
  pane.style.pointerEvents = 'none'
  const renderer = L.canvas({ pane: 'geod-foundation' })
  const labelPane =
    map.getPane('geod-foundation-labels') ??
    map.createPane('geod-foundation-labels')
  labelPane.style.zIndex = '460'
  labelPane.style.pointerEvents = 'none'
  const labelCanvas = createFoundationLabels(map, labelPane)
  interface Prepared {
    layer: L.GeoJSON
    data: FoundationPreview
    shifted: boolean
    style: string
    candidates: LabelCandidate[]
  }
  interface Job {
    layer: L.GeoJSON
    data: FoundationPreview
    shifted: boolean
    cancelled: boolean
  }
  const rendered = new Map<FoundationId, Prepared>()
  const jobs = new Map<FoundationId, Job>()
  const pending = new Map<FoundationId, { id: string; key: string }>()
  const applied = new Map<FoundationId, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame: number | undefined
  let closed = false,
    moving = false,
    attribution = false
  let refresh = useFoundationStore.getState().refresh
  let labelKey = ''
  let labelData: unknown[] = []
  const gcj = () => {
    const state = useAppStore.getState()
    return shouldUseGcjCoordinates(
      useFoundationStore.getState().settings.coordinates,
      state.selectedSourceByMode[state.mode] ?? 'google_satellite',
    )
  }
  const nextFrame = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  const measure = (
    started: number,
    kind: FoundationRenderMeasurement['kind'],
    features = 0,
    labels = 0,
  ) =>
    onMeasure?.({
      durationMs: performance.now() - started,
      kind,
      features,
      labels,
    })
  function stop(id: FoundationId) {
    const request = pending.get(id)
    if (request) {
      pending.delete(id)
      void cancelFoundation(request.id)
    }
  }
  function stopJob(id: FoundationId) {
    const job = jobs.get(id)
    if (job) {
      job.cancelled = true
      job.layer.remove()
      jobs.delete(id)
    }
  }
  function clear(id: FoundationId) {
    stopJob(id)
    const previous = rendered.get(id)
    if (previous) {
      const started = performance.now()
      previous.layer.remove()
      rendered.delete(id)
      measure(started, 'clear')
    }
  }
  const pathStyle = (id: FoundationId, style: LayerStyle): L.PathOptions => ({
    renderer,
    color: style.color,
    weight: style.width,
    opacity: 0.95,
    fillOpacity: 0.12,
    dashArray: id === 'railways' ? '8 3' : undefined,
    interactive: false,
  })
  async function prepare(
    id: FoundationId,
    data: FoundationPreview,
    shifted: boolean,
  ) {
    stopJob(id)
    const candidates: LabelCandidate[] = []
    const style = useFoundationStore.getState().settings.layers[id]
    const layer = L.geoJSON(undefined, {
      pane: 'geod-foundation',
      interactive: false,
      coordsToLatLng: (coordinates) => {
        const [lng, lat] = shifted
          ? wgsToGcj(coordinates[0], coordinates[1])
          : [coordinates[0], coordinates[1]]
        return L.latLng(lat, lng)
      },
      style: () => pathStyle(id, style),
      pointToLayer: (_feature, latlng) =>
        L.circleMarker(latlng, {
          ...pathStyle(id, style),
          pane: 'geod-foundation',
          radius: style.width + 1,
          weight: 1,
          fillColor: style.color,
          fillOpacity: 0.95,
        }),
      onEachFeature: (feature) => {
        if (feature.geometry)
          candidates.push({
            geometry: feature.geometry,
            properties: feature.properties,
          })
      },
    }).addTo(map)
    const job: Job = { layer, data, shifted, cancelled: false }
    jobs.set(id, job)
    try {
      const complete = await forEachFrame(
        data.geojson.features,
        (feature) => layer.addData(feature),
        () => closed || job.cancelled || moving,
        {
          nextFrame,
          now: () => performance.now(),
          report: (durationMs, features) =>
            onMeasure?.({ durationMs, features, labels: 0, kind: 'geometry' }),
        },
      )
      if (!complete || jobs.get(id) !== job) {
        layer.remove()
        return
      }
      jobs.delete(id)
      const previous = rendered.get(id)
      if (previous) {
        const started = performance.now()
        previous.layer.remove()
        measure(started, 'clear')
      }
      rendered.set(id, {
        layer,
        data,
        shifted,
        style: JSON.stringify([style.color, style.width]),
        candidates,
      })
      scheduleRender()
    } catch (error) {
      layer.remove()
      if (jobs.get(id) !== job || closed) return
      jobs.delete(id)
      console.warn('[foundation] geometry render failed', error)
      useFoundationStore
        .getState()
        .setRecord(id, { phase: 'error', data: null, error: 'responseError' })
    }
  }
  function* candidates() {
    const { settings } = useFoundationStore.getState()
    for (const id of LABEL_ORDER) {
      if (settings.layers[id].visible && settings.layers[id].labels) {
        const item = rendered.get(id)
        if (item) yield* item.candidates
      }
    }
  }
  function render() {
    frame = undefined
    if (closed || moving) return
    const { settings, records } = useFoundationStore.getState(),
      shifted = gcj()
    const enabled = FOUNDATION_IDS.some((id) => settings.layers[id].visible)
    if (enabled !== attribution) {
      if (enabled) map.attributionControl.addAttribution(ATTRIBUTION)
      else map.attributionControl.removeAttribution(ATTRIBUTION)
      attribution = enabled
    }
    for (const id of FOUNDATION_IDS) {
      const style = settings.layers[id],
        record = records[id],
        previous = rendered.get(id)
      if (!style.visible || !record.data) {
        clear(id)
        continue
      }
      if (previous?.data === record.data && previous.shifted === shifted) {
        const signature = JSON.stringify([style.color, style.width])
        if (signature !== previous.style) {
          const started = performance.now()
          previous.layer.setStyle(pathStyle(id, style))
          previous.layer.eachLayer((item) => {
            if (item instanceof L.CircleMarker)
              item
                .setRadius(style.width + 1)
                .setStyle({ fillColor: style.color })
          })
          previous.style = signature
          measure(started, 'style', previous.layer.getLayers().length)
        }
      } else if (record.phase === 'ready') {
        const job = jobs.get(id)
        if (job?.data !== record.data || job.shifted !== shifted)
          void prepare(id, record.data, shifted)
      }
    }
    const key = JSON.stringify([
      map.getBounds().toBBoxString(),
      map.getZoom(),
      settings.fontSize,
      shifted,
      FOUNDATION_IDS.map((id) => [
        settings.layers[id].visible,
        settings.layers[id].labels,
      ]),
    ])
    const data = FOUNDATION_IDS.map((id) => rendered.get(id)?.data)
    if (
      key !== labelKey ||
      data.some((value, index) => value !== labelData[index])
    ) {
      labelKey = key
      labelData = data
      void labelCanvas
        .draw(
          map.getZoom() >= MIN_FOUNDATION_ZOOM ? candidates() : [],
          settings.fontSize,
          shifted,
          (durationMs, labels) =>
            onMeasure?.({ durationMs, labels, features: 0, kind: 'labels' }),
        )
        .catch((error) =>
          console.warn('[foundation] label rendering failed', error),
        )
    }
  }
  function scheduleRender() {
    if (!closed && frame === undefined) frame = requestAnimationFrame(render)
  }
  async function load() {
    if (closed || moving) return
    const state = useFoundationStore.getState(),
      b = map.getBounds(),
      zoom = map.getZoom()
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
    state.setViewport(
      query && zoom >= MIN_FOUNDATION_ZOOM ? { bounds, zoom } : null,
    )
    const key = query ? boundsKey(query) + ':' + state.refresh : ''
    for (const id of FOUNDATION_IDS) {
      const current = useFoundationStore.getState(),
        record = current.records[id]
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
      if (
        pending.get(id)?.key === key ||
        (record.phase === 'ready' && applied.get(id) === key)
      )
        continue
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
          useFoundationStore.getState().setRecord(id, {
            phase: 'error',
            data: null,
            error: foundationErrorKey(error),
          })
        })
    }
    scheduleRender()
  }
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void load(), 350)
    scheduleRender()
  }
  function invalidate() {
    moving = true
    labelCanvas.cancel()
    labelKey = ''
    for (const id of FOUNDATION_IDS) {
      stop(id)
      stopJob(id)
    }
    useFoundationStore.getState().setViewport(null)
  }
  function moved() {
    moving = false
    schedule()
  }
  const unsubscribe = useFoundationStore.subscribe((state, previous) => {
    if (
      state.settings !== previous.settings ||
      state.refresh !== previous.refresh
    )
      schedule()
    else if (state.records !== previous.records) scheduleRender()
  })
  const unsubscribeBase = useAppStore.subscribe((state, previous) => {
    if (
      state.mode !== previous.mode ||
      state.selectedSourceByMode !== previous.selectedSourceByMode
    )
      schedule()
  })
  const language = () => scheduleRender()
  i18n.on('languageChanged', language)
  map.on('movestart zoomstart', invalidate)
  map.on('moveend zoomend', moved)
  map.on('resize', scheduleRender)
  void load()
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    if (frame !== undefined) cancelAnimationFrame(frame)
    unsubscribe()
    unsubscribeBase()
    i18n.off('languageChanged', language)
    map.off('movestart zoomstart', invalidate)
    map.off('moveend zoomend', moved)
    map.off('resize', scheduleRender)
    for (const id of FOUNDATION_IDS) {
      stop(id)
      clear(id)
    }
    labelCanvas.remove()
    renderer.remove()
    if (attribution) map.attributionControl.removeAttribution(ATTRIBUTION)
  }
}
