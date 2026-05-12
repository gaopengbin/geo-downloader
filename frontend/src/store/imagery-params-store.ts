import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { createSafeJSONStorage } from '@/store/persist-storage'
import type { OutputFormat } from '@/types/api'

export type ImageryMode = 'imagery' | 'dem' | 'mvt'

export interface ImageryParamsSnapshot {
  source: string
  sourceName: string
  zoom: number
  zoomMax: number | null
  format: OutputFormat
  compression: 'none' | 'lzw' | 'deflate'
  buildPyramid: boolean
  cropToShape: boolean
  concurrency: number
  ready: boolean
}

interface ImageryParamsState extends ImageryParamsSnapshot {
  /** 按 mode 记忆的缩放级别 */
  zoomLevelsByMode: Partial<Record<ImageryMode, number[]>>
  setZoomLevelsForMode: (mode: ImageryMode, levels: number[]) => void
  /** 按 mode 记忆的叠加图层 */
  overlaySourcesByMode: Partial<Record<ImageryMode, string[]>>
  setOverlaySourcesForMode: (mode: ImageryMode, ids: string[]) => void
  /** 按 mode 记忆的保存目录 */
  savePathByMode: Partial<Record<ImageryMode, string>>
  setSavePathForMode: (mode: ImageryMode, path: string) => void
  set: (v: Partial<ImageryParamsSnapshot>) => void
}

export const useImageryParamsStore = create<ImageryParamsState>()(
  persist(
    (set) => ({
      source: '',
      sourceName: '',
      zoom: 15,
      zoomMax: null,
      format: 'geotiff' as OutputFormat,
      compression: 'lzw',
      buildPyramid: false,
      cropToShape: true,
      concurrency: 30,
      ready: false,
      zoomLevelsByMode: {},
      setZoomLevelsForMode: (mode, levels) =>
        set((s) => ({
          zoomLevelsByMode: { ...s.zoomLevelsByMode, [mode]: levels },
        })),
      overlaySourcesByMode: {},
      setOverlaySourcesForMode: (mode, ids) =>
        set((s) => ({
          overlaySourcesByMode: { ...s.overlaySourcesByMode, [mode]: ids },
        })),
      savePathByMode: {},
      setSavePathForMode: (mode, path) =>
        set((s) => ({
          savePathByMode: { ...s.savePathByMode, [mode]: path },
        })),
      set: (v) => set((prev) => ({ ...prev, ...v, ready: true })),
    }),
    {
      name: 'geo-downloader:imagery-params',
      version: 1,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        format: state.format,
        compression: state.compression,
        buildPyramid: state.buildPyramid,
        cropToShape: state.cropToShape,
        concurrency: state.concurrency,
        zoomLevelsByMode: state.zoomLevelsByMode,
        overlaySourcesByMode: state.overlaySourcesByMode,
        savePathByMode: state.savePathByMode,
      }),
    },
  ),
)
