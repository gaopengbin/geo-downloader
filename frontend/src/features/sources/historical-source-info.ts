export type HistoricalProvider = 'nasa' | 'eox' | 'geovis' | 'earth'
export type HistoryProvider = 'esri' | HistoricalProvider

export function historicalSourceInfo(id: string) {
  const nasaYear = /^nasa_weld_(1990|2000)$/.exec(id)?.[1]
  if (nasaYear) return { provider: 'nasa' as const, year: Number(nasaYear), maxZoom: 12 }
  const eoxYear = /^eox_sentinel_(2016|2018|2019|2020|2021|2022|2023|2024|2025)$/.exec(id)?.[1]
  if (eoxYear) return { provider: 'eox' as const, year: Number(eoxYear), maxZoom: 21 }
  const geovisYear = /^geovis_(2021|2022|2025)$/.exec(id)?.[1]
  if (geovisYear) return { provider: 'geovis' as const, year: Number(geovisYear), maxZoom: 18 }
  return null
}

export function matchesHistoricalProvider(id: string, provider: HistoricalProvider) {
  if (provider === 'earth') return /^earth_(history|keyhole)_[a-f0-9]{64}$/.test(id)
  return historicalSourceInfo(id)?.provider === provider
}

export function isHistoricalSource(id: string) { return historicalSourceInfo(id) !== null || matchesHistoricalProvider(id, 'earth') }

export function sourceMatchesHistoryContext(id: string, provider?: HistoricalProvider) {
  return provider ? matchesHistoricalProvider(id, provider) : !isHistoricalSource(id)
}

export function historicalZoomLevels(id: string, levels: number[]) {
  const info = historicalSourceInfo(id)
  if (!info) return levels
  const supported = levels.filter((zoom) => zoom >= 1 && zoom <= info.maxZoom)
  return supported.length || !levels.length ? supported : [info.maxZoom]
}
