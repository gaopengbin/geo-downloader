import { invokeCommand } from '@/lib/tauri'
import { telemetryCountBucket, trackTelemetry } from '@/features/telemetry/telemetry-client'
import type {
  CreateTaskResult,
  Nullable,
  Tiles3dEstimate,
  Tiles3dSource,
  Tiles3dTaskRequest,
  TilesetSummary,
} from '@/types/api'

export function analyze3dTiles(source: Tiles3dSource, proxy: Nullable<string>) {
  return invokeCommand<TilesetSummary>('analyze_3dtiles', { source, proxy: proxy || null })
}

export function estimate3dTiles(
  source: Tiles3dSource,
  polygon: number[][],
  proxy: Nullable<string>,
) {
  return invokeCommand<Tiles3dEstimate>('estimate_3dtiles', {
    source,
    polygon,
    proxy: proxy || null,
  })
}

export function create3dTilesTask(request: Tiles3dTaskRequest, taskName: string) {
  return invokeCommand<CreateTaskResult>('create_3dtiles_task', { request, taskName }).then((result) => {
    void trackTelemetry('download_task_created', {
      workflow: 'tiles3d',
      output_format: 'unknown',
      zoom_count: telemetryCountBucket(0),
      selection: request.polygon?.length ? 'polygon' : 'bounds',
    })
    return result
  })
}

export function startTileProxy(
  baseUrl: string,
  headers: Record<string, string> = {},
  proxy: Nullable<string> = null,
) {
  return invokeCommand<string>('start_tile_proxy', { baseUrl, headers, proxy: proxy || null })
}

export function serveLocalTiles(dirPath: string) {
  return invokeCommand<string>('serve_local_tiles', { dirPath })
}

