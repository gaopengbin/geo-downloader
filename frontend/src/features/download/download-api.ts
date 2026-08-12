import { invokeCommand } from '@/lib/tauri'
import {
  telemetryCountBucket,
  telemetryOutputFormat,
  trackTelemetry,
} from '@/features/telemetry/telemetry-client'
import type {
  Bounds,
  CreateTaskResult,
  DownloadEstimate,
  DownloadRequest,
  DownloadResult,
  Nullable,
  OutputFormat,
  TileProbeResult,
} from '@/types/api'

export function estimateDownload(
  bounds: Bounds,
  zoom: number,
  format: OutputFormat,
  cropToShape = false,
  zoomMax: Nullable<number> = null,
  zoomLevels: Nullable<number[]> = null,
  options: {
    sourceId?: Nullable<string>
    buildPyramid?: Nullable<boolean>
    compression?: Nullable<string>
  } = {},
) {
  return invokeCommand<DownloadEstimate>('estimate_download', {
    bounds,
    zoom,
    zoomMax,
    zoomLevels,
    format: format || null,
    cropToShape,
    sourceId: options.sourceId ?? null,
    buildPyramid: options.buildPyramid ?? null,
    compression: options.compression ?? null,
  })
}

export function downloadTiles(request: DownloadRequest) {
  return invokeCommand<DownloadResult>('download_tiles', { request })
}

export function createDownloadTask(
  request: DownloadRequest,
  taskName: string,
  sourceName: string,
) {
  return invokeCommand<CreateTaskResult>('create_download_task', {
    request,
    taskName,
    sourceName,
  }).then((result) => {
    const zoomCount = request.zoom_levels?.length ??
      (request.zoom_max == null ? 1 : Math.max(1, request.zoom_max - request.zoom + 1))
    void trackTelemetry('download_task_created', {
      workflow: 'raster',
      output_format: telemetryOutputFormat(request.format),
      zoom_count: telemetryCountBucket(zoomCount),
      selection: request.polygon?.length ? 'polygon' : 'bounds',
    })
    return result
  })
}

export function probeTile(
  sourceKey: string,
  zoom: number,
  lat: number,
  lng: number,
  tiandituToken: Nullable<string>,
  proxy: Nullable<string>,
) {
  return invokeCommand<TileProbeResult>('probe_tile', {
    sourceKey,
    zoom,
    lat,
    lng,
    tiandituToken: tiandituToken || null,
    proxy: proxy || null,
  })
}
