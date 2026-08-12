import type { Feature } from 'geojson'
import type { Bounds, Polygon } from '@/types/api'
import { extractAreaGeometry, outerRingsFromAreaGeometry } from '@/lib/geo-area'

/** 清理文件名（移除 Windows/Mac/Linux 禁用字符） */
export function sanitizeFilename(name: unknown, fallbackIndex: number): string {
  if (name == null || name === '') return String(fallbackIndex).padStart(3, '0')
  const s = String(name)
    .replace(/\.(geojson|json|shp|shx|dbf|prj|zip)$/i, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 100)
    .trim()
  return s || String(fallbackIndex).padStart(3, '0')
}

/** 推荐命名字段 */
export function recommendNameField(keys: string[]): string | null {
  const priorities = [
    '__source_file',
    'name', 'NAME', 'Name',
    'title', 'TITLE', 'Title',
    'id', 'ID', 'Id',
    'code', 'CODE', 'Code',
    'objectid', 'OBJECTID', 'fid', 'FID',
  ]
  for (const k of priorities) if (keys.includes(k)) return k
  return keys[0] ?? null
}

/** 收集所有要素的属性键（排除 __ 内部字段，但保留 __source_file） */
export function collectPropertyKeys(features: Feature[]): string[] {
  const set = new Set<string>()
  let hasSourceFile = false
  for (const f of features) {
    if (!f.properties) continue
    for (const k of Object.keys(f.properties)) {
      if (k === '__source_file') hasSourceFile = true
      else if (!k.startsWith('__')) set.add(k)
    }
  }
  const keys = Array.from(set)
  if (hasSourceFile) keys.unshift('__source_file')
  return keys
}

/** 计算 Feature 中所有面几何的 bbox。 */
export function featureBbox(feature: Feature): Bounds | null {
  const coords: number[][] = []
  const geom = extractAreaGeometry(feature.geometry)
  if (!geom) return null
  if (geom.type === 'Polygon') {
    geom.coordinates.forEach((ring) => ring.forEach((c) => coords.push(c)))
  } else if (geom.type === 'MultiPolygon') {
    geom.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach((c) => coords.push(c))))
  } else {
    return null
  }
  if (coords.length === 0) return null
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return { north: maxLat, south: minLat, east: maxLng, west: minLng }
}

export function bboxAreaKm2(b: Bounds): number {
  const R = 6371
  const latMid = ((b.north + b.south) / 2) * Math.PI / 180
  const dLat = (b.north - b.south) * Math.PI / 180
  const dLng = (b.east - b.west) * Math.PI / 180
  return Math.abs(R * R * dLat * dLng * Math.cos(latMid))
}

/** 提取 Feature 的多边形坐标（用于 crop_to_shape） */
export function extractFeaturePolygon(feature: Feature): Polygon | null {
  const geom = extractAreaGeometry(feature.geometry)
  if (!geom) return null
  const rings = outerRingsFromAreaGeometry(geom)
  if (rings.length === 0) return null
  return rings.map((ring) => ring.map((c) => ({ lat: c[1], lng: c[0] })))
}

/** 文件名去重 */
export function deduplicateFilenames(names: string[]): string[] {
  const seen: Record<string, number> = {}
  return names.map((n) => {
    if (!seen[n]) {
      seen[n] = 1
      return n
    }
    return `${n}_${seen[n]++}`
  })
}
