import { invokeCommand, isTauriRuntime } from '@/lib/tauri'
import type { TaskInfo } from '@/types/api'
import { DownloadLifecycleTracker, type DownloadTrackerState } from './download-lifecycle'
import { isTelemetryTransportConfigured, trackTelemetry } from './telemetry-client'
import { useTelemetryStore } from './telemetry-store'

export function startDownloadTelemetry() {
  if (!isTauriRuntime() || !isTelemetryTransportConfigured()) return () => {}
  const installId = useTelemetryStore.getState().installId
  const key = 'geod-download-observations-v1:' + installId
  let state: DownloadTrackerState | undefined
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (Array.isArray(saved) && saved.every(row => Array.isArray(row) && typeof row[0] === 'string' && row[1] &&
      typeof row[1].attemptId === 'string' && typeof row[1].status === 'string' && (row[1].startedAt === null || typeof row[1].startedAt === 'number'))) state = saved as DownloadTrackerState
  } catch { /* An unavailable local cache does not affect downloads. */ }
  const since=Date.parse(useTelemetryStore.getState().consentedAt??'')
  const tracker = new DownloadLifecycleTracker(() => crypto.randomUUID(), () => Date.now(), state,Number.isFinite(since)?since:undefined)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  async function poll() {
    try {
      const tasks = await invokeCommand<TaskInfo[]>('get_active_tasks')
      if (stopped || useTelemetryStore.getState().consent !== 'enabled') return
      for (const event of tracker.observe(tasks)) await trackTelemetry('download_task_state', event)
      try { localStorage.setItem(key, JSON.stringify(tracker.snapshot())) } catch { /* Best effort only. */ }
    } catch { /* Monitoring and reporting must never block a download. */ }
    if (!stopped) timer = setTimeout(() => void poll(), 2000)
  }
  void poll()
  return () => { stopped = true; clearTimeout(timer) }
}
