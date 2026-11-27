import { useEffect, useState } from 'react'
import { useSelectionStore, type ImportedFeature } from '@/store/selection-store'

export type DownloadDispatchMode = 'merge' | 'split'

export interface MultiFeatureSubmitContext {
  /** 当前导入的要素列表（可能为 null 或长度 ≤ 1，此时不需要选择模式） */
  features: ImportedFeature[] | null
  /** 是否需要展示「合并 / 拆分」选项（features 数组长度 > 1） */
  showModeSelector: boolean
  mode: DownloadDispatchMode
  setMode: (m: DownloadDispatchMode) => void
  /**
   * 包装提交函数：
   * - merge 模式（或单要素）：调用一次 submitOnce(undefined)
   * - split 模式：依次把 selection-store 切到每个要素，再调用 submitOnce(featureName)
   *   调用方在 submitOnce 内部应当读取 selection-store 的 bounds/polygon
   */
  runSubmit: (
    submitOnce: (perFeatureName?: string) => Promise<unknown>,
  ) => Promise<void>
}

export function useMultiFeatureSubmit(): MultiFeatureSubmitContext {
  const features = useSelectionStore((s) => s.features)
  const [mode, setMode] = useState<DownloadDispatchMode>('merge')
  // 当 features 失效（被清空或重新选区）时，重置为合并
  useEffect(() => {
    if (!features || features.length <= 1) setMode('merge')
  }, [features])

  const showModeSelector = !!features && features.length > 1

  const runSubmit = async (
    submitOnce: (perFeatureName?: string) => Promise<unknown>,
  ) => {
    if (!showModeSelector || mode === 'merge' || !features) {
      await submitOnce()
      return
    }
    const snapshot = useSelectionStore.getState()
    const origBounds = snapshot.bounds
    const origPolygon = snapshot.polygon
    try {
      for (const feat of features) {
        useSelectionStore.setState({
          bounds: feat.bounds,
          polygon: feat.rings,
          areas: feat.areas ?? null,
        })
        await submitOnce(feat.name)
      }
    } finally {
      useSelectionStore.setState({
        bounds: origBounds,
        polygon: origPolygon,
        areas: snapshot.areas,
      })
    }
  }

  return { features, showModeSelector, mode, setMode, runSubmit }
}
