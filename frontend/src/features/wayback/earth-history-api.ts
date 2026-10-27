import { invokeCommand } from '@/lib/tauri'
import type { Bounds, TileSource } from '@/types/api'
export interface EarthDate { date: string; supportedNodes: number; coverageFraction: number | null }
export interface EarthCatalog { id: string; bounds: number[]; outputZoom: number; dates: EarthDate[]; catalogComplete: boolean; nodeCount: number }
export interface EarthPlan { id: string; catalogId: string; source: TileSource; bounds: number[]; requestedDate: string; outputZoom: number; tileCount: number; fallbackOccurred: boolean; effectiveDateStatus: string; unavailableNodes: number }
export function discoverEarthDates(bounds: Bounds, zoom: number, proxy: string | null, requestId: string) {
  return invokeCommand<EarthCatalog>('earth_history_catalog', { bounds, zoom, proxy, requestId })
}
export function prepareEarthDate(catalogId: string, date: string, proxy: string | null, requestId: string) {
  return invokeCommand<EarthPlan>('earth_history_prepare', { catalogId, date, proxy, requestId })
}
export function cancelEarthOperation(requestId: string) { return invokeCommand<boolean>('earth_history_cancel', { requestId }) }
