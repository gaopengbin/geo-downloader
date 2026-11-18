import { primaryTiandituToken } from '@/features/settings/tianditu-tokens'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { PanelSection } from '@/components/layout/panel-section'
import { Layers } from 'lucide-react'
import { FoundationControls } from '@/features/foundation/foundation-controls'
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
  const { t } = useTranslation()
  const [provider, setProvider] = useState('osm')
  const inTauri = isTauriRuntime()
  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
    enabled: inTauri,
  })
  const tiandituToken = primaryTiandituToken(settingsQuery.data)
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
    let pick: string | null
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
      <div className="space-y-2">
        <Label htmlFor="vector-data-source">{t('vectorData.source')}</Label>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger id="vector-data-source"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="osm">OpenStreetMap · OSM</SelectItem>
            <SelectItem value="foundation">{t('foundation.panelTitle')}</SelectItem>
            <SelectItem value="admin">{t('vectorData.admin')}</SelectItem>
            <SelectItem value="local">{t('vectorData.local')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {provider !== 'foundation' ? <VectorPanel key={provider} source={provider as 'osm' | 'admin' | 'local'} /> : <PanelSection icon={Layers} title={t('foundation.panelTitle')} description={t('vectorData.foundationDescription')}>
        <FoundationControls embedded />
      </PanelSection>}
    </div>
  )
}
