import type { TaskInfo } from '@/types/api'

// Failures stay until explicitly removed. OSM successes remain actionable even
// if history cannot be written. Explicit cancellation keeps its previous behavior.
export function isTaskResultVisible(task: Pick<TaskInfo, 'status' | 'source'>) {
  if (task.status === 'cancelled') return false
  if (task.status === 'completed') return task.source === 'osm_vector'
  return true
}

export function historyWithoutVisibleTasks<T extends { id: string | number }>(records: T[], tasks: Pick<TaskInfo, 'id' | 'status' | 'source'>[]) {
  const ids = new Set(tasks.filter(isTaskResultVisible).map((task) => task.id))
  return records.filter((record) => !ids.has(String(record.id)))
}
