import type { FoundationBounds } from './model.ts'
// Same GCJ constants and mainland envelope as the existing native admin adapter.
const A = 6378245,
  EE = 0.006693421622965943,
  PI = Math.PI
export function wgsToGcj(lng: number, lat: number): [number, number] {
  if (!(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55))
    return [lng, lat]
  const x = lng - 105,
    y = lat - 35
  let dlat =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x))
  dlat += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  dlat += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3
  dlat +=
    ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3
  let dlng =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  dlng += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
  dlng += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3
  dlng +=
    ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3
  const rad = (lat / 180) * PI,
    magic = 1 - EE * Math.sin(rad) ** 2,
    sqrt = Math.sqrt(magic)
  return [
    lng + (dlng * 180) / ((A / sqrt) * Math.cos(rad) * PI),
    lat + (dlat * 180) / (((A * (1 - EE)) / (magic * sqrt)) * PI),
  ]
}
export function gcjToWgs(lng: number, lat: number): [number, number] {
  let x = lng,
    y = lat
  for (let i = 0; i < 4; i++) {
    const p = wgsToGcj(x, y)
    x += lng - p[0]
    y += lat - p[1]
  }
  return [x, y]
}
export function gcjBoundsToWgs(b: FoundationBounds): FoundationBounds {
  const points = [
    [b.west, b.south],
    [b.west, b.north],
    [b.east, b.south],
    [b.east, b.north],
    [(b.west + b.east) / 2, (b.south + b.north) / 2],
  ].map(([x, y]) => gcjToWgs(x, y))
  return {
    west: Math.min(...points.map((p) => p[0])) - 0.0001,
    east: Math.max(...points.map((p) => p[0])) + 0.0001,
    south: Math.min(...points.map((p) => p[1])) - 0.0001,
    north: Math.max(...points.map((p) => p[1])) + 0.0001,
  }
}
