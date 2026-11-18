import { create } from 'zustand'
import { invokeCommand } from '@/lib/tauri'
import type { RasterStatus } from '@/features/foundation/raster-layer'

export interface OsmPreviewEntry {
  id: string
  name: string
  featureCount: number
  visible: boolean
  color: string
  status?: RasterStatus
}
interface OsmPreviewState {
  layers: OsmPreviewEntry[]
  add: (entry: Omit<OsmPreviewEntry, 'visible'>) => void
  toggle: (id: string, visible: boolean) => void
  remove: (id: string) => void
  status: (id: string, status: RasterStatus) => void
}
export const useOsmPreviewStore = create<OsmPreviewState>((set) => ({
  layers: [],
  add: (entry) => set(s => ({ layers: [...s.layers, { ...entry, visible: true }] })),
  toggle: (id, visible) => set(s => ({ layers: s.layers.map(l => l.id === id ? { ...l, visible } : l) })),
  remove: (id) => {
    set(s => ({ layers: s.layers.filter(l => l.id !== id) }))
    void invokeCommand('osm_preview_remove', { id }).catch(() => {})
  },
  status: (id, status) => set(s => ({ layers: s.layers.map(l => l.id === id ? { ...l, status } : l) })),
}))
