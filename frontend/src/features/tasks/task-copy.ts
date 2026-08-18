import type { TaskStatus } from '@/types/api'

const TASK_STATUS_KEYS = {
  pending: 'tasks.status.pending',
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
