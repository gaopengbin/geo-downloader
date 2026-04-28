import { invokeCommand } from '@/lib/tauri'
import type { TaskInfo, TaskLog } from '@/types/api'

export function getActiveTasks() {
  return invokeCommand<TaskInfo[]>('get_active_tasks')
}

export function cancelTask(taskId: string) {
  return invokeCommand<boolean>('cancel_task', { taskId })
}

export function togglePauseTask(taskId: string) {
  return invokeCommand<boolean>('toggle_pause_task', { taskId })
}

export function removeTask(taskId: string) {
  return invokeCommand<void>('remove_task', { taskId })
}

export function getTaskLogs(taskId: string) {
  return invokeCommand<TaskLog[]>('get_task_logs', { taskId })
}

export function readLogFile(filePath: string) {
  return invokeCommand<string[]>('read_log_file', { filePath })
}

export function getLogDir() {
  return invokeCommand<string>('get_log_dir')
}

export function getResumableTasks() {
  return invokeCommand<TaskInfo[]>('get_resumable_tasks')
}

export function resumeTask(taskId: string) {
  return invokeCommand<unknown>('resume_task', { taskId })
}

export function discardResumableTask(taskId: string) {
  return invokeCommand<void>('discard_resumable_task', { taskId })
}
