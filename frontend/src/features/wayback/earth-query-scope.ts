interface Bounds { west: number; south: number; east: number; north: number }

/** Choose a browsable grid before fetching metadata for a very large region. */
export function fitEarthQueryZoom(bounds: Bounds, requested: number): number {
  const tileY = (latitude: number, scale: number) => {
    const radians = Math.max(-85, Math.min(85, latitude)) * Math.PI / 180
    return Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * scale)
  }
  let zoom = requested
  while (zoom > 1) {
    const scale = 2 ** zoom
    const columns = Math.floor((bounds.east + 180) / 360 * scale) - Math.floor((bounds.west + 180) / 360 * scale) + 1
    const rows = tileY(bounds.south, scale) - tileY(bounds.north, scale) + 1
    if (columns * rows <= 16) break
    zoom -= 1
  }
  return zoom
}
