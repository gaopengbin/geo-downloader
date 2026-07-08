import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createSafeJSONStorage } from '@/store/persist-storage'

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
  /** 各 mode 各自记忆的 overlay 显隐状态（如天地图标注 cia/cva） */
  overlayVisibilityByMode: Partial<Record<AppMode, Record<string, boolean>>>
  setOverlayVisibility: (mode: AppMode, key: string, visible: boolean) => void
  /** 地图经纬度网格显示 */
  graticuleVisible: boolean
  setGraticuleVisible: (visible: boolean) => void
  /** 经纬度网格间隔（单位：度） */
  graticuleInterval: number
  setGraticuleInterval: (interval: number) => void
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
    | 'overlayVisibilityByMode'
    | 'graticuleVisible'
    | 'graticuleInterval'
    | 'currentAdminCode'
    | 'adminSelection'
  >
>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readPersistedAppState(): PersistedAppState {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(APP_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { state?: PersistedAppState } & Record<string, unknown>
    const state = parsed.state ?? parsed
    if (!state || !isPlainObject(state)) return {}
    return {
      mode: APP_MODES.includes(state.mode as AppMode) ? (state.mode as AppMode) : undefined,
      tab: SIDEBAR_TABS.includes(state.tab as SidebarTab)
        ? (state.tab as SidebarTab)
        : undefined,
      selectedSourceByMode: isPlainObject(state.selectedSourceByMode)
        ? (state.selectedSourceByMode as Partial<Record<AppMode, string | null>>)
        : undefined,
      overlayVisibilityByMode: isPlainObject(state.overlayVisibilityByMode)
        ? (state.overlayVisibilityByMode as Partial<Record<AppMode, Record<string, boolean>>>)
        : undefined,
      graticuleVisible:
        typeof state.graticuleVisible === 'boolean' ? state.graticuleVisible : undefined,
      graticuleInterval:
        typeof state.graticuleInterval === 'number' && Number.isFinite(state.graticuleInterval)
          ? state.graticuleInterval
          : undefined,
      currentAdminCode:
        typeof state.currentAdminCode === 'string' ? state.currentAdminCode : null,
      adminSelection:
        isPlainObject(state.adminSelection) &&
        typeof (state.adminSelection as Record<string, unknown>).provinceCode === 'string' &&
        typeof (state.adminSelection as Record<string, unknown>).cityCode === 'string' &&
        typeof (state.adminSelection as Record<string, unknown>).districtCode === 'string'
          ? (state.adminSelection as {
              provinceCode: string
              cityCode: string
              districtCode: string
            })
          : undefined,
    }
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
      setSelectedSourceForMode: (mode, key) =>
        set((s) => ({
          selectedSourceByMode: { ...s.selectedSourceByMode, [mode]: key },
        })),
      overlayVisibilityByMode: restoredAppState.overlayVisibilityByMode ?? {},
      setOverlayVisibility: (mode, key, visible) =>
        set((s) => {
          const cur = s.overlayVisibilityByMode[mode] ?? {}
          return {
            overlayVisibilityByMode: {
              ...s.overlayVisibilityByMode,
              [mode]: { ...cur, [key]: visible },
            },
          }
        }),
      graticuleVisible: restoredAppState.graticuleVisible ?? false,
      setGraticuleVisible: (visible) => set({ graticuleVisible: visible }),
      graticuleInterval: restoredAppState.graticuleInterval ?? 1,
      setGraticuleInterval: (interval) => set({ graticuleInterval: interval }),
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
      version: 1,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        mode: state.mode,
        tab: state.tab,
        selectedSourceByMode: state.selectedSourceByMode,
        overlayVisibilityByMode: state.overlayVisibilityByMode,
        graticuleVisible: state.graticuleVisible,
        graticuleInterval: state.graticuleInterval,
        currentAdminCode: state.currentAdminCode,
        adminSelection: state.adminSelection,
      }),
    },
  ),
)
