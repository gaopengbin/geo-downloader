import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createSafeJSONStorage } from '@/store/persist-storage'
import { normalizeOverlaySelection, reorderOverlaySelection, restoreOverlaySelections, sameOverlaySelection, type OverlaySelection } from '@/features/sources/layer-selection'

export type AppMode = 'imagery' | 'dem' | 'wayback' | 'tiles3d' | 'vector' | 'mvt'
export type SidebarTab = 'download' | 'history' | 'settings'

export interface AppState {
  mode: AppMode
  setMode: (mode: AppMode) => void
  tab: SidebarTab
  setTab: (tab: SidebarTab) => void
  /** 各 mode 各自记忆的图源 key（供地图预览跟随） */
  selectedSourceByMode: Partial<Record<AppMode, string | null>>
  setSelectedSourceForMode: (mode: AppMode, key: string | null) => void
  /** 地图与下载共用的有序叠加层；visible 同时决定预览与新任务是否包含该层。 */
  overlayLayersByMode: Partial<Record<AppMode, OverlaySelection[]>>
  setOverlayVisibility: (mode: AppMode, key: string, visible: boolean) => void
  setOverlaySources: (mode: AppMode, ids: string[]) => void
  /** 地图经纬度网格显示 */
  graticuleVisible: boolean
  setGraticuleVisible: (visible: boolean) => void
  /** 经纬度网格间隔（单位：度） */
  graticuleInterval: number
  setGraticuleInterval: (interval: number) => void
  /** 经纬度网格是否根据当前视野自动选择间隔 */
  graticuleAuto: boolean
  setGraticuleAuto: (auto: boolean) => void
  /** 当前选中的行政区划代码（街道/区县/城市/省），用于边界下载 */
  currentAdminCode: string | null
  setCurrentAdminCode: (code: string | null) => void
  /** 行政区下拉的三段式选择，分别持久化（避免直辖市这种省直接挂区县的场景被错误回填） */
  adminSelection: { provinceCode: string; cityCode: string; districtCode: string }
  setAdminSelection: (sel: { provinceCode: string; cityCode: string; districtCode: string }) => void
}

const APP_STORAGE_KEY = 'geo-downloader:app'
const APP_MODES: AppMode[] = ['imagery', 'dem', 'wayback', 'tiles3d', 'vector', 'mvt']
const SIDEBAR_TABS: SidebarTab[] = ['download', 'history', 'settings']

type PersistedAppState = Partial<
  Pick<
    AppState,
    | 'mode'
    | 'tab'
    | 'selectedSourceByMode'
    | 'overlayLayersByMode'
    | 'graticuleVisible'
    | 'graticuleInterval'
    | 'graticuleAuto'
    | 'currentAdminCode'
    | 'adminSelection'
  >
>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function legacyDownloadState() {
  try {
    const raw = localStorage.getItem('geo-downloader:imagery-params')
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed.state ?? parsed
  } catch { return {} }
}

function normalizePersistedAppState(value: unknown): PersistedAppState {
    const state = value as Record<string, unknown>
    if (!state || !isPlainObject(state)) return {}
    return {
      mode: APP_MODES.includes(state.mode as AppMode) ? (state.mode as AppMode) : undefined,
      tab: SIDEBAR_TABS.includes(state.tab as SidebarTab) ? (state.tab as SidebarTab) : undefined,
      selectedSourceByMode: isPlainObject(state.selectedSourceByMode) ? state.selectedSourceByMode as AppState['selectedSourceByMode'] : undefined,
      overlayLayersByMode: restoreOverlaySelections(state, legacyDownloadState()),
      graticuleVisible: typeof state.graticuleVisible === 'boolean' ? state.graticuleVisible : undefined,
      graticuleInterval: typeof state.graticuleInterval === 'number' && Number.isFinite(state.graticuleInterval) ? state.graticuleInterval : undefined,
      graticuleAuto: typeof state.graticuleAuto === 'boolean' ? state.graticuleAuto : undefined,
      currentAdminCode: typeof state.currentAdminCode === 'string' ? state.currentAdminCode : null,
      adminSelection: isPlainObject(state.adminSelection) && typeof state.adminSelection.provinceCode === 'string'
        && typeof state.adminSelection.cityCode === 'string' && typeof state.adminSelection.districtCode === 'string'
        ? state.adminSelection as AppState['adminSelection'] : undefined,
    }
}

function readPersistedAppState(): PersistedAppState {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(APP_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { state?: PersistedAppState } & Record<string, unknown>
    return normalizePersistedAppState(parsed.state ?? parsed)
  } catch {
    return {}
  }
}

const restoredAppState = readPersistedAppState()

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      mode: restoredAppState.mode ?? 'imagery',
      setMode: (mode) => set({ mode }),
      tab: restoredAppState.tab ?? 'download',
      setTab: (tab) => set({ tab }),
      selectedSourceByMode: restoredAppState.selectedSourceByMode ?? {},
      setSelectedSourceForMode: (mode, key) => set((s) => {
        const layers = normalizeOverlaySelection(s.overlayLayersByMode[mode], key)
        if (s.selectedSourceByMode[mode] === key && sameOverlaySelection(s.overlayLayersByMode[mode], layers)) return s
        return { selectedSourceByMode: { ...s.selectedSourceByMode, [mode]: key }, overlayLayersByMode: { ...s.overlayLayersByMode, [mode]: layers } }
      }),
      overlayLayersByMode: restoredAppState.overlayLayersByMode ?? restoreOverlaySelections({}, legacyDownloadState()),
      setOverlayVisibility: (mode, key, visible) =>
        set((s) => {
          const cur = s.overlayLayersByMode[mode] ?? []
          const layers = normalizeOverlaySelection(cur.some((entry) => entry.sourceId === key)
            ? cur.map((entry) => entry.sourceId === key ? { ...entry, visible } : entry) : [...cur, { sourceId: key, visible }], s.selectedSourceByMode[mode])
          return sameOverlaySelection(cur, layers) ? s : { overlayLayersByMode: { ...s.overlayLayersByMode, [mode]: layers } }
        }),
      setOverlaySources: (mode, ids) => set((s) => {
        const cur = s.overlayLayersByMode[mode] ?? []
        const layers = reorderOverlaySelection(cur, ids, s.selectedSourceByMode[mode])
        return sameOverlaySelection(cur, layers) ? s : { overlayLayersByMode: { ...s.overlayLayersByMode, [mode]: layers } }
      }),
      graticuleVisible: restoredAppState.graticuleVisible ?? false,
      setGraticuleVisible: (visible) => set({ graticuleVisible: visible }),
      graticuleInterval: restoredAppState.graticuleInterval ?? 1,
      setGraticuleInterval: (interval) => set({ graticuleInterval: interval }),
      graticuleAuto: restoredAppState.graticuleAuto ?? true,
      setGraticuleAuto: (auto) => set({ graticuleAuto: auto }),
      currentAdminCode: restoredAppState.currentAdminCode ?? null,
      setCurrentAdminCode: (code) => set({ currentAdminCode: code }),
      adminSelection:
        restoredAppState.adminSelection ?? {
          provinceCode: '',
          cityCode: '',
          districtCode: '',
        },
      setAdminSelection: (sel) => set({ adminSelection: sel }),
    }),
    {
      name: 'geo-downloader:app',
      version: 2,
      migrate: (state) => normalizePersistedAppState(state),
      merge: (persisted, current) => ({ ...current, ...Object.fromEntries(
        Object.entries(normalizePersistedAppState(persisted)).filter(([, value]) => value !== undefined),
      ) }),
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        mode: state.mode,
        tab: state.tab,
        selectedSourceByMode: state.selectedSourceByMode,
        overlayLayersByMode: state.overlayLayersByMode,
        graticuleVisible: state.graticuleVisible,
        graticuleInterval: state.graticuleInterval,
        graticuleAuto: state.graticuleAuto,
        currentAdminCode: state.currentAdminCode,
        adminSelection: state.adminSelection,
      }),
    },
  ),
)

// Commit the migrated composition before the legacy parameter store can save
// unrelated fields and discard its old overlay list (including on first boot).
try {
  const saved = JSON.parse(localStorage.getItem(APP_STORAGE_KEY) ?? 'null')
  if (saved?.version !== 2) useAppStore.setState((state) => state)
} catch { /* Safe storage handles unavailable/full storage; the in-memory state remains usable. */ }
