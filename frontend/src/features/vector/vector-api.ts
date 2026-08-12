import { invokeCommand } from '@/lib/tauri'
import { telemetryCountBucket, trackTelemetry } from '@/features/telemetry/telemetry-client'
import type { Bounds, CreateTaskResult, Nullable, PolygonCoord } from '@/types/api'

export function createOsmDownloadTask(
  bounds: Bounds,
  featureType: string,
  savePath: string,
  proxy: Nullable<string>,
  polygon: Nullable<PolygonCoord[]>,
  taskName: string,
) {
  return invokeCommand<CreateTaskResult>('create_osm_download_task', {
    bounds,
    featureType,
    savePath,
    proxy: proxy || null,
    polygon: polygon || null,
    taskName,
  }).then((result) => {
    void trackTelemetry('download_task_created', {
      workflow: 'osm',
      output_format: 'unknown',
      zoom_count: telemetryCountBucket(0),
      selection: polygon?.length ? 'polygon' : 'bounds',
    })
    return result
  })
}

export function downloadOsmData(
  bounds: Bounds,
  featureType: string,
  savePath: string,
  proxy: Nullable<string>,
  polygon: Nullable<PolygonCoord[]>,
) {
  return invokeCommand<unknown>('download_osm_data', {
    bounds,
    featureType,
    savePath,
    proxy: proxy || null,
    polygon: polygon || null,
  })
}
