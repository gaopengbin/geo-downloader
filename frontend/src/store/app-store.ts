import { create } from 'zustand'

export type AppMode = 'imagery' | 'dem' | 'wayback' | 'tiles3d' | 'vector'
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
  /** 当前选中的行政区划代码（街道/区县/城市/省），用于边界下载 */
  currentAdminCode: string | null
  setCurrentAdminCode: (code: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  mode: 'imagery',
  setMode: (mode) => set({ mode }),
  tab: 'download',
  setTab: (tab) => set({ tab }),
  selectedSourceByMode: {},
  setSelectedSourceForMode: (mode, key) =>
    set((s) => ({
      selectedSourceByMode: { ...s.selectedSourceByMode, [mode]: key },
    })),
  overlayVisibilityByMode: {},
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
  currentAdminCode: null,
  setCurrentAdminCode: (code) => set({ currentAdminCode: code }),
}))
