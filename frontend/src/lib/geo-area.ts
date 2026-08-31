import type {
  Feature,
  FeatureCollection,
  GeoJsonObject,
  Geometry,
  MultiPolygon,
  Polygon,
  Position,
} from 'geojson'

export type AreaGeometry = Polygon | MultiPolygon

const EARTH_RADIUS_METERS = 6_371_008.8
const DEG_TO_RAD = Math.PI / 180

function polygonCoordinates(geometry: Geometry): Position[][][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates
  if (geometry.type === 'GeometryCollection') {
    return geometry.geometries.flatMap(polygonCoordinates)
  }
  return []
}

/** Return only area geometry, recursively extracting it from mixed collections. */
export function extractAreaGeometry(
  geometry: Geometry | null | undefined,
): AreaGeometry | null {
  if (!geometry) return null
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    return geometry
  }

  const polygons = polygonCoordinates(geometry)
  if (polygons.length === 0) return null
  if (polygons.length === 1) {
    return { type: 'Polygon', coordinates: polygons[0] }
  }
  return { type: 'MultiPolygon', coordinates: polygons }
}

export function extractAreaFeatures(geojson: GeoJsonObject): Feature<AreaGeometry>[] {
  const toAreaFeature = (feature: Feature): Feature<AreaGeometry> | null => {
    const geometry = extractAreaGeometry(feature.geometry)
    return geometry ? { ...feature, geometry } : null
  }

  if (geojson.type === 'FeatureCollection') {
    return (geojson as FeatureCollection).features
      .map(toAreaFeature)
      .filter((feature): feature is Feature<AreaGeometry> => feature !== null)
  }
  if (geojson.type === 'Feature') {
    const feature = toAreaFeature(geojson as Feature)
    return feature ? [feature] : []
  }

  const geometry = extractAreaGeometry(geojson as Geometry)
  return geometry
    ? [{ type: 'Feature', properties: null, geometry }]
    : []
}

export function outerRingsFromAreaGeometry(geometry: AreaGeometry): Position[][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]]
  return geometry.coordinates.map((polygon) => polygon[0])
}

function validPosition(position: Position): boolean {
  return (
    position.length >= 2 &&
    Number.isFinite(position[0]) &&
    Number.isFinite(position[1]) &&
    position[0] >= -180 &&
    position[0] <= 180 &&
    position[1] >= -90 &&
    position[1] <= 90
  )
}

function ringAreaSquareMeters(ring: Position[]): number | null {
  if (ring.length < 3 || ring.some((position) => !validPosition(position))) return null
  let sum = 0
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]
    const next = ring[(index + 1) % ring.length]
    let deltaLongitude = (next[0] - current[0]) * DEG_TO_RAD
    if (deltaLongitude > Math.PI) deltaLongitude -= 2 * Math.PI
    if (deltaLongitude < -Math.PI) deltaLongitude += 2 * Math.PI
    sum += deltaLongitude * (
      2 +
      Math.sin(current[1] * DEG_TO_RAD) +
      Math.sin(next[1] * DEG_TO_RAD)
    )
  }
  return Math.abs(sum * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS / 2)
}

function polygonAreaSquareMeters(polygon: Position[][]): number | null {
  if (polygon.length === 0) return null
  const outer = ringAreaSquareMeters(polygon[0])
  if (outer == null) return null
  let holes = 0
  for (const ring of polygon.slice(1)) {
    const area = ringAreaSquareMeters(ring)
    if (area == null) return null
    holes += area
  }
  return Math.max(0, outer - holes)
}

/** Calculate the actual spherical area of Polygon/MultiPolygon geometry. */
export function featureAreaKm2(feature: Feature): number | null {
  const geometry = extractAreaGeometry(feature.geometry)
  if (!geometry) return null
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  let total = 0
  for (const polygon of polygons) {
    const area = polygonAreaSquareMeters(polygon)
    if (area == null) return null
    total += area
  }
  const squareKilometers = total / 1_000_000
  return Number.isFinite(squareKilometers) ? squareKilometers : null
}

interface GeometrySummary {
  areas: number
  lines: number
  points: number
}

function summarizeGeometry(geometry: Geometry | null | undefined): GeometrySummary {
  if (!geometry) return { areas: 0, lines: 0, points: 0 }
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    return { areas: 1, lines: 0, points: 0 }
  }
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
    return { areas: 0, lines: 1, points: 0 }
  }
  if (geometry.type === 'Point' || geometry.type === 'MultiPoint') {
    return { areas: 0, lines: 0, points: 1 }
  }
  if (geometry.type === 'GeometryCollection') {
    return geometry.geometries.reduce<GeometrySummary>(
      (summary, item) => {
        const next = summarizeGeometry(item)
        return {
          areas: summary.areas + next.areas,
          lines: summary.lines + next.lines,
          points: summary.points + next.points,
        }
      },
      { areas: 0, lines: 0, points: 0 },
    )
  }
  return { areas: 0, lines: 0, points: 0 }
}

export type RegionAreaErrorReason = 'lines-and-points' | 'lines' | 'points' | 'missing'

export function regionAreaErrorReason(geojson: GeoJsonObject): RegionAreaErrorReason {
  const geometries: Array<Geometry | null | undefined> =
    geojson.type === 'FeatureCollection'
      ? (geojson as FeatureCollection).features.map((feature) => feature.geometry)
      : geojson.type === 'Feature'
        ? [(geojson as Feature).geometry]
        : [geojson as Geometry]

  const summary = geometries.reduce<GeometrySummary>(
    (total, geometry) => {
      const next = summarizeGeometry(geometry)
      return {
        areas: total.areas + next.areas,
        lines: total.lines + next.lines,
        points: total.points + next.points,
      }
    },
    { areas: 0, lines: 0, points: 0 },
  )

  if (summary.lines > 0 && summary.points > 0) {
    return 'lines-and-points'
  }
  if (summary.lines > 0) {
    return 'lines'
  }
  if (summary.points > 0) {
    return 'points'
  }
  return 'missing'
}

export function regionAreaErrorMessage(geojson: GeoJsonObject): string {
  const reason = regionAreaErrorReason(geojson)
  if (reason === 'lines-and-points') {
    return '文件已解析，但仅包含开放线和点要素，无法作为下载区域。请将闭合边界转换为 Polygon 后重试'
  }
  if (reason === 'lines') {
    return '文件已解析，但仅包含开放线要素，无法作为下载区域。请闭合边界并转换为 Polygon 后重试'
  }
  if (reason === 'points') {
    return '文件已解析，但仅包含点要素，无法作为下载区域。请选择或转换为 Polygon 面要素'
  }
  return '文件已解析，但没有可用的 Polygon / MultiPolygon 面要素'
}
