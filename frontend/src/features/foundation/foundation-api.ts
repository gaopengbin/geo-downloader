import { invokeCommand } from '@/lib/tauri'
import { getSettings } from '@/features/settings/settings-api'
import type { FoundationId, FoundationBounds } from './model'

export async function foundationProxy(): Promise<string | null> {
  const s = await getSettings()
  return s.proxy_enabled ? (s.proxy_url ?? null) : null
}
export interface RasterConfig {
  layers: Array<{
    layer: FoundationId
    color: string
    width: number
    labels: boolean
  }>
  font_size: number
  gcj: boolean
  revision: number
}
export function fetchFoundationRaster(
  requestId: string,
  config: RasterConfig,
  coords: { z: number; x: number; y: number },
  proxy: string | null,
) {
  return invokeCommand<{
    data_url: string
    font_available: boolean
    empty: boolean
    cache_hit: boolean
  }>('foundation_raster_tile', { requestId, config, ...coords, proxy })
}
export function cancelFoundation(requestId: string) {
  return invokeCommand<void>('foundation_cancel', { requestId }).catch(() => {})
}
export function exportFoundation(
  requestId: string,
  layers: FoundationId[],
  bounds: FoundationBounds,
  path: string,
  proxy: string | null,
) {
  return invokeCommand<{ features: number; bytes: number; path: string }>(
    'foundation_export',
    { requestId, layers, bounds, path, proxy },
  )
}
export function foundationErrorKey(error: unknown) {
  const text = String(error)
  return text.includes('CANCELLED')
    ? 'cancelled'
    : text.includes('RATE_LIMITED')
      ? 'limited'
      : text.includes('STORAGE') || text.includes('OUTPUT')
        ? 'storageError'
        : text.includes('DENSITY')
          ? 'dense'
          : text.includes('BOUNDS')
            ? 'boundsError'
            : text.includes('RESPONSE') || text.includes('CRS')
              ? 'responseError'
              : 'networkError'
}
