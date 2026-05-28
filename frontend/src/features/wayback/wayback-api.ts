import { invokeCommand } from '@/lib/tauri'
import type {
  CreateTaskResult,
  DownloadRequest,
  Nullable,
  ScanWaybackResponse,
  WaybackIncrementalRequest,
  WaybackIncrementalResult,
  WaybackScanProgress,
  WaybackScanRequest,
  WaybackVersionsResponse,
} from '@/types/api'

export const WAYBACK_TILE_BASE_URL =
  'https://wayback-a.maptiles.arcgis.com/arcgis/rest/services/world_imagery/mapserver/tile'

export function getWaybackVersions(proxy: Nullable<string>) {
  return invokeCommand<WaybackVersionsResponse>('get_wayback_versions', { proxy: proxy || null })
}

export function buildWaybackTileUrl(
  versionId: string,
  baseUrl: string | null = WAYBACK_TILE_BASE_URL,
) {
  const base = (baseUrl || WAYBACK_TILE_BASE_URL).replace(/\/$/, '')
  return `${base}/${versionId}/{z}/{y}/{x}`
}

export function startWaybackTileProxy(proxy: Nullable<string>) {
  return invokeCommand<string>('start_tile_proxy', {
    baseUrl: WAYBACK_TILE_BASE_URL,
    headers: {
      Origin: 'https://livingatlas.arcgis.com',
      Referer: 'https://livingatlas.arcgis.com/',
    },
    proxy: proxy || null,
  })
}

export function createWaybackTask(
  request: DownloadRequest,
  versionId: string,
  versionDate: string,
  taskName: string,
) {
  return invokeCommand<CreateTaskResult>('create_wayback_task', {
    request,
    versionId,
    versionDate,
    taskName,
  })
}

export function probeWaybackMaxZoom(
  versionId: string,
  lat: number,
  lng: number,
  proxy: Nullable<string>,
) {
  return invokeCommand<number>('probe_wayback_max_zoom', { versionId, lat, lng, proxy })
}

export function scanWaybackMetadata(req: WaybackScanRequest) {
  return invokeCommand<ScanWaybackResponse>('scan_wayback_metadata', { req })
}

export function getWaybackScanProgress(scanId: string) {
  return invokeCommand<WaybackScanProgress | null>('get_wayback_scan_progress', { scanId })
}

export function downloadWaybackIncremental(req: WaybackIncrementalRequest) {
  return invokeCommand<WaybackIncrementalResult>('download_wayback_incremental', { req })
}

