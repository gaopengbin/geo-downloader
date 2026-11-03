import type { TaskInfo, TaskStatus } from '@/types/api'

const TASK_STATUS_KEYS = {
  pending: 'tasks.status.pending',
  preparing: 'tasks.status.preparing',
  downloading: 'tasks.status.downloading',
  paused: 'tasks.status.paused',
  pending_decision: 'tasks.status.pending_decision',
  merging: 'tasks.status.merging',
  processing: 'tasks.status.processing',
  exporting: 'tasks.status.exporting',
  building_pyramid: 'tasks.status.building_pyramid',
  completed: 'tasks.status.completed',
  completed_with_gaps: 'tasks.status.completed_with_gaps',
  failed: 'tasks.status.failed',
  cancelled: 'tasks.status.cancelled',
} satisfies Record<TaskStatus, string>

export function getTaskStatusKey(status: string): string | null {
  return TASK_STATUS_KEYS[status as TaskStatus] ?? null
}

export function getTaskMessage(task: TaskInfo, translate: (key: string, values?: Record<string, number | string>) => string) {
  if (task.preparation && (task.status === 'preparing' || task.status === 'paused')) return translate('tasks.labels.preparingHistory', task.preparation)
  const batchPause = /^DOWNLOAD_BATCH_PAUSE:(\d+)$/.exec(task.message ?? '')
  if (batchPause) return translate('tasks.labels.batchPause', { seconds: Number(batchPause[1]) })
  if (task.source === 'osm_vector') {
    const message = task.message ?? ''
    if (message === 'OVERPASS_QUEUED') return translate('tasks.osm.queued')
    const request = /^OVERPASS_REQUEST:(\d+):(\d+):(.+)$/.exec(message)
    if (request) return translate('tasks.osm.request', { current: Number(request[1]), total: Number(request[2]), host: request[3] })
    const fallback = /^OVERPASS_FALLBACK:(\d+):(\d+)$/.exec(message)
    if (fallback) return translate('tasks.osm.fallback', { current: Number(fallback[1]), total: Number(fallback[2]) })
    const wait = /^OVERPASS_WAIT:(\d+)$/.exec(message)
    if (wait) return translate('tasks.osm.wait', { seconds: Number(wait[1]) })
    if (message.startsWith('OVERPASS_ERROR:')) return translate('tasks.osm.recovering')
  }
  return task.message ?? ''
}

export function getTaskErrorMessage(error: string, translate: (key: string) => string) {
  if (error.startsWith('OSM_SERVICE_UNAVAILABLE:')) return translate('tasks.osm.unavailable')
  if (error.startsWith('OSM_QUERY_INCOMPLETE:')) return translate('tasks.osm.incomplete')
  if (error.startsWith('OSM_REQUEST_REJECTED:')) return translate('tasks.osm.rejected')
  return error
}
