import { invokeCommand } from '@/lib/tauri'
import { trackTelemetry } from '@/features/telemetry/telemetry-client'
import type { CreateTaskResult, PersistedTask, TaskInfo, TaskLog } from '@/types/api'

export function getActiveTasks() {
  return invokeCommand<TaskInfo[]>('get_active_tasks')
}

export function cancelTask(taskId: string) {
  return invokeCommand<boolean>('cancel_task', { taskId }).then((result) => {
    if (result) void trackTelemetry('task_action', { action: 'cancel' })
    return result
  })
}

export function togglePauseTask(taskId: string) {
  return invokeCommand<boolean>('toggle_pause_task', { taskId }).then((result) => {
    if (result) void trackTelemetry('task_action', { action: 'pause_toggle' })
    return result
  })
}

export function removeTask(taskId: string) {
  return invokeCommand<void>('remove_task', { taskId }).then((result) => {
    void trackTelemetry('task_action', { action: 'delete' })
    return result
  })
}

export function getTaskLogs(taskId: string) {
  return invokeCommand<TaskLog[]>('get_task_logs', { taskId })
}

export function readLogFile(filePath: string) {
  return invokeCommand<TaskLog[]>('read_log_file', { filePath })
}

export function getLogDir() {
  return invokeCommand<string>('get_log_dir')
}

export function getResumableTasks() {
  return invokeCommand<PersistedTask[]>('get_resumable_tasks')
}

export function resumeTask(taskId: string) {
  return invokeCommand<CreateTaskResult>('resume_task', { taskId }).then((result) => {
    void trackTelemetry('task_action', { action: 'resume' })
    return result
  })
}

export function discardResumableTask(taskId: string, deleteCache = true) {
  return invokeCommand<void>('discard_resumable_task', { taskId, deleteCache }).then((result) => {
    void trackTelemetry('task_action', { action: 'discard' })
    return result
  })
}

/**
 * Issue #31：强制按现状导出部分失败任务。
 * 跳过下载循环，从 temp_dir 重建 tile_files 直接走流式导出，缺块在输出栅格中
 * 表现为白底（PNG/GeoTIFF）或 NoData（DEM）。完成后任务标 CompletedWithGaps。
 */
export function exportPartialTask(taskId: string) {
  return invokeCommand<void>('export_partial_task', { taskId }).then((result) => {
    void trackTelemetry('task_action', { action: 'export_partial' })
    return result
  })
}
