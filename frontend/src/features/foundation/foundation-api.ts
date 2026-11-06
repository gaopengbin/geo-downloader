import { invokeCommand } from '@/lib/tauri'
import { getSettings } from '@/features/settings/settings-api'
import type { FoundationId, FoundationBounds, FoundationPreview } from './model'

export async function foundationProxy(): Promise<string | null> {
  const s = await getSettings()
  return s.proxy_enabled ? (s.proxy_url ?? null) : null
}
export function fetchFoundation(
  requestId: string,
  layer: FoundationId,
  bounds: FoundationBounds,
  proxy: string | null,
  refresh = false,
) {
  return invokeCommand<FoundationPreview>('foundation_preview', {
    requestId,
    layer,
    bounds,
    proxy,
    refresh,
  })
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
        : text.includes('BOUNDS')
          ? 'boundsError'
          : text.includes('RESPONSE') || text.includes('CRS')
            ? 'responseError'
            : 'networkError'
}
