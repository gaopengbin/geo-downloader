import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createSafeJSONStorage } from '@/store/persist-storage'

export interface MapBounds {
  north: number
  south: number
  east: number
  west: number
}

export type LatLngRing = { lat: number; lng: number }[]

/** 单个导入要素（来自 GeoJSON/Shapefile/KML/KMZ 中的单个 Feature） */
export interface ImportedFeature {
  name: string
  bounds: MapBounds
  rings: LatLngRing[]
  areas?: SelectionAreas
}

/** Coordinates are grouped as polygons, rings, then [longitude, latitude]. */
export type SelectionAreas = number[][][][]

export function selectedAreas(state: Pick<SelectionState, 'areas' | 'polygon'>): SelectionAreas | null {
  if (state.areas?.length) return state.areas
  return state.polygon?.length ? state.polygon.map(ring => [ring.map(point => [point.lng, point.lat])]) : null
}

export interface SelectionState {
  areas: SelectionAreas | null
  bounds: MapBounds | null
  polygon: LatLngRing[] | null
  /** 多要素导入：每个要素单独保留，便于下载时选择「合并」或「拆分为 N 个任务」 */
  features: ImportedFeature[] | null
  /** 自增版本号：每次外部（数字框/边界加载等）写入 +1，用于通知地图同步绘制 */
  externalRevision: number
  setSelection: (next: { bounds: MapBounds | null; polygon: LatLngRing[] | null; areas?: SelectionAreas | null }) => void
  setBoundsFromInputs: (bounds: MapBounds) => void
  /** 外部（行政边界/上传 GeoJSON 等）整体设置选区，会触发地图重绘 */
  setExternalSelection: (next: {
    bounds: MapBounds | null
    polygon: LatLngRing[] | null
    areas?: SelectionAreas | null
    features?: ImportedFeature[] | null
  }) => void
  clear: () => void
}

const SELECTION_STORAGE_KEY = 'geo-downloader:selection'

type PersistedSelection = Pick<SelectionState, 'bounds' | 'polygon'> & { areas?: SelectionAreas | null }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isMapBounds(value: unknown): value is MapBounds {
  if (!value || typeof value !== 'object') return false
  const b = value as MapBounds
  return (
    isFiniteNumber(b.north) &&
    isFiniteNumber(b.south) &&
    isFiniteNumber(b.east) &&
    isFiniteNumber(b.west)
  )
}

function isLatLngRing(value: unknown): value is LatLngRing {
  return (
    Array.isArray(value) &&
    value.every(
      (p) =>
        p &&
        typeof p === 'object' &&
        isFiniteNumber((p as { lat?: unknown }).lat) &&
        isFiniteNumber((p as { lng?: unknown }).lng),
    )
  )
}

function isPolygon(value: unknown): value is LatLngRing[] {
  return Array.isArray(value) && value.every(isLatLngRing)
}

function restoredAreas(value: unknown): SelectionAreas | null {
  if (!Array.isArray(value) || !value.length) return null
  return value.every(part => Array.isArray(part) && part.length && part.every(ring =>
    Array.isArray(ring) && ring.length >= 3 && ring.every(point =>
      Array.isArray(point) && point.length >= 2 && isFiniteNumber(point[0]) && isFiniteNumber(point[1]),
    ),
  )) ? value as SelectionAreas : null
}

function readPersistedSelection(): PersistedSelection | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      state?: Partial<PersistedSelection>
      bounds?: unknown
      polygon?: unknown
    }
    const state: { bounds?: unknown; polygon?: unknown; areas?: SelectionAreas | null } = parsed.state ?? parsed
    const bounds = isMapBounds(state?.bounds) ? state.bounds : null
    const polygon = isPolygon(state?.polygon) ? state.polygon : null
    if (!bounds && !polygon) return null
    return { bounds, polygon, areas: restoredAreas(state.areas) }
  } catch {
    return null
  }
}

function writePersistedSelection(selection: PersistedSelection) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(
      SELECTION_STORAGE_KEY,
      JSON.stringify({ state: selection, version: 1 }),
    )
  } catch {
    // localStorage may be unavailable in restricted environments.
  }
}

const restoredSelection = readPersistedSelection()

export const useSelectionStore = create<SelectionState>()(
  persist(
    (set) => ({
      areas: restoredSelection?.areas ?? null,
      bounds: restoredSelection?.bounds ?? null,
      polygon: restoredSelection?.polygon ?? null,
      features: null,
      externalRevision: restoredSelection ? 1 : 0,
      setSelection: ({ bounds, polygon, areas }) =>
        set((s) => {
          const next = {
            bounds,
            polygon,
            areas: areas?.some(part => part.length > 1) ? areas : null,
            features: null,
            externalRevision: s.externalRevision + 1,
          }
          writePersistedSelection({ bounds, polygon, areas: next.areas })
          return next
        }),
      setBoundsFromInputs: (bounds) =>
        set((s) => {
          const next = {
            bounds,
            polygon: null,
            areas: null,
            features: null,
            externalRevision: s.externalRevision + 1,
          }
          writePersistedSelection({ bounds, polygon: null })
          return next
        }),
      setExternalSelection: ({ bounds, polygon, areas, features }) =>
        set((s) => {
          const next = {
            bounds,
            polygon,
            areas: areas?.some(part => part.length > 1) ? areas : null,
            features: features ?? null,
            externalRevision: s.externalRevision + 1,
          }
          writePersistedSelection({ bounds, polygon, areas: next.areas })
          return next
        }),
      clear: () =>
        set((s) => {
          const next = {
            bounds: null,
            polygon: null,
            areas: null,
            features: null,
            externalRevision: s.externalRevision + 1,
          }
          writePersistedSelection({ bounds: null, polygon: null })
          return next
        }),
    }),
    {
      name: 'geo-downloader:selection',
      version: 1,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        bounds: state.bounds,
        polygon: state.polygon,
        areas: state.areas,
      }),
      merge: (persisted, current) => {
        const restored = persisted as Partial<SelectionState> | undefined
        const hasSelection = !!restored?.bounds || !!restored?.polygon
        return {
          ...current,
          bounds: restored?.bounds ?? null,
          polygon: restored?.polygon ?? null,
          areas: restoredAreas(restored?.areas),
          features: null,
          externalRevision: hasSelection ? current.externalRevision + 1 : current.externalRevision,
        }
      },
    },
  ),
)
