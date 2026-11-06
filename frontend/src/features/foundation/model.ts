export const FOUNDATION_IDS = [
  'water',
  'roads',
  'railways',
  'settlements',
] as const
export type FoundationId = (typeof FOUNDATION_IDS)[number]
export type FoundationBounds = {
  west: number
  south: number
  east: number
  north: number
}
export type CoordinateMode = 'auto' | 'wgs84' | 'gcj02'
export interface LayerStyle {
  visible: boolean
  color: string
  width: number
  labels: boolean
}
export interface FoundationSettings {
  layers: Record<FoundationId, LayerStyle>
  fontSize: number
  coordinates: CoordinateMode
}
export interface LayerRecord {
  phase: 'off' | 'zoom' | 'loading' | 'ready' | 'error'
  error: string | null
  tiles?: number
  pending?: number
  cached?: number
}
export const MIN_FOUNDATION_ZOOM = 8
export const FOUNDATION_DEFAULTS: FoundationSettings = {
  fontSize: 12,
  coordinates: 'auto',
  layers: {
    water: { visible: false, color: '#3185d6', width: 2, labels: true },
    roads: { visible: false, color: '#e89c32', width: 2, labels: true },
    railways: { visible: false, color: '#a17ada', width: 2, labels: true },
    settlements: { visible: false, color: '#df6262', width: 2, labels: true },
  },
}
export const emptyRecord = (): LayerRecord => ({
  phase: 'off',
  error: null,
})
export const emptyRecords = (): Record<FoundationId, LayerRecord> =>
  Object.fromEntries(FOUNDATION_IDS.map((id) => [id, emptyRecord()])) as Record<
    FoundationId,
    LayerRecord
  >
export function normalizeFoundationSettings(raw: unknown): FoundationSettings {
  const r = (
    raw && typeof raw === 'object' ? raw : {}
  ) as Partial<FoundationSettings>
  const font = Number(r.fontSize)
  return {
    fontSize: Number.isFinite(font)
      ? Math.max(10, Math.min(22, Math.round(font)))
      : 12,
    coordinates: ['auto', 'wgs84', 'gcj02'].includes(r.coordinates ?? '')
      ? r.coordinates!
      : 'auto',
    layers: Object.fromEntries(
      FOUNDATION_IDS.map((id) => {
        const d = FOUNDATION_DEFAULTS.layers[id]
        const v = r.layers?.[id]
        return [
          id,
          {
            visible: v?.visible === true,
            color: /^#[a-f\d]{6}$/i.test(v?.color ?? '') ? v!.color : d.color,
            width: [1, 2, 3, 4].includes(v?.width ?? 0) ? v!.width : d.width,
            labels: typeof v?.labels === 'boolean' ? v.labels : d.labels,
          },
        ]
      }),
    ) as Record<FoundationId, LayerStyle>,
  }
}
/** Outward grid rounding makes nearby views share a cache without dropping edges. */
export function foundationQueryBounds(
  b: FoundationBounds,
  zoom: number,
): FoundationBounds | null {
  if (
    ![b.west, b.south, b.east, b.north, zoom].every(Number.isFinite) ||
    b.south >= b.north ||
    b.west < -180 ||
    b.east > 180 ||
    b.west >= b.east
  )
    return null
  const { west, east } = b
  const step = 180 / 2 ** Math.max(4, Math.min(12, Math.floor(zoom) - 1))
  const result = {
    west: Math.max(-180, Math.floor(west / step) * step),
    south: Math.max(-85, Math.floor(b.south / step) * step),
    east: Math.min(180, Math.ceil(east / step) * step),
    north: Math.min(85, Math.ceil(b.north / step) * step),
  }
  return result.south < result.north ? result : null
}
export function boundsKey(b: FoundationBounds) {
  return [b.west, b.south, b.east, b.north].join(',')
}
export function shouldUseGcjCoordinates(mode: CoordinateMode, baseId: string) {
  return mode === 'gcj02' || (mode === 'auto' && baseId.startsWith('amap_'))
}
