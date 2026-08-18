import type { Bounds, Polygon } from '@/types/api'

export function boundsToCropPolygon(bounds: Bounds): Polygon {
  return [
    [
      { lat: bounds.north, lng: bounds.west },
      { lat: bounds.north, lng: bounds.east },
      { lat: bounds.south, lng: bounds.east },
      { lat: bounds.south, lng: bounds.west },
    ],
  ]
}

export function buildSelectionCropPolygon(
  bounds: Bounds | null | undefined,
  polygon: Polygon | null | undefined,
  enabled: boolean,
): Polygon | null {
  if (!enabled || !bounds) return null
  if (polygon && polygon.length > 0) return polygon
  return boundsToCropPolygon(bounds)
}
