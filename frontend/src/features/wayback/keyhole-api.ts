import { invokeCommand } from '@/lib/tauri'
import type { Bounds, TileSource } from '@/types/api'
export interface EarthView { longitude: number; latitude: number; zoom: number }
export interface KeyholeCatalog { rootId: string; path: string; level: number; catalogLevel: number; dates: { date: string }[]; scope: 'view-centre' }
export interface KeyholePreview { id: string; requestedDate: string; source: TileSource & { id: string } }
export interface KeyholePlan extends KeyholePreview { tileCount: number }
export interface KeyholeStatus { loaded: number; cacheHits: number; noData: number; fallbackTiles: number; errors: number; providers: string[] }
export const getKeyholeDates = (view: EarthView, requestId: string) => invokeCommand<KeyholeCatalog>('keyhole_history_dates', { ...view, requestId })
export const createKeyholeSession = (rootId: string, date: string) => invokeCommand<KeyholePreview>('keyhole_history_session', { rootId, date })
export const prepareKeyholeDownload = (sourceKey: string, bounds: Bounds, zoom: number, requestId: string) => invokeCommand<KeyholePlan>('keyhole_history_plan', { sourceKey, bounds, zoom, requestId })
export const getKeyholeStatus = (sourceKey: string) => invokeCommand<KeyholeStatus>('keyhole_history_status', { sourceKey })
