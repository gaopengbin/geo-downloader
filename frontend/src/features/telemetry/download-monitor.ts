import { invokeCommand, isTauriRuntime } from '@/lib/tauri'
import type { TaskInfo } from '@/types/api'
import { DownloadLifecycleTracker } from './download-lifecycle'
import { drainDownloadCheckpoint, restoreDownloadCheckpoint, type DownloadCheckpoint } from './download-monitor-checkpoint'
import { isTelemetryTransportConfigured, trackTelemetry } from './telemetry-client'
import { useTelemetryStore } from './telemetry-store'

interface Outcome { seq: number; id: string; status: string; started: number; finished: number }

export function startDownloadTelemetry() {
  if (!isTauriRuntime() || !isTelemetryTransportConfigured()) return () => {}
  const { installId, consentedAt } = useTelemetryStore.getState()
  const key = 'geod-download-observations-v1:' + installId
  const since = Date.parse(consentedAt ?? '')
  if (!installId) return () => {}
  let checkpoint = restoreDownloadCheckpoint(null)
  try { checkpoint = restoreDownloadCheckpoint(localStorage.getItem(key)) } catch { /* Storage may be unavailable. */ }
  let stopped = false
  function persist(next: DownloadCheckpoint) {
    if (stopped) return
    localStorage.setItem(key, JSON.stringify(next))
    checkpoint = next
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let nextReconcile = 0
  let enabled = false
  const isCurrent = () => !stopped && useTelemetryStore.getState().consent === 'enabled' &&
    useTelemetryStore.getState().installId === installId
  const drain = () => drainDownloadCheckpoint(checkpoint, async ({ eventId, event }) => {
    if (!isCurrent()) return false
    return trackTelemetry('download_task_state', event, { eventId, occurredAt: event.occurredAt, installId })
  }, persist)

  async function poll() {
    try {
      if (!isCurrent()) return
      if (!enabled) {
        await invokeCommand('set_task_outcome_tracking', { enabled: true })
        enabled = true
      }
      await drain()
      if (checkpoint.pending.length || !isCurrent()) return
      const reconcile = Number.isFinite(since) && Date.now() >= nextReconcile
      const receipts = reconcile ? await invokeCommand<Outcome[]>('get_task_outcomes', { after: checkpoint.cursor, since }) : []
      const snapshots = await invokeCommand<TaskInfo[]>('get_active_tasks')
      const tasks = Number.isFinite(since)
        ? snapshots.filter(task => Date.parse(task.created_at ?? '') >= since)
        : snapshots
      if (!isCurrent()) return
      const current = new Map(tasks.map(task => [task.id, task]))
      const recovered = receipts.map(receipt => {
        const live = current.get(receipt.id)
        const matching = live?.status === receipt.status && Date.parse(live.created_at ?? '') === receipt.started
        return { ...(matching ? live : {}), id: receipt.id, status: receipt.status,
          created_at: new Date(receipt.started).toISOString(), finishedAt: receipt.finished }
      })
      const tracker = new DownloadLifecycleTracker(() => crypto.randomUUID(), Date.now, checkpoint.attempts,
        Number.isFinite(since) ? since : undefined)
      const observations = tracker.observe([...recovered, ...tasks])
      const next = {
        attempts: tracker.snapshot(),
        cursor: receipts.at(-1)?.seq ?? checkpoint.cursor,
        pending: observations.map(event => ({ event, eventId: crypto.randomUUID() })),
      }
      if (next.pending.length || receipts.length || JSON.stringify(next.attempts) !== JSON.stringify(checkpoint.attempts)) {
        // Persist cursor, attempt identities and event IDs together, before the first enqueue.
        persist(next)
        await drain()
      }
      if (reconcile) nextReconcile = receipts.length === 12 ? 0 : Date.now() + 30_000
    } catch { /* Retry on the next poll without affecting downloads. */ }
    finally { if (!stopped) timer = setTimeout(() => void poll(), 2000) }
  }
  void poll()
  return () => {
    stopped = true
    clearTimeout(timer)
    const state = useTelemetryStore.getState()
    if (state.installId !== installId || state.consent !== 'enabled') {
      try { localStorage.removeItem(key) } catch { /* Storage may be unavailable. */ }
    }
    void invokeCommand('set_task_outcome_tracking', { enabled: false }).catch(() => {})
  }
}
