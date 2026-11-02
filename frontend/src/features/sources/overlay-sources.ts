import type { TileSource } from '../../types/api'
import { isMvtUrl } from '../mvt/is-mvt-url.ts'

export function overlayCandidates(sources: Record<string, TileSource>, baseId?: string | null) {
  return Object.entries(sources)
    .filter(([id, source]) => id !== baseId && id !== 'dem_terrarium'
      && !!(source.url ?? source.url_template) && !isMvtUrl(source.url ?? source.url_template))
    .map(([id, source]) => ({ ...source, id }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Keep ordering and credentials on the source itself; only source IDs are stored
// in overlay selections and passed to downloads.
export function validOverlayIds(ids: string[], sources: Record<string, TileSource>, baseId?: string | null) {
  const available = new Set(overlayCandidates(sources, baseId).map((source) => source.id))
  return [...new Set(ids)].filter((id) => available.has(id))
}

export function rememberedOverlayIds(visibility: Record<string, boolean> = {}) {
  const aliases: Record<string, string> = { cia: 'tianditu_satellite_label', cva: 'tianditu_vector_label' }
  return [...new Set(Object.entries(visibility).filter(([, visible]) => visible === true)
    .map(([id]) => aliases[id] ?? id))]
}

export function moveOverlay(ids: string[], index: number, delta: -1 | 1) {
  const target = index + delta
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return ids
  const next = [...ids]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}
