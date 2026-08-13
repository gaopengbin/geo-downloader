import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import { useTranslation } from 'react-i18next'

import { i18n } from '@/i18n'
import { useSelectionStore } from '@/store/selection-store'

const PALETTE = [
  '#e6194B',
  '#3cb44b',
  '#ffe119',
  '#4363d8',
  '#f58231',
  '#911eb4',
  '#42d4f4',
  '#f032e6',
  '#bfef45',
  '#fabebe',
  '#469990',
  '#9A6324',
  '#800000',
  '#aaffc3',
  '#808000',
  '#ffd8b1',
]

function colorFor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  return PALETTE[h % PALETTE.length]
}

function lon2tile(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z))
}

function lat2tile(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z),
  )
}

interface DiscoveredLayer {
  name: string
  geomType: 1 | 2 | 3 // POINT | LINE | POLYGON
}

interface DiscoverResult {
  layers: DiscoveredLayer[]
  // TileJSON 中给出的真实 tile URL（含版本号），优于用户传入的模板
  canonicalTileUrl?: string
  bounds?: [number, number, number, number]
  minzoom?: number
  maxzoom?: number
}

// 1. 优先尝试 TileJSON 端点（OpenFreeMap、TileServer-GL、OSM Vector 等都提供）
async function discoverViaTileJson(urlTemplate: string): Promise<DiscoverResult | null> {
  // 把 .../{z}/{x}/{y}.pbf 截到 .../<base>，再尝试取 TileJSON
  const stripped = urlTemplate.replace(/\/?\{z\}.*$/, '')
  if (!stripped || stripped === urlTemplate) return null
  try {
    const res = await fetch(stripped, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return null
    const json = (await res.json()) as {
      vector_layers?: { id: string; geometry_type?: string }[]
      tiles?: string[]
      bounds?: [number, number, number, number]
      minzoom?: number
      maxzoom?: number
    }
    const canonicalTileUrl =
      Array.isArray(json.tiles) && json.tiles.length > 0 ? json.tiles[0] : undefined
    if (Array.isArray(json.vector_layers) && json.vector_layers.length > 0) {
      const layers = json.vector_layers.map((vl) => {
        const gt = (vl.geometry_type ?? '').toLowerCase()
        let geomType: 1 | 2 | 3 = 3
        if (gt.includes('point')) geomType = 1
        else if (gt.includes('line')) geomType = 2
        else if (gt.includes('polygon')) geomType = 3
        return { name: vl.id, geomType }
      })
      return { layers, canonicalTileUrl, bounds: json.bounds, minzoom: json.minzoom, maxzoom: json.maxzoom }
    }
    // 没有 vector_layers，但有 bounds/zoom 时也返回，让后续探测使用
    if (json.bounds || json.maxzoom !== undefined) {
      return {
        layers: [],
        canonicalTileUrl,
        bounds: json.bounds,
        minzoom: json.minzoom,
        maxzoom: json.maxzoom,
      }
    }
    return null
  } catch {
    return null
  }
}

async function discoverLayersViaProbe(
  urlTemplate: string,
  z: number,
  x: number,
  y: number,
): Promise<DiscoveredLayer[]> {
  const url = urlTemplate
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace(/\{s\}/, 'a')
  const res = await fetch(url)
  if (!res.ok) throw new Error(i18n.t('mvt.firstTileFailed', { status: res.status }))
  let buf = await res.arrayBuffer()
  const u8 = new Uint8Array(buf)
  if (u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
    const Ds = (window as unknown as { DecompressionStream?: new (f: string) => unknown })
      .DecompressionStream
    if (Ds) {
      const ds = new Ds('gzip')
      const stream = new Response(u8).body!.pipeThrough(ds as unknown as ReadableWritablePair)
      buf = await new Response(stream).arrayBuffer()
    }
  }
  if (buf.byteLength === 0) return []
  const tile = new VectorTile(new Pbf(new Uint8Array(buf)))
  const layers: DiscoveredLayer[] = []
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name]
    let geomType: 1 | 2 | 3 = 3
    if (layer.length > 0) {
      const f = layer.feature(0)
      geomType = (f.type as 1 | 2 | 3) ?? 3
    }
    layers.push({ name, geomType })
  }
  return layers
}

async function discoverLayers(
  urlTemplate: string,
  centerLon: number,
  centerLat: number,
): Promise<DiscoverResult> {
  // 优先 TileJSON
  const viaJson = await discoverViaTileJson(urlTemplate)
  if (viaJson && viaJson.layers.length > 0) return viaJson

  // 准备探测点：若 TileJSON 给了 bounds，用其中心；否则用选区/默认 + 已知陆地
  let probes: Array<[number, number, number]> = []
  let effectiveTpl = urlTemplate
  let preserved: DiscoverResult = { layers: [] }
  if (viaJson) {
    preserved = viaJson
    if (viaJson.canonicalTileUrl) effectiveTpl = viaJson.canonicalTileUrl
    if (viaJson.bounds) {
      const [w, s, e, n] = viaJson.bounds
      const lon = (w + e) / 2
      const lat = (s + n) / 2
      const z = Math.max(viaJson.minzoom ?? 0, Math.min(viaJson.maxzoom ?? 14, 12))
      probes.push([lon, lat, z])
    }
  }
  if (probes.length === 0) {
    probes = [
      [centerLon, centerLat, 10],
      [121.4737, 31.2304, 10], // 上海
      [-0.1276, 51.5074, 10],
      [-74.006, 40.7128, 10],
    ]
  }

  for (const [lon, lat, z] of probes) {
    try {
      const x = lon2tile(lon, z)
      const y = lat2tile(lat, z)
      const layers = await discoverLayersViaProbe(effectiveTpl, z, x, y)
      if (layers.length > 0) {
        return { ...preserved, layers, canonicalTileUrl: effectiveTpl }
      }
    } catch {
      // try next probe
    }
  }
  return preserved
}

type BasemapId = 'gaode' | 'gaode-sat' | 'osm' | 'esri' | 'none'

interface BasemapDef {
  id: BasemapId
  tiles: string[]
  attribution: string
  attributionKey?: string
  maxzoom?: number
}

const BASEMAPS: BasemapDef[] = [
  {
    id: 'gaode',
    tiles: [1, 2, 3, 4].map(
      (s) =>
        `https://webrd0${s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}`,
    ),
    attribution: '',
    attributionKey: 'mvt.attribution.gaode',
    maxzoom: 18,
  },
  {
    id: 'gaode-sat',
    tiles: [1, 2, 3, 4].map(
      (s) => `https://webst0${s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}`,
    ),
    attribution: '',
    attributionKey: 'mvt.attribution.gaodeSatellite',
    maxzoom: 18,
  },
  {
    id: 'esri',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: '© Esri',
    maxzoom: 19,
  },
  {
    id: 'osm',
    tiles: [
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    ],
    attribution: '© OpenStreetMap',
    maxzoom: 19,
  },
  { id: 'none', tiles: [], attribution: '' },
]

const BASEMAP_LABEL_KEYS: Record<BasemapId, string> = {
  gaode: 'mvt.basemap.gaode',
  'gaode-sat': 'mvt.basemap.gaodeSatellite',
  esri: 'mvt.basemap.esri',
  osm: 'mvt.basemap.osm',
  none: 'mvt.basemap.none',
}

function getBasemapAttribution(def: BasemapDef): string {
  return def.attributionKey ? i18n.t(def.attributionKey) : def.attribution
}

function buildStyle(
  urlTemplate: string,
  layers: DiscoveredLayer[],
  maxZoom: number,
  basemapId: BasemapId,
): StyleSpecification {
  const basemap = BASEMAPS.find((b) => b.id === basemapId) ?? BASEMAPS[0]
  const style: StyleSpecification = {
    version: 8,
    sources: {
      mvt: {
        type: 'vector',
        tiles: [urlTemplate.replace(/\{s\}/g, 'a')],
        minzoom: 0,
        maxzoom: maxZoom,
      },
    },
    layers: [],
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  }
  if (basemap.tiles.length > 0) {
    ;(style.sources as Record<string, unknown>)['basemap'] = {
      type: 'raster',
      tiles: basemap.tiles,
      tileSize: 256,
      attribution: getBasemapAttribution(basemap),
      maxzoom: basemap.maxzoom ?? 19,
    }
    style.layers.push({
      id: 'basemap',
      type: 'raster',
      source: 'basemap',
      paint: { 'raster-opacity': 0.85 },
    })
  }
  for (const l of layers) {
    const c = colorFor(l.name)
    if (l.geomType === 3) {
      style.layers.push({
        id: `mvt-${l.name}-fill`,
        type: 'fill',
        source: 'mvt',
        'source-layer': l.name,
        paint: { 'fill-color': c, 'fill-opacity': 0.35, 'fill-outline-color': c },
      })
    } else if (l.geomType === 2) {
      style.layers.push({
        id: `mvt-${l.name}-line`,
        type: 'line',
        source: 'mvt',
        'source-layer': l.name,
        paint: { 'line-color': c, 'line-width': 1.5 },
      })
    } else {
      style.layers.push({
        id: `mvt-${l.name}-circle`,
        type: 'circle',
        source: 'mvt',
        'source-layer': l.name,
        paint: { 'circle-color': c, 'circle-radius': 3, 'circle-opacity': 0.8 },
      })
    }
  }
  return style
}

export interface MvtPreviewProps {
  urlTemplate: string | null
  maxZoom?: number
}

export function MvtPreview({ urlTemplate, maxZoom = 14 }: MvtPreviewProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [layerCount, setLayerCount] = useState(0)
  const [basemap, setBasemap] = useState<BasemapId>('gaode')
  const bounds = useSelectionStore((s) => s.bounds)

  // 初始中心：选区中心，否则 [120, 30]
  const initialCenter = useMemo<[number, number]>(() => {
    if (bounds) return [(bounds.east + bounds.west) / 2, (bounds.north + bounds.south) / 2]
    return [120, 30]
  }, [bounds])

  useEffect(() => {
    if (!containerRef.current) return
    if (!urlTemplate) {
      setStatus('idle')
      return
    }
    let cancelled = false
    setStatus('loading')
    setErrorMsg(null)

    discoverLayers(urlTemplate, initialCenter[0], initialCenter[1])
      .then((result) => {
        if (cancelled || !containerRef.current) return
        const { layers, canonicalTileUrl } = result
        setLayerCount(layers.length)
        if (mapRef.current) {
          mapRef.current.remove()
          mapRef.current = null
        }
        // 首选 TileJSON 返回的含版本 URL（OpenFreeMap 裸路径返回空体）
        const effectiveUrl = canonicalTileUrl ?? urlTemplate
        const style = buildStyle(effectiveUrl, layers, maxZoom, basemap)
        const map = new maplibregl.Map({
          container: containerRef.current,
          style,
          center: initialCenter,
          zoom: 10,
          attributionControl: { compact: true },
        })
        map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
        map.on('load', () => {
          if (cancelled) return
          setStatus('ready')
          const c = (map.getCanvas() as HTMLCanvasElement)
          console.log('[MvtPreview] map loaded, canvas size:', c.clientWidth, 'x', c.clientHeight)
          // 若 TileJSON 提供 bounds，自动飞过去（用户没另外画选区时才飞）
          if (result.bounds && !bounds) {
            const [w, s, e, n] = result.bounds
            console.log('[MvtPreview] fitBounds to', w, s, e, n, 'maxZoom', result.maxzoom ?? maxZoom)
            map.fitBounds(
              [
                [w, s],
                [e, n],
              ],
              { padding: 24, duration: 0, maxZoom: result.maxzoom ?? maxZoom },
            )
          }
        })
        map.on('error', (e) => {
          if (!cancelled) {
            const msg = (e.error as Error | undefined)?.message ?? i18n.t('mvt.unknownError')
            console.warn('[MvtPreview]', msg)
          }
        })
        mapRef.current = map
        // 容器在表单内首次可见可能尺寸为 0，主动 resize（多次以防过渡动画）
        const ro = new ResizeObserver(() => map.resize())
        ro.observe(containerRef.current)
        ;(map as unknown as { __ro?: ResizeObserver }).__ro = ro
        requestAnimationFrame(() => map.resize())
        setTimeout(() => map.resize(), 50)
        setTimeout(() => map.resize(), 250)
        setTimeout(() => map.resize(), 600)
      })
      .catch((err) => {
        if (cancelled) return
        setStatus('error')
        setErrorMsg(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      if (mapRef.current) {
        const ro = (mapRef.current as unknown as { __ro?: ResizeObserver }).__ro
        if (ro) ro.disconnect()
        mapRef.current.remove()
        mapRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTemplate, maxZoom])

  // 选区变化时把视图飞到选区
  useEffect(() => {
    if (!mapRef.current || !bounds) return
    mapRef.current.fitBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding: 24, duration: 600, maxZoom },
    )
  }, [bounds, maxZoom])

  // 切换底图：直接增删 source/layer，不重建整张地图
  useEffect(() => {
    const map = mapRef.current
    if (!map || status !== 'ready') return
    const def = BASEMAPS.find((b) => b.id === basemap) ?? BASEMAPS[0]
    if (map.getLayer('basemap')) map.removeLayer('basemap')
    if (map.getSource('basemap')) map.removeSource('basemap')
    if (def.tiles.length > 0) {
      map.addSource('basemap', {
        type: 'raster',
        tiles: def.tiles,
        tileSize: 256,
        attribution: getBasemapAttribution(def),
        maxzoom: def.maxzoom ?? 19,
      })
      // 插到所有矢量图层下面
      const firstMvt = map.getStyle().layers?.find((l) => l.id.startsWith('mvt-'))?.id
      map.addLayer(
        {
          id: 'basemap',
          type: 'raster',
          source: 'basemap',
          paint: { 'raster-opacity': 0.85 },
        },
        firstMvt,
      )
    }
  }, [basemap, status])

  return (
    <div className="relative h-[480px] min-h-[300px] w-full overflow-hidden rounded-md border border-border/60 bg-muted/30 [&>div.maplibregl-map]:absolute [&>div.maplibregl-map]:inset-0">
      <div ref={containerRef} className="absolute inset-0 h-full w-full" />
      <div className="absolute right-2 top-2 z-10 flex gap-1 rounded bg-background/85 p-1 shadow-sm backdrop-blur">
        {BASEMAPS.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setBasemap(b.id)}
            className={`rounded px-2 py-0.5 text-[11px] transition ${
              basemap === b.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {t(BASEMAP_LABEL_KEYS[b.id])}
          </button>
        ))}
      </div>
      {status === 'idle' && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          {t('mvt.chooseSource')}
        </div>
      )}
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-xs text-muted-foreground">
          {t('mvt.discovering')}
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 px-4 text-center text-xs text-destructive">
          {t('mvt.previewFailed', { message: errorMsg })}
        </div>
      )}
      {status === 'ready' && (
        <div className="pointer-events-none absolute left-2 top-2 rounded bg-background/80 px-2 py-1 text-[11px] text-muted-foreground">
          {t('mvt.discoveredLayers', { count: layerCount })}
        </div>
      )}
    </div>
  )
}
