import { create } from 'zustand'
import type { HistoricalProvider, HistoryProvider } from '@/features/sources/historical-source-info'
import type { EarthCatalog, EarthPlan } from '@/features/wayback/earth-history-api'
import type { EarthView, KeyholeCatalog, KeyholePreview } from '@/features/wayback/keyhole-api'

interface WaybackPreviewState {
  earthView: EarthView | null
  earthPointCatalog: KeyholeCatalog | null
  earthPreview: KeyholePreview | null
  setEarthView: (view: EarthView) => void
  setEarthPointCatalog: (catalog: KeyholeCatalog) => void
  setEarthPreview: (preview: KeyholePreview | null) => void
  earthCatalog: EarthCatalog | null
  earthDate: string | null
  earthPlan: EarthPlan | null
  earthZoom: number
  setEarthZoom: (zoom: number) => void
  setEarthCatalog: (catalog: EarthCatalog | null) => void
  setEarthDate: (date: string) => void
  setEarthPlan: (plan: EarthPlan | null) => void
  provider: HistoryProvider
  setProvider: (provider: HistoryProvider) => void
  sourceByProvider: Partial<Record<HistoricalProvider, string>>
  rememberSource: (provider: HistoricalProvider, source: string) => void
  /** 当前预览中的 Wayback 版本 id（数字 key），null 时不预览 */
  previewVersionId: string | null
  setPreviewVersionId: (id: string | null) => void
}

export const useWaybackStore = create<WaybackPreviewState>((set) => ({
  earthView: null, earthPointCatalog: null, earthPreview: null,
  setEarthView: (earthView) => set((state) => JSON.stringify(state.earthView) === JSON.stringify(earthView) ? state : { earthView }),
  setEarthPointCatalog: (earthPointCatalog) => set((state) => ({ earthPointCatalog, earthDate: state.earthDate ?? earthPointCatalog.dates[0]?.date ?? null })),
  setEarthPreview: (earthPreview) => set({ earthPreview }),
  earthCatalog: null, earthDate: null, earthPlan: null, earthZoom: 17,
  setEarthZoom: (earthZoom) => set({ earthZoom, earthCatalog: null, earthPlan: null }),
  setEarthCatalog: (earthCatalog) => set((state) => ({ earthCatalog, earthPlan: null,
    earthDate: earthCatalog?.dates.some((d) => d.date === state.earthDate && d.supportedNodes > 0)
      ? state.earthDate : earthCatalog?.dates.find((d) => d.supportedNodes > 0)?.date ?? null })),
  setEarthDate: (earthDate) => set((state) => state.earthDate === earthDate ? state : ({ earthDate, earthPlan: null, earthPreview: null })),
  setEarthPlan: (earthPlan) => set({ earthPlan }),
  provider: 'esri',
  setProvider: (provider) => set({ provider }),
  sourceByProvider: {},
  rememberSource: (provider, source) => set((state) => state.sourceByProvider[provider] === source ? state : ({
    sourceByProvider: { ...state.sourceByProvider, [provider]: source },
  })),
  previewVersionId: null,
  setPreviewVersionId: (id) => set({ previewVersionId: id }),
}))
