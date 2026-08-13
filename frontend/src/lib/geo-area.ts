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
