import type { TileSource } from '../../types/api.ts'
import { validOverlayIds } from './overlay-sources.ts'

export interface OverlaySelection { sourceId: string; visible: boolean }
export const EMPTY_OVERLAY_SELECTION: OverlaySelection[] = []
const MODES = ['imagery', 'dem', 'wayback', 'tiles3d', 'vector', 'mvt'] as const
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function normalizeOverlaySelection(value: unknown, baseId?: string | null): OverlaySelection[] {
  const result: OverlaySelection[] = []
  if (!Array.isArray(value)) return result
  for (const item of value) {
    const sourceId = typeof item === 'string' ? item : record(item).sourceId
    if (typeof sourceId !== 'string' || !sourceId || sourceId === baseId || result.some((entry) => entry.sourceId === sourceId)) continue
    result.push({ sourceId, visible: typeof item === 'string' || record(item).visible !== false })
  }
  return result
}

export function sameOverlaySelection(a: OverlaySelection[] = [], b: OverlaySelection[] = []) {
  return a.length === b.length && a.every((entry, index) => entry.sourceId === b[index].sourceId && entry.visible === b[index].visible)
}

export function reorderOverlaySelection(current: OverlaySelection[], ids: string[], baseId?: string | null) {
  return normalizeOverlaySelection(ids.map((sourceId) => current.find((entry) => entry.sourceId === sourceId) ?? { sourceId, visible: true }), baseId)
}

export function enabledOverlayIds(layers: OverlaySelection[], sources: Record<string, TileSource>, baseId?: string | null) {
  return validOverlayIds(layers.filter((entry) => entry.visible).map((entry) => entry.sourceId), sources, baseId)
}

// Preserve the previous download composition when upgrading. Explicit empty
// lists stay empty; preview-only preferences are a fallback for untouched modes.
export function restoreOverlaySelections(app: unknown, oldDownload: unknown) {
  const state = record(app)
  const canonical = record(state.overlayLayersByMode)
  const downloads = record(record(oldDownload).overlaySourcesByMode)
  const previews = record(state.overlayVisibilityByMode)
  const bases = record(state.selectedSourceByMode)
  return Object.fromEntries(MODES.map((mode) => {
    const base = typeof bases[mode] === 'string' ? bases[mode] as string : null
    if (Array.isArray(canonical[mode])) return [mode, normalizeOverlaySelection(canonical[mode], base)]
    if (Array.isArray(downloads[mode])) return [mode, normalizeOverlaySelection(downloads[mode], base)]
    const aliases: Record<string, string> = { cia: 'tianditu_satellite_label', cva: 'tianditu_vector_label' }
    const legacy = Object.entries(record(previews[mode])).map(([id, visible]) => ({ sourceId: aliases[id] ?? id, visible: visible === true }))
    return [mode, normalizeOverlaySelection(legacy, base)]
  }))
}
