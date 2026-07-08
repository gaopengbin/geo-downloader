import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet-draw'
import '@maplibre/maplibre-gl-leaflet'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useQuery } from '@tanstack/react-query'

import 'leaflet/dist/leaflet.css'
import 'leaflet-draw/dist/leaflet.draw.css'

import {
  useSelectionStore,
  type LatLngRing,
  type MapBounds,
} from '@/store/selection-store'
import { useAppStore, type AppMode } from '@/store/app-store'
import { useVectorLayersStore } from '@/store/vector-layers-store'
import { useWaybackStore } from '@/store/wayback-store'
import { getSettings } from '@/features/settings/settings-api'
import { getTileSourcesMerged } from '@/features/sources/sources-api'
import {
  buildWaybackTileUrl,
  getWaybackVersions,
  startWaybackTileProxy,
} from '@/features/wayback/wayback-api'
import type { TileSource } from '@/types/api'
import { createCachedTileLayer } from '@/features/map/cached-tile-layer'
import { isMvtUrl } from '@/features/mvt/is-mvt-url'
import { discoverLayers as discoverMvtLayers, buildStyle as buildMvtStyle } from '@/features/mvt/mvt-style'

// 修复 Leaflet 默认图标路径
const iconRetinaUrl = new URL(
  'leaflet/dist/images/marker-icon-2x.png',
  import.meta.url,
).href
const iconUrl = new URL('leaflet/dist/images/marker-icon.png', import.meta.url).href
const shadowUrl = new URL('leaflet/dist/images/marker-shadow.png', import.meta.url).href
// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl })

// 修复 leaflet-draw 1.0.4 的 readableArea ReferenceError(type is not defined)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(L as any).GeometryUtil = (L as any).GeometryUtil || {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(L as any).GeometryUtil.readableArea = function (area: number) {
  if (area >= 1_000_000) return (area / 1_000_000).toFixed(2) + ' km²'
  if (area >= 10_000) return (area / 10_000).toFixed(2) + ' ha'
  return area.toFixed(0) + ' m²'
}

function boundsFromRings(rings: LatLngRing[]): MapBounds | null {
  if (rings.length === 0) return null
  let n = -Infinity
  let s = Infinity
  let e = -Infinity
  let w = Infinity
  for (const ring of rings) {
    for (const p of ring) {
      if (p.lat > n) n = p.lat
      if (p.lat < s) s = p.lat
      if (p.lng > e) e = p.lng
      if (p.lng < w) w = p.lng
    }
  }
  return { north: n, south: s, east: e, west: w }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fillTileUrl(template: string, coords: { z: number; x: number; y: number }) {
  return template
    .replace('{z}', String(coords.z))
    .replace('{x}', String(coords.x))
    .replace('{y}', String(coords.y))
}

function installClickPinnedLayersControl(
  container: HTMLElement,
  toggle: HTMLElement | null | undefined,
) {
  L.DomEvent.disableClickPropagation(container)
  L.DomEvent.disableScrollPropagation(container)

  const expand = () => {
    L.DomUtil.addClass(container, 'leaflet-control-layers-expanded')
  }
  const collapse = () => {
    L.DomUtil.removeClass(container, 'leaflet-control-layers-expanded')
  }
  const isExpanded = () =>
    L.DomUtil.hasClass(container, 'leaflet-control-layers-expanded')

  const onToggleClick = (e: Event) => {
    L.DomEvent.preventDefault(e)
    L.DomEvent.stopPropagation(e)
    if (isExpanded()) collapse()
    else expand()
  }
  const onToggleKeyDown = (e: Event) => {
    if (!(e instanceof KeyboardEvent)) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    onToggleClick(e)
  }
  const onDocumentPointerDown = (e: PointerEvent) => {
    const target = e.target
    if (target instanceof Node && container.contains(target)) return
    collapse()
  }
  const onEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') collapse()
  }

  if (toggle) {
    L.DomEvent.on(toggle, 'click', onToggleClick)
    L.DomEvent.on(toggle, 'keydown', onToggleKeyDown)
  }
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onEscape, true)

  return () => {
    if (toggle) {
      L.DomEvent.off(toggle, 'click', onToggleClick)
      L.DomEvent.off(toggle, 'keydown', onToggleKeyDown)
    }
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)
    document.removeEventListener('keydown', onEscape, true)
    collapse()
  }
}

function probeImageUrl(url: string, timeoutMs = 4500): Promise<boolean> {
  if (typeof Image === 'undefined') return Promise.resolve(false)
  return new Promise((resolve) => {
    const img = new Image()
    img.referrerPolicy = 'no-referrer'
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      img.onload = null
      img.onerror = null
      resolve(ok)
    }
    const timer = window.setTimeout(() => finish(false), timeoutMs)
    img.onload = () => finish(true)
    img.onerror = () => finish(false)
    img.src = url
  })
}

const MAP_VIEW_STORAGE_KEY = 'geo-downloader:map-view'
const GRATICULE_INTERVALS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30]
const MAX_GRATICULE_LINES = 160

interface PersistedMapView {
  center: { lat: number; lng: number }
  zoom: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readPersistedMapView(): PersistedMapView | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(MAP_VIEW_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedMapView>
    if (
      !parsed.center ||
      !isFiniteNumber(parsed.center.lat) ||
      !isFiniteNumber(parsed.center.lng) ||
      !isFiniteNumber(parsed.zoom)
    ) {
      return null
    }
    if (parsed.center.lat < -90 || parsed.center.lat > 90) return null
    if (parsed.center.lng < -180 || parsed.center.lng > 180) return null
    if (parsed.zoom < 0 || parsed.zoom > 24) return null
    return { center: parsed.center, zoom: parsed.zoom }
  } catch {
    return null
  }
}

function writePersistedMapView(view: PersistedMapView) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify(view))
  } catch {
    // localStorage may be unavailable in restricted environments.
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function normalizeLng(value: number) {
  let next = value
  while (next < -180) next += 360
  while (next > 180) next -= 360
  return next
}

function snapDown(value: number, interval: number) {
  return Math.floor(value / interval) * interval
}

function snapUp(value: number, interval: number) {
  return Math.ceil(value / interval) * interval
}

function trimDegree(value: number) {
  const rounded = Math.round(value * 10000) / 10000
  if (Math.abs(rounded - Math.round(rounded)) < 0.00001) return String(Math.round(rounded))
  return String(rounded).replace(/\.?0+$/, '')
}

function formatLngLabel(lng: number) {
  const normalized = normalizeLng(lng)
  if (Math.abs(normalized) < 0.00001) return '0°'
  return `${trimDegree(Math.abs(normalized))}°${normalized > 0 ? 'E' : 'W'}`
}

function formatLatLabel(lat: number) {
  if (Math.abs(lat) < 0.00001) return '0°'
  return `${trimDegree(Math.abs(lat))}°${lat > 0 ? 'N' : 'S'}`
}

function graticuleLabelHtml(text: string) {
  return `<span style="
    display:inline-block;
    color:rgba(15,23,42,.72);
    font:600 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    letter-spacing:0;
    text-shadow:
      0 1px 0 rgba(255,255,255,.98),
      1px 0 0 rgba(255,255,255,.98),
      0 -1px 0 rgba(255,255,255,.98),
      -1px 0 0 rgba(255,255,255,.98),
      1px 1px 0 rgba(255,255,255,.96),
      -1px 1px 0 rgba(255,255,255,.96),
      1px -1px 0 rgba(255,255,255,.96),
      -1px -1px 0 rgba(255,255,255,.96),
      0 0 4px rgba(255,255,255,.9);
    white-space:nowrap;
  ">${escapeHtml(text)}</span>`
}

function drawGraticuleLayer(
  map: L.Map,
  group: L.LayerGroup,
  requestedInterval: number,
) {
  group.clearLayers()
  const bounds = map.getBounds()
  const west = clamp(bounds.getWest(), -180, 180)
  const east = clamp(bounds.getEast(), -180, 180)
  const south = clamp(bounds.getSouth(), -85, 85)
  const north = clamp(bounds.getNorth(), -85, 85)
  if (east <= west || north <= south) return requestedInterval

  let interval = requestedInterval
  let lineCount = Math.ceil((east - west) / interval) + Math.ceil((north - south) / interval)
  while (lineCount > MAX_GRATICULE_LINES) {
    interval *= 2
    lineCount = Math.ceil((east - west) / interval) + Math.ceil((north - south) / interval)
  }

  const haloStyle: L.PolylineOptions = {
    color: '#ffffff',
    weight: 3,
    opacity: 0.55,
    dashArray: '4 6',
    interactive: false,
  }
  const lineStyle: L.PolylineOptions = {
    color: '#334155',
    weight: 1,
    opacity: 0.48,
    dashArray: '4 6',
    interactive: false,
  }
  const labelIcon = (text: string) =>
    L.divIcon({
      className: 'geod-graticule-label',
      html: graticuleLabelHtml(text),
      iconSize: [1, 1],
      iconAnchor: [0, 9],
    })

  const labelLat = south + (north - south) * 0.06
  const labelLng = west + (east - west) * 0.02
  const startLng = snapUp(west, interval)
  const endLng = snapDown(east, interval)
  for (let lng = startLng; lng <= endLng + interval * 0.001; lng += interval) {
    const roundedLng = Math.round(lng * 1000000) / 1000000
    const line: L.LatLngExpression[] = [
      [south, roundedLng],
      [north, roundedLng],
    ]
    L.polyline(line, haloStyle).addTo(group)
    L.polyline(
      [
        [south, roundedLng],
        [north, roundedLng],
      ],
      lineStyle,
    ).addTo(group)
    L.marker([labelLat, roundedLng], {
      icon: labelIcon(formatLngLabel(roundedLng)),
      interactive: false,
      keyboard: false,
    }).addTo(group)
  }

  const startLat = snapUp(south, interval)
  const endLat = snapDown(north, interval)
  for (let lat = startLat; lat <= endLat + interval * 0.001; lat += interval) {
    const roundedLat = Math.round(lat * 1000000) / 1000000
    const line: L.LatLngExpression[] = [
      [roundedLat, west],
      [roundedLat, east],
    ]
    L.polyline(line, haloStyle).addTo(group)
    L.polyline(
      [
        [roundedLat, west],
        [roundedLat, east],
      ],
      lineStyle,
    ).addTo(group)
    L.marker([roundedLat, labelLng], {
      icon: labelIcon(formatLatLabel(roundedLat)),
      interactive: false,
      keyboard: false,
    }).addTo(group)
  }

  return interval
}

export function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const drawnRef = useRef<L.FeatureGroup | null>(null)
  const lastSelectionSyncKeyRef = useRef<string | null>(null)
  const mapViewSaveTimerRef = useRef<number | null>(null)
  // 图层管理
  const baseLayersRef = useRef<Map<string, L.TileLayer>>(new Map())
  const waybackLayersRef = useRef<Map<string, L.TileLayer>>(new Map())
  // MVT 专用：MapLibre GL 作为 Leaflet 图层涪加（@maplibre/maplibre-gl-leaflet）
  const mvtLayerRef = useRef<L.Layer | null>(null)
  const mvtKeyRef = useRef<string | null>(null)
  const currentBaseLayerKeyRef = useRef<string | null>(null)
  const customControlRef = useRef<L.Control | null>(null)
  const customControlRadiosRef = useRef<HTMLInputElement[]>([])
  const overlayLayersRef = useRef<L.TileLayer[]>([])
  const graticuleLayerRef = useRef<L.LayerGroup | null>(null)
  // 本地加载的矢量图层
  const vectorLayerMapRef = useRef<Map<string, L.GeoJSON>>(new Map())
  const [error] = useState<string | null>(null)
  const [statusCoords, setStatusCoords] = useState<string>('经度: --  纬度: --')
  const [statusZoom, setStatusZoom] = useState<string>('缩放: --')
  const [waybackProxyBaseUrl, setWaybackProxyBaseUrl] = useState<string | null>(null)
  const [effectiveGraticuleInterval, setEffectiveGraticuleInterval] = useState<number | null>(
    null,
  )

  const setSelection = useSelectionStore((s) => s.setSelection)
  const externalRevision = useSelectionStore((s) => s.externalRevision)
  const bounds = useSelectionStore((s) => s.bounds)
  const polygon = useSelectionStore((s) => s.polygon)
  const mode = useAppStore((s) => s.mode)
  const selectedSourceByMode = useAppStore((s) => s.selectedSourceByMode)
  const setSelectedSourceForMode = useAppStore((s) => s.setSelectedSourceForMode)
  const overlayVisibilityByMode = useAppStore((s) => s.overlayVisibilityByMode)
  const setOverlayVisibility = useAppStore((s) => s.setOverlayVisibility)
  const graticuleVisible = useAppStore((s) => s.graticuleVisible)
  const setGraticuleVisible = useAppStore((s) => s.setGraticuleVisible)
  const graticuleInterval = useAppStore((s) => s.graticuleInterval)
  const setGraticuleInterval = useAppStore((s) => s.setGraticuleInterval)
  // 用 ref 跟踪以避免每次写入都重建 control
  const overlayMemRef = useRef(overlayVisibilityByMode)
  useEffect(() => {
    overlayMemRef.current = overlayVisibilityByMode
  }, [overlayVisibilityByMode])
  const vectorLayers = useVectorLayersStore((s) => s.layers)
  const vectorRevision = useVectorLayersStore((s) => s.revision)
  const waybackPreviewId = useWaybackStore((s) => s.previewVersionId)
  const setWaybackPreviewId = useWaybackStore((s) => s.setPreviewVersionId)

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const tdtToken = settingsQuery.data?.tianditu_token ?? null
  const proxyUrl = useMemo(() => {
    const s = settingsQuery.data
    if (!s?.proxy_enabled) return null
    return s.proxy_url || null
  }, [settingsQuery.data])
  const sourcesQuery = useQuery({
    queryKey: ['tile-sources-merged', tdtToken],
    queryFn: () => getTileSourcesMerged(tdtToken),
  })
  const waybackVersionsQuery = useQuery({
    queryKey: ['wayback-versions', proxyUrl ?? ''],
    queryFn: () => getWaybackVersions(proxyUrl),
    enabled: mode === 'wayback',
    staleTime: 5 * 60 * 1000,
    select: (data) => data,
  })
  const waybackVersions = useMemo(
    () => waybackVersionsQuery.data?.versions ?? [],
    [waybackVersionsQuery.data?.versions],
  )
  const waybackFromCache = waybackVersionsQuery.data?.from_cache ?? false
  const selectionSyncKey = useMemo(
    () => JSON.stringify({ externalRevision, bounds, polygon }),
    [externalRevision, bounds, polygon],
  )

  // 初始化地图
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const restoredView = readPersistedMapView()
    const map = L.map(containerRef.current, { zoomControl: true }).setView(
      [restoredView?.center.lat ?? 35.8617, restoredView?.center.lng ?? 104.1954],
      restoredView?.zoom ?? 4,
    )
    // 占位底图，等图源列表加载后会切换
    const fallback = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map)
    baseLayersRef.current.set('__fallback', fallback)
    currentBaseLayerKeyRef.current = '__fallback'
    const drawn = new L.FeatureGroup()
    map.addLayer(drawn)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drawControl = new (L as any).Control.Draw({
      position: 'topleft',
      draw: {
        polyline: false,
        marker: false,
        circle: false,
        circlemarker: false,
        polygon: { allowIntersection: false, showArea: true },
        rectangle: {},
      },
      edit: { featureGroup: drawn, remove: true },
    })
    map.addControl(drawControl)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.on((L as any).Draw.Event.CREATED, (e: any) => {
      drawn.clearLayers()
      drawn.addLayer(e.layer)
      if (e.layerType === 'rectangle') {
        const b = e.layer.getBounds() as L.LatLngBounds
        setSelection({
          bounds: {
            north: b.getNorth(),
            south: b.getSouth(),
            east: b.getEast(),
            west: b.getWest(),
          },
          polygon: null,
        })
      } else if (e.layerType === 'polygon') {
        const latlngs = (e.layer.getLatLngs()[0] as L.LatLng[]).map((ll) => ({
          lat: ll.lat,
          lng: ll.lng,
        }))
        const rings = [latlngs]
        setSelection({ bounds: boundsFromRings(rings), polygon: rings })
      }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.on((L as any).Draw.Event.DELETED, () => {
      setSelection({ bounds: null, polygon: null })
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map.on((L as any).Draw.Event.EDITED, () => {
      const layers = drawn.getLayers()
      if (layers.length === 0) return
      const layer = layers[0] as L.Layer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyLayer = layer as any
      if (anyLayer instanceof L.Rectangle) {
        const b = anyLayer.getBounds() as L.LatLngBounds
        setSelection({
          bounds: {
            north: b.getNorth(),
            south: b.getSouth(),
            east: b.getEast(),
            west: b.getWest(),
          },
          polygon: null,
        })
      } else if (typeof anyLayer.getLatLngs === 'function') {
        const latlngs = (anyLayer.getLatLngs()[0] as L.LatLng[]).map((ll) => ({
          lat: ll.lat,
          lng: ll.lng,
        }))
        const rings = [latlngs]
        setSelection({ bounds: boundsFromRings(rings), polygon: rings })
      }
    })

    mapRef.current = map
    drawnRef.current = drawn

    const persistCurrentView = () => {
      const center = map.getCenter()
      writePersistedMapView({
        center: { lat: center.lat, lng: center.lng },
        zoom: map.getZoom(),
      })
    }
    const schedulePersistCurrentView = () => {
      if (mapViewSaveTimerRef.current !== null) {
        window.clearTimeout(mapViewSaveTimerRef.current)
      }
      mapViewSaveTimerRef.current = window.setTimeout(() => {
        persistCurrentView()
        mapViewSaveTimerRef.current = null
      }, 1000)
    }

    // 状态栏：鼠标经纬度 + 缩放级别
    setStatusZoom(`缩放: ${map.getZoom()}`)
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      setStatusCoords(
        `经度: ${e.latlng.lng.toFixed(6)}  纬度: ${e.latlng.lat.toFixed(6)}`,
      )
    })
    map.on('mouseout', () => setStatusCoords('经度: --  纬度: --'))
    map.on('moveend', schedulePersistCurrentView)
    map.on('zoomend', () => {
      setStatusZoom(`缩放: ${map.getZoom()}`)
      schedulePersistCurrentView()
    })

    // 容器尺寸晚到时刷新
    requestAnimationFrame(() => map.invalidateSize())
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      if (mapViewSaveTimerRef.current !== null) {
        window.clearTimeout(mapViewSaveTimerRef.current)
        mapViewSaveTimerRef.current = null
      }
      persistCurrentView()
      map.remove()
      mapRef.current = null
      drawnRef.current = null
      lastSelectionSyncKeyRef.current = null
    }
  }, [setSelection])

  // 外部数字框 / 清除按钮触发的同步：仅当 externalRevision 变化时绘制
  useEffect(() => {
    const map = mapRef.current
    const drawn = drawnRef.current
    if (!map || !drawn) return
    if (selectionSyncKey === lastSelectionSyncKeyRef.current) return
    lastSelectionSyncKeyRef.current = selectionSyncKey

    drawn.clearLayers()
    if (polygon && polygon.length > 0) {
      const latlngs = polygon.map((ring) => ring.map((p) => L.latLng(p.lat, p.lng)))
      const poly = L.polygon(latlngs, { color: '#2563eb' })
      drawn.addLayer(poly)
      map.fitBounds(poly.getBounds(), { animate: false, maxZoom: 14 })
    } else if (bounds) {
      const rect = L.rectangle(
        [
          [bounds.south, bounds.west],
          [bounds.north, bounds.east],
        ],
        { color: '#2563eb' },
      )
      drawn.addLayer(rect)
      map.fitBounds(rect.getBounds(), { animate: false, maxZoom: 14 })
    }
  }, [selectionSyncKey, bounds, polygon])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!graticuleLayerRef.current) {
      graticuleLayerRef.current = L.layerGroup()
    }
    const layer = graticuleLayerRef.current

    const redraw = () => {
      if (!graticuleVisible) return
      const effective = drawGraticuleLayer(map, layer, graticuleInterval)
      setEffectiveGraticuleInterval(effective)
      if (!map.hasLayer(layer)) layer.addTo(map)
    }

    if (graticuleVisible) {
      redraw()
      map.on('moveend zoomend', redraw)
    } else {
      setEffectiveGraticuleInterval(null)
      layer.clearLayers()
      if (map.hasLayer(layer)) map.removeLayer(layer)
    }

    return () => {
      map.off('moveend zoomend', redraw)
    }
  }, [graticuleVisible, graticuleInterval])

  // 升序版本：oldest → newest（与 timeline 一致）
  const ascendingWaybackVersions = useMemo(() => {
    return [...waybackVersions].reverse()
  }, [waybackVersions])

  const waybackProbeVersionId = useMemo(() => {
    return waybackPreviewId ?? ascendingWaybackVersions.at(-1)?.id ?? null
  }, [ascendingWaybackVersions, waybackPreviewId])

  useEffect(() => {
    if (mode !== 'wayback' || !proxyUrl || !waybackProbeVersionId) {
      setWaybackProxyBaseUrl(null)
      return
    }
    let cancelled = false
    const directProbeUrl = fillTileUrl(buildWaybackTileUrl(waybackProbeVersionId), {
      z: 0,
      x: 0,
      y: 0,
    })
    probeImageUrl(directProbeUrl)
      .then((directOk) => {
        if (cancelled) return
        if (directOk) {
          // 能直连 Esri 时保持原始 URL，避免错误/过期代理反而拖慢或超时。
          setWaybackProxyBaseUrl(null)
          return
        }
        return startWaybackTileProxy(proxyUrl).then((baseUrl) => {
          if (!cancelled) setWaybackProxyBaseUrl(baseUrl)
        })
      })
      .catch((e) => {
        console.warn('Wayback 瓦片代理启动失败', e)
        if (!cancelled) setWaybackProxyBaseUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [mode, proxyUrl, waybackProbeVersionId])

  // 当前 mode 期望的底图 key：'src:<key>' 或 'wb:<id>'
  const desiredBaseKey = useMemo<string | null>(() => {
    if (mode === 'wayback') {
      return waybackPreviewId ? `wb:${waybackPreviewId}` : null
    }
    const k = selectedSourceByMode[mode]
    return k ? `src:${k}` : null
  }, [mode, selectedSourceByMode, waybackPreviewId])

  // 维护普通图源缓存
  useEffect(() => {
    const map = mapRef.current
    if (!map || !sourcesQuery.data) return
    const sources = sourcesQuery.data
    const cache = baseLayersRef.current
    for (const [k, layer] of cache) {
      if (k === '__fallback') continue
      const cfg = sources[k]
      const expectedUrl = (cfg as { url?: string } | undefined)?.url
      const layerUrl = (layer as L.TileLayer & { _url?: string })._url
      if (!cfg || layerUrl !== expectedUrl) {
        if (map.hasLayer(layer)) map.removeLayer(layer)
        cache.delete(k)
      }
    }
    for (const [key, cfg] of Object.entries(sources)) {
      if (cache.has(key)) continue
      const c = cfg as TileSource & {
        url?: string
        subdomains?: string[]
        max_zoom?: number
        attribution?: string
      }
      if (!c.url) continue
      // 跳过 MVT 矢量瓦片源：Leaflet 选区底图只能渲染光栅，请求 PBF 浪费带宽且会报 404
      if (isMvtUrl(c.url)) continue
      try {
        const layer = createCachedTileLayer(c.url, {
          sourceKey: key,
          displayName: c.name ?? key,
          urlTemplate: c.url,
          attribution: c.attribution ?? '',
          maxZoom: c.max_zoom ?? 22,
          subdomains: c.subdomains ?? 'abc',
        })
        cache.set(key, layer)
      } catch {
        // skip bad url
      }
    }
  }, [sourcesQuery.data])

  // 维护 wayback 版本图层缓存
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const cache = waybackLayersRef.current
    const validIds = new Set(ascendingWaybackVersions.map((v) => v.id))
    for (const [id, layer] of cache) {
      const expectedUrl = buildWaybackTileUrl(id, waybackProxyBaseUrl)
      const layerUrl = (layer as L.TileLayer & { _url?: string })._url
      if (!validIds.has(id) || layerUrl !== expectedUrl) {
        if (map.hasLayer(layer)) map.removeLayer(layer)
        if (currentBaseLayerKeyRef.current === `wb:${id}`) {
          currentBaseLayerKeyRef.current = null
        }
        cache.delete(id)
      }
    }
    for (const v of ascendingWaybackVersions) {
      if (cache.has(v.id)) continue
      const url = buildWaybackTileUrl(v.id, waybackProxyBaseUrl)
      const originUrl = buildWaybackTileUrl(v.id)
      const layer = createCachedTileLayer(url, {
        sourceKey: `wayback_${v.id}`,
        displayName: `Esri Wayback ${v.date ?? v.id}`,
        urlTemplate: originUrl,
        referrerPolicy: 'no-referrer',
        maxZoom: 19,
        attribution: 'Esri Wayback',
      })
      cache.set(v.id, layer)
    }
  }, [ascendingWaybackVersions, waybackProxyBaseUrl])

  // 按 mode 重建 LayersControl + 同步天地图标注 overlay
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // 移除旧 overlay 与控件
    overlayLayersRef.current.forEach((l) => {
      if (map.hasLayer(l)) map.removeLayer(l)
    })
    overlayLayersRef.current = []
    if (customControlRef.current) {
      customControlRef.current.remove()
      customControlRef.current = null
    }
    customControlRadiosRef.current = []

    const tdt = tdtToken || '436ce7e50d27eede2f2929307e6b33c0'
    const tdtSubdomains = ['0', '1', '2', '3', '4', '5', '6', '7']
    const ciaLayer = createCachedTileLayer(
      `https://t{s}.tianditu.gov.cn/cia_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cia&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${tdt}`,
      {
        sourceKey: 'tdt_cia_w',
        displayName: '天地图中文注记',
        urlTemplate:
          'https://t{s}.tianditu.gov.cn/cia_w/wmts?...&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
        subdomains: tdtSubdomains,
        maxZoom: 18,
        attribution: '天地图',
      },
    )
    const cvaLayer = createCachedTileLayer(
      `https://t{s}.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${tdt}`,
      {
        sourceKey: 'tdt_cva_w',
        displayName: '天地图英文注记',
        urlTemplate:
          'https://t{s}.tianditu.gov.cn/cva_w/wmts?...&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
        subdomains: tdtSubdomains,
        maxZoom: 18,
        attribution: '天地图',
      },
    )
    overlayLayersRef.current = [ciaLayer, cvaLayer]

    // 按当前 mode 记忆决定 cia/cva 初始可见性（默认两者都不显示）
    const overlayMem = overlayMemRef.current[mode] ?? {}
    if (overlayMem.cia) ciaLayer.addTo(map)
    if (overlayMem.cva) cvaLayer.addTo(map)

    if (mode === 'wayback') {
      // ---------- Wayback：自定义嵌套 control（按 年/月 分组） ----------
      const desc = [...ascendingWaybackVersions].reverse() // 最新优先
      // group: year → month → versions
      const grouped = new Map<string, Map<string, typeof desc>>()
      let waybackPanelCleanup: (() => void) | undefined
      for (const v of desc) {
        const date = v.date || ''
        const year = date.slice(0, 4) || '其他'
        const month = date.slice(5, 7) || '--'
        if (!grouped.has(year)) grouped.set(year, new Map())
        const monthMap = grouped.get(year)!
        if (!monthMap.has(month)) monthMap.set(month, [])
        monthMap.get(month)!.push(v)
      }

      const Custom = L.Control.extend({
        options: { position: 'topleft' as L.ControlPosition },
        onAdd() {
          const container = L.DomUtil.create(
            'div',
            'leaflet-control-layers leaflet-control',
          )
          // 阻止地图捕获滚轮 / 拖拽 / 双击
          L.DomEvent.disableClickPropagation(container)
          L.DomEvent.disableScrollPropagation(container)

          const toggle = L.DomUtil.create(
            'a',
            'leaflet-control-layers-toggle',
            container,
          )
          toggle.href = '#'
          toggle.title = 'Wayback 历史影像'

          const list = L.DomUtil.create(
            'section',
            'leaflet-control-layers-list',
            container,
          )
          waybackPanelCleanup = installClickPinnedLayersControl(container, toggle)

          // base 区域
          const baseDiv = L.DomUtil.create('div', 'leaflet-control-layers-base', list)
          baseDiv.style.maxHeight = '60vh'
          baseDiv.style.overflowY = 'auto'
          baseDiv.style.minWidth = '180px'

          const radios: HTMLInputElement[] = []
          let firstYear = true
          for (const [year, monthMap] of grouped) {
            const yearDetails = document.createElement('details')
            yearDetails.style.marginLeft = '0'
            if (firstYear) {
              yearDetails.open = true
              firstYear = false
            }
            const yearSummary = document.createElement('summary')
            yearSummary.textContent = `${year} (${[...monthMap.values()].reduce(
              (s, vs) => s + vs.length,
              0,
            )})`
            yearSummary.style.cursor = 'pointer'
            yearSummary.style.fontWeight = '600'
            yearSummary.style.padding = '2px 0'
            yearDetails.appendChild(yearSummary)

            for (const [month, versions] of monthMap) {
              const monthDetails = document.createElement('details')
              monthDetails.style.marginLeft = '12px'
              const monthSummary = document.createElement('summary')
              monthSummary.textContent = `${month}月 (${versions.length})`
              monthSummary.style.cursor = 'pointer'
              monthSummary.style.color = '#555'
              monthSummary.style.padding = '1px 0'
              monthDetails.appendChild(monthSummary)

              for (const v of versions) {
                const label = document.createElement('label')
                label.style.display = 'block'
                label.style.marginLeft = '14px'
                label.style.padding = '1px 0'
                label.style.cursor = 'pointer'
                const radio = document.createElement('input')
                radio.type = 'radio'
                radio.name = 'wayback-version'
                radio.value = v.id
                radio.style.marginRight = '6px'
                if (v.id === waybackPreviewId) {
                  radio.checked = true
                  // 自动展开当前所在的月份
                  monthDetails.open = true
                  yearDetails.open = true
                }
                radio.addEventListener('change', () => {
                  if (radio.checked) setWaybackPreviewId(v.id)
                })
                label.appendChild(radio)
                label.appendChild(document.createTextNode(v.date || v.id))
                monthDetails.appendChild(label)
                radios.push(radio)
              }
              yearDetails.appendChild(monthDetails)
            }
            baseDiv.appendChild(yearDetails)
          }
          customControlRadiosRef.current = radios

          // 分隔线
          const sep = L.DomUtil.create('div', 'leaflet-control-layers-separator', list)
          sep.style.borderTop = '1px solid #ddd'
          sep.style.margin = '6px 0'

          // overlays（cia/cva）
          const overlayDiv = L.DomUtil.create(
            'div',
            'leaflet-control-layers-overlays',
            list,
          )
          const makeOverlay = (label: string, layer: L.TileLayer, key: string) => {
            const lbl = document.createElement('label')
            lbl.style.display = 'block'
            lbl.style.cursor = 'pointer'
            const cb = document.createElement('input')
            cb.type = 'checkbox'
            cb.style.marginRight = '6px'
            cb.checked = map.hasLayer(layer)
            cb.addEventListener('change', () => {
              if (cb.checked) layer.addTo(map)
              else map.removeLayer(layer)
              setOverlayVisibility(mode as AppMode, key, cb.checked)
            })
            lbl.appendChild(cb)
            lbl.appendChild(document.createTextNode(label))
            overlayDiv.appendChild(lbl)
          }
          makeOverlay('天地图 影像标注', ciaLayer, 'cia')
          makeOverlay('天地图 矢量标注', cvaLayer, 'cva')

          return container
        },
      })
      const ctrl = new Custom()
      ctrl.addTo(map)
      customControlRef.current = ctrl
      return () => {
        waybackPanelCleanup?.()
      }
    } else {
      // ---------- Normal mode: custom click-pinned LayersControl ----------
      const sources = sourcesQuery.data ?? {}
      const cache = baseLayersRef.current
      const keys = Object.keys(sources).sort((a, b) =>
        ((sources[a] as { name?: string }).name || '').localeCompare(
          (sources[b] as { name?: string }).name || '',
        ),
      )
      let normalPanelCleanup: (() => void) | undefined
      const selectedSourceKey = desiredBaseKey?.startsWith('src:')
        ? desiredBaseKey.slice(4)
        : null
      const Custom = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: () => {
          const container = L.DomUtil.create(
            'div',
            'leaflet-control-layers leaflet-control',
          )
          const toggle = L.DomUtil.create(
            'a',
            'leaflet-control-layers-toggle',
            container,
          )
          toggle.href = '#'
          toggle.title = '\u56fe\u5c42'
          toggle.setAttribute('role', 'button')
          toggle.setAttribute('aria-label', '\u56fe\u5c42')

          const list = L.DomUtil.create(
            'section',
            'leaflet-control-layers-list',
            container,
          )
          normalPanelCleanup = installClickPinnedLayersControl(container, toggle)

          const baseDiv = L.DomUtil.create('div', 'leaflet-control-layers-base', list)
          for (const key of keys) {
            const layer = cache.get(key)
            if (!layer) continue
            const source = sources[key] as { name?: string }
            const lbl = document.createElement('label')
            lbl.style.display = 'block'
            lbl.style.cursor = 'pointer'
            const radio = document.createElement('input')
            radio.type = 'radio'
            radio.name = 'base-layer-' + mode
            radio.value = key
            radio.style.marginRight = '6px'
            radio.checked = key === selectedSourceKey || map.hasLayer(layer)
            radio.addEventListener('change', () => {
              if (!radio.checked) return
              setSelectedSourceForMode(mode as AppMode, key)
            })
            lbl.appendChild(radio)
            lbl.appendChild(document.createTextNode(source.name || key))
            baseDiv.appendChild(lbl)
          }

          const sep = L.DomUtil.create('div', 'leaflet-control-layers-separator', list)
          sep.setAttribute('aria-hidden', 'true')
          const overlayDiv = L.DomUtil.create(
            'div',
            'leaflet-control-layers-overlays',
            list,
          )
          const makeOverlay = (label: string, layer: L.TileLayer, key: string) => {
            const lbl = document.createElement('label')
            lbl.style.display = 'block'
            lbl.style.cursor = 'pointer'
            const cb = document.createElement('input')
            cb.type = 'checkbox'
            cb.style.marginRight = '6px'
            cb.checked = map.hasLayer(layer)
            cb.addEventListener('change', () => {
              if (cb.checked) layer.addTo(map)
              else map.removeLayer(layer)
              setOverlayVisibility(mode as AppMode, key, cb.checked)
            })
            lbl.appendChild(cb)
            lbl.appendChild(document.createTextNode(label))
            overlayDiv.appendChild(lbl)
          }
          makeOverlay('\u5929\u5730\u56fe \u5f71\u50cf\u6807\u6ce8', ciaLayer, 'cia')
          makeOverlay('\u5929\u5730\u56fe \u77e2\u91cf\u6807\u6ce8', cvaLayer, 'cva')

          return container
        },
      })
      const ctrl = new Custom()
      ctrl.addTo(map)
      customControlRef.current = ctrl
      return () => {
        normalPanelCleanup?.()
      }
    }
  }, [
    mode,
    sourcesQuery.data,
    ascendingWaybackVersions,
    tdtToken,
    setSelectedSourceForMode,
    setWaybackPreviewId,
    // 注意：waybackPreviewId 不放依赖，避免每次切版本都重建 control；下面单独 effect 同步 radio checked
  ])

  // wayback 自定义 control 的 radio checked 同步（不重建）
  useEffect(() => {
    const radios = customControlRadiosRef.current
    if (!radios.length) return
    for (const r of radios) {
      r.checked = r.value === waybackPreviewId
    }
  }, [waybackPreviewId])

  // 同步当前期望底图 key → 切换地图上的 base layer
  useEffect(() => {
    const map = mapRef.current
    if (!map || !desiredBaseKey) return

    const removePrevRaster = () => {
      const prevKey = currentBaseLayerKeyRef.current
      if (!prevKey) return
      let prev: L.TileLayer | undefined
      if (prevKey.startsWith('wb:')) {
        prev = waybackLayersRef.current.get(prevKey.slice(3))
      } else if (prevKey.startsWith('src:')) {
        prev = baseLayersRef.current.get(prevKey.slice(4))
      } else if (prevKey === '__fallback') {
        prev = baseLayersRef.current.get('__fallback')
      }
      if (prev && map.hasLayer(prev)) map.removeLayer(prev)
    }

    const removeMvtLayer = () => {
      if (mvtLayerRef.current && map.hasLayer(mvtLayerRef.current)) {
        map.removeLayer(mvtLayerRef.current)
      }
      mvtLayerRef.current = null
      mvtKeyRef.current = null
    }

    // MVT 分支：根据 src:<key> 找到 MVT URL 后通过 maplibreGL 图层挂载
    if (desiredBaseKey.startsWith('src:') && sourcesQuery.data) {
      const key = desiredBaseKey.slice(4)
      const cfg = sourcesQuery.data[key] as
        | { url?: string; max_zoom?: number; name?: string }
        | undefined
      if (cfg?.url && isMvtUrl(cfg.url)) {
        if (mvtKeyRef.current === desiredBaseKey) return
        let cancelled = false
        const center = map.getCenter()
        discoverMvtLayers(cfg.url, center.lng, center.lat)
          .then((result) => {
            if (cancelled) return
            const effectiveUrl = result.canonicalTileUrl ?? cfg.url!
            const style = buildMvtStyle({
              urlTemplate: effectiveUrl,
              layers: result.layers,
              maxZoom: cfg.max_zoom ?? 14,
              includeBaseRaster: false,
            })
            removePrevRaster()
            removeMvtLayer()
            const layer = L.maplibreGL({
              style,
              attributionControl: false,
            })
            layer.addTo(map)
            mvtLayerRef.current = layer
            mvtKeyRef.current = desiredBaseKey
            currentBaseLayerKeyRef.current = desiredBaseKey
          })
          .catch((err) => {
            console.warn('[map-canvas] MVT layer build failed:', err)
          })
        return () => {
          cancelled = true
        }
      }
    }

    // 非 MVT 分支：使用 Leaflet 栅格图层；若之前是 MVT，先清理
    removeMvtLayer()
    let target: L.TileLayer | undefined
    if (desiredBaseKey.startsWith('wb:')) {
      target = waybackLayersRef.current.get(desiredBaseKey.slice(3))
    } else if (desiredBaseKey.startsWith('src:')) {
      target = baseLayersRef.current.get(desiredBaseKey.slice(4))
    }
    if (!target) return
    if (currentBaseLayerKeyRef.current === desiredBaseKey) return
    removePrevRaster()
    target.addTo(map)
    target.bringToBack?.()
    currentBaseLayerKeyRef.current = desiredBaseKey
  }, [desiredBaseKey, sourcesQuery.data, ascendingWaybackVersions, waybackProxyBaseUrl])

  // 同步本地矢量图层（按 revision 增量 diff）
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const colors = ['#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#f39c12', '#1abc9c']
    const cache = vectorLayerMapRef.current
    const currentIds = new Set(vectorLayers.map((l) => l.id))

    // 移除不再存在的图层
    for (const [id, layer] of cache) {
      if (!currentIds.has(id)) {
        if (map.hasLayer(layer)) map.removeLayer(layer)
        cache.delete(id)
      }
    }

    // 新增图层
    let lastBounds: L.LatLngBounds | null = null
    vectorLayers.forEach((entry, idx) => {
      if (cache.has(entry.id)) return
      const color = colors[idx % colors.length]
      const layer = L.geoJSON(entry.geojson as never, {
        style: () => ({ color, fillColor: color, fillOpacity: 0.3, weight: 2 }),
        pointToLayer: (_f, latlng) =>
          L.circleMarker(latlng, {
            radius: 6,
            fillColor: color,
            color: '#fff',
            weight: 1,
            fillOpacity: 0.8,
          }),
        onEachFeature: (feature, lyr) => {
          if (feature?.properties) {
            const html = Object.entries(feature.properties as Record<string, unknown>)
              .filter(([, v]) => v !== null && v !== '')
              .slice(0, 10)
              .map(
                ([k, v]) =>
                  `<b>${escapeHtml(String(k))}:</b> ${escapeHtml(String(v))}`,
              )
              .join('<br>')
            if (html) lyr.bindPopup(html)
          }
        },
      })
      layer.addTo(map)
      cache.set(entry.id, layer)
      try {
        const b = layer.getBounds()
        if (b.isValid()) lastBounds = b
      } catch {
        // ignore
      }
    })

    if (lastBounds) {
      map.fitBounds(lastBounds, { animate: false })
    }
  }, [vectorLayers, vectorRevision])

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      {waybackFromCache && mode === 'wayback' && (
        <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2">
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-xs text-yellow-700 shadow-sm backdrop-blur dark:text-yellow-400">
            离线模式 · 版本列表来自缓存
          </div>
        </div>
      )}
      {error && (
        <div className="pointer-events-none absolute right-3 top-20 z-10 flex flex-col items-end gap-2">
          <div className="pointer-events-auto rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive shadow-sm">
            {error}
          </div>
        </div>
      )}
      <div className="pointer-events-auto absolute right-3 top-3 z-10 rounded-md border bg-background/95 p-2 text-xs shadow-sm backdrop-blur">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 whitespace-nowrap text-foreground">
            <input
              type="checkbox"
              checked={graticuleVisible}
              onChange={(e) => setGraticuleVisible(e.currentTarget.checked)}
              className="size-3.5 accent-primary"
            />
            经纬网
          </label>
          <select
            value={String(graticuleInterval)}
            onChange={(e) => setGraticuleInterval(Number(e.currentTarget.value))}
            disabled={!graticuleVisible}
            className="h-7 rounded-md border bg-background px-2 text-xs outline-none disabled:opacity-50"
            title="经纬网间隔"
          >
            {GRATICULE_INTERVALS.map((interval) => (
              <option key={interval} value={interval}>
                {interval}°
              </option>
            ))}
          </select>
        </div>
        {graticuleVisible &&
          effectiveGraticuleInterval !== null &&
          effectiveGraticuleInterval !== graticuleInterval && (
            <div className="mt-1 text-[11px] text-muted-foreground">
              视野过大，显示 {effectiveGraticuleInterval}°
            </div>
          )}
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 z-10 flex items-center gap-2 rounded-md border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur tabular-nums">
        <span>{statusCoords}</span>
        <span className="text-muted-foreground/40">|</span>
        <span>{statusZoom}</span>
      </div>
    </div>
  )
}
