import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createSafeJSONStorage } from '@/store/persist-storage'
import {
  FOUNDATION_DEFAULTS,
  emptyRecords,
  normalizeFoundationSettings,
  type FoundationSettings,
  type FoundationId,
  type FoundationBounds,
  type LayerRecord,
  type LayerStyle,
} from './model'

interface FoundationState {
  settings: FoundationSettings
  records: Record<FoundationId, LayerRecord>
  viewport: { bounds: FoundationBounds; zoom: number } | null
  refresh: number
  exportState: {
    id: string
    features: number
    phase: 'saving' | 'completed' | 'error'
    error?: string
    path?: string
  } | null
  setStyle: (id: FoundationId, value: Partial<LayerStyle>) => void
  setOptions: (
    value: Partial<Pick<FoundationSettings, 'fontSize' | 'coordinates'>>,
  ) => void
  setRecord: (id: FoundationId, value: LayerRecord) => void
  setViewport: (value: FoundationState['viewport']) => void
  retry: () => void
  setExport: (value: FoundationState['exportState']) => void
}
export const useFoundationStore = create<FoundationState>()(
  persist(
    (set) => ({
      settings: normalizeFoundationSettings(FOUNDATION_DEFAULTS),
      records: emptyRecords(),
      viewport: null,
      refresh: 0,
      exportState: null,
      setStyle: (id, value) =>
        set((s) => ({
          settings: normalizeFoundationSettings({
            ...s.settings,
            layers: {
              ...s.settings.layers,
              [id]: { ...s.settings.layers[id], ...value },
            },
          }),
        })),
      setOptions: (value) =>
        set((s) => ({
          settings: normalizeFoundationSettings({ ...s.settings, ...value }),
        })),
      setRecord: (id, value) =>
        set((s) => ({ records: { ...s.records, [id]: value } })),
      setViewport: (viewport) => set({ viewport }),
      retry: () => set((s) => ({ refresh: s.refresh + 1 })),
      setExport: (exportState) => set({ exportState }),
    }),
    {
      name: 'geo-downloader:foundation-v1',
      storage: createSafeJSONStorage(),
      partialize: (s) => ({ settings: s.settings }),
      merge: (persisted, current) => ({
        ...current,
        settings: normalizeFoundationSettings(
          (persisted as { settings?: unknown })?.settings,
        ),
      }),
    },
  ),
)
