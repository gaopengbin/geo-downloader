export type TileUrlCoords = {
  x: number
  y: number
  z: number
}

export function tileCoordsToQuadKey({ x, y, z }: TileUrlCoords): string {
  let key = ''
  for (let level = z; level > 0; level -= 1) {
    const mask = 2 ** (level - 1)
    let digit = 0
    if ((x & mask) !== 0) digit += 1
    if ((y & mask) !== 0) digit += 2
    key += String(digit)
  }
  return key
}

export function resolveTileUrl(
  template: string,
  coords: TileUrlCoords,
  subdomain = '',
  retinaSuffix = '',
): string {
  const invertedY = 2 ** coords.z - 1 - coords.y
  const values: Record<string, string> = {
    x: String(coords.x),
    y: String(coords.y),
    '-y': String(invertedY),
    z: String(coords.z),
    q: tileCoordsToQuadKey(coords),
    s: subdomain,
    r: retinaSuffix,
  }
  return template.replace(/\{(-?y|x|z|q|s|r)\}/g, (token, key: string) => values[key] ?? token)
}
