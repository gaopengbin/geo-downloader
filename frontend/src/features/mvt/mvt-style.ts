import type { StyleSpecification } from 'maplibre-gl'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'

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

export function colorFor(name: string): string {
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

export interface DiscoveredLayer {
  name: string
  geomType: 1 | 2 | 3
}

export interface DiscoverResult {
  layers: DiscoveredLayer[]
  // TileJSON 中给出的真实 tile URL（含版本号），优于用户传入的模板
  canonicalTileUrl?: string
}

async function discoverViaTileJson(urlTemplate: string): Promise<DiscoverResult | null> {
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
    }
    if (!Array.isArray(json.vector_layers) || json.vector_layers.length === 0) return null
    const layers = json.vector_layers.map((vl) => {
      const gt = (vl.geometry_type ?? '').toLowerCase()
      let geomType: 1 | 2 | 3 = 3
      if (gt.includes('point')) geomType = 1
      else if (gt.includes('line')) geomType = 2
      else if (gt.includes('polygon')) geomType = 3
      return { name: vl.id, geomType }
    })
    const canonicalTileUrl =
      Array.isArray(json.tiles) && json.tiles.length > 0 ? json.tiles[0] : undefined
    return { layers, canonicalTileUrl }
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
  if (!res.ok) throw new Error(`HTTP ${res.status} 抓取首块瓦片失败`)
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

export async function discoverLayers(
  urlTemplate: string,
  centerLon: number,
  centerLat: number,
): Promise<DiscoverResult> {
  const viaJson = await discoverViaTileJson(urlTemplate)
  if (viaJson && viaJson.layers.length > 0) return viaJson
  const probes: Array<[number, number]> = [
    [centerLon, centerLat],
    [121.4737, 31.2304], // 上海
    [-0.1276, 51.5074], // 伦敦
    [-74.006, 40.7128], // 纽约
  ]
  for (const [lon, lat] of probes) {
    try {
      const z = 10
      const x = lon2tile(lon, z)
      const y = lat2tile(lat, z)
      const layers = await discoverLayersViaProbe(urlTemplate, z, x, y)
      if (layers.length > 0) return { layers }
    } catch {
      // try next probe
    }
  }
  return { layers: [] }
}

export interface BuildStyleOptions {
  urlTemplate: string
  layers: DiscoveredLayer[]
  maxZoom: number
  // 是否包含底层 OSM 栅格底图（在 Leaflet 上叠 MapLibre 时可设 false 让 Leaflet 底图透出）
  includeBaseRaster?: boolean
}

export function buildStyle(opts: BuildStyleOptions): StyleSpecification {
  const { urlTemplate, layers, maxZoom, includeBaseRaster = true } = opts
  const sources: StyleSpecification['sources'] = {
    mvt: {
      type: 'vector',
      tiles: [urlTemplate.replace(/\{s\}/g, 'a')],
      minzoom: 0,
      maxzoom: maxZoom,
    },
  }
  const initialLayers: StyleSpecification['layers'] = []
  if (includeBaseRaster) {
    sources.osm = {
      type: 'raster',
      tiles: [
        'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap',
    }
    initialLayers.push({
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-opacity': 0.4 },
    })
  }
  const style: StyleSpecification = {
    version: 8,
    sources,
    layers: initialLayers,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
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
