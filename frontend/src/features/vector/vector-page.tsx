import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'

import { RegionSelector } from '@/features/region/region-selector'
import { getTileSourcesMerged } from '@/features/sources/sources-api'
import { getSettings } from '@/features/settings/settings-api'
import { useAppStore } from '@/store/app-store'
import { isTauriRuntime } from '@/lib/tauri'

import { VectorPanel } from './vector-panel'

// DEM 源识别（与 imagery-page 保持一致）
function isDemSource(key: string): boolean {
  return key === 'dem_terrarium'
}

export function VectorPage() {
  const inTauri = isTauriRuntime()
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    enabled: inTauri,
  })
  const tiandituToken = settingsQuery.data?.tianditu_token ?? null
  const sourcesQuery = useQuery({
    queryKey: ['tile-sources-merged', tiandituToken],
    queryFn: () => getTileSourcesMerged(tiandituToken),
    enabled: inTauri && settingsQuery.isSuccess,
  })

  // 进入 vector mode 时，若 store 没记忆过本 mode 的源，写入一个默认值
  useEffect(() => {
    if (!settingsQuery.data || !sourcesQuery.data) return
    const remembered = useAppStore.getState().selectedSourceByMode.vector ?? null
    if (
      remembered &&
      sourcesQuery.data[remembered] &&
      !isDemSource(remembered)
    ) {
      return
    }
    const defaultSource = settingsQuery.data.default_source
    let pick: string | null = null
    if (
      defaultSource &&
      sourcesQuery.data[defaultSource] &&
      !isDemSource(defaultSource)
    ) {
      pick = defaultSource
    } else {
      const first = Object.entries(sourcesQuery.data)
        .filter(([k]) => !isDemSource(k))
        .sort(([, a], [, b]) =>
          ((a as { name?: string }).name ?? '').localeCompare(
            (b as { name?: string }).name ?? '',
          ),
        )[0]
      pick = first ? first[0] : null
    }
    if (pick) {
      useAppStore.getState().setSelectedSourceForMode('vector', pick)
    }
  }, [settingsQuery.data, sourcesQuery.data])

  return (
    <div className="space-y-4">
      <RegionSelector />
      <VectorPanel />
    </div>
  )
}
