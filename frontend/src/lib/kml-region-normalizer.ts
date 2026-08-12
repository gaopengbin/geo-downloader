import type {
  Feature,
  FeatureCollection,
  GeoJsonObject,
  Geometry,
  Position,
} from 'geojson'

const CLOSURE_EPSILON = 1e-9

function closedRing(coordinates: Position[]): Position[] | null {
  if (coordinates.length < 4) return null

  const first = coordinates[0]
  const last = coordinates[coordinates.length - 1]
  if (
    first.length < 2 ||
    last.length < 2 ||
    Math.abs(first[0] - last[0]) > CLOSURE_EPSILON ||
    Math.abs(first[1] - last[1]) > CLOSURE_EPSILON
  ) {
    return null
  }

  return coordinates
}

function normalizeGeometry(geometry: Geometry): Geometry {
  if (geometry.type === 'LineString') {
    const ring = closedRing(geometry.coordinates)
    return ring ? { type: 'Polygon', coordinates: [ring] } : geometry
  }

  if (geometry.type === 'MultiLineString') {
    const rings = geometry.coordinates.map(closedRing)
    if (rings.some((ring) => ring === null)) return geometry

    const closedRings = rings as Position[][]
    if (closedRings.length === 1) {
      return { type: 'Polygon', coordinates: [closedRings[0]] }
    }
    return {
      type: 'MultiPolygon',
      coordinates: closedRings.map((ring) => [ring]),
    }
  }

  if (geometry.type === 'GeometryCollection') {
    const geometries = geometry.geometries.map(normalizeGeometry)
    if (
      geometries.length > 0 &&
      geometries.every(
        (item) => item.type === 'Polygon' || item.type === 'MultiPolygon',
      )
    ) {
      const polygons = geometries.flatMap((item) =>
        item.type === 'Polygon' ? [item.coordinates] : item.coordinates,
      )
      if (polygons.length === 1) {
        return { type: 'Polygon', coordinates: polygons[0] }
      }
      return { type: 'MultiPolygon', coordinates: polygons }
    }

    return {
      ...geometry,
      geometries,
    }
  }

  return geometry
}

/** Convert closed KML boundary lines into area geometry for region imports. */
export function normalizeClosedKmlBoundaries(geojson: GeoJsonObject): GeoJsonObject {
  if (geojson.type === 'FeatureCollection') {
    const collection = geojson as FeatureCollection
    return {
      ...collection,
      features: collection.features.map((feature) => ({
        ...feature,
        geometry: feature.geometry ? normalizeGeometry(feature.geometry) : null,
      })),
    } as unknown as GeoJsonObject
  }

  if (geojson.type === 'Feature') {
    const feature = geojson as Feature
    return {
      ...feature,
      geometry: feature.geometry ? normalizeGeometry(feature.geometry) : null,
    } as unknown as GeoJsonObject
  }

  return normalizeGeometry(geojson as Geometry)
}
