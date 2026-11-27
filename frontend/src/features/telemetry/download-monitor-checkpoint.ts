import type { DownloadTrackerState, ObservedDownloadEvent } from './download-lifecycle.ts'

export interface PendingDownloadEvent {
  eventId: string
  event: ObservedDownloadEvent
}

export interface DownloadCheckpoint {
  cursor: number
  attempts?: DownloadTrackerState
  pending: PendingDownloadEvent[]
}

export function restoreDownloadCheckpoint(raw: string | null): DownloadCheckpoint {
  const empty = { cursor: 0, pending: [] }
  try {
    const saved = JSON.parse(raw ?? 'null')
    const attempts = Array.isArray(saved) ? saved : saved?.attempts
    if (!Array.isArray(attempts) || !attempts.every(row => Array.isArray(row) && typeof row[0] === 'string' && row[1] &&
      typeof row[1].attemptId === 'string' && typeof row[1].status === 'string' &&
      (row[1].startedAt === null || typeof row[1].startedAt === 'number'))) return empty
    return {
      attempts,
      cursor: Number.isSafeInteger(saved?.cursor) && saved.cursor >= 0 ? saved.cursor : 0,
      pending: Array.isArray(saved?.pending) ? saved.pending.filter((item: PendingDownloadEvent) =>
        item && typeof item.eventId === 'string' && Number.isFinite(item.event?.occurredAt)) : [],
    }
  } catch { return empty }
}

/** A crash after enqueue/HTTP acknowledgement replays the same event_id. */
export async function drainDownloadCheckpoint(
  checkpoint: DownloadCheckpoint,
  deliver: (item: PendingDownloadEvent) => Promise<boolean | undefined>,
  persist: (checkpoint: DownloadCheckpoint) => void,
) {
  let delivered = 0
  for (const item of checkpoint.pending) {
    if (!await deliver(item)) break
    delivered++
  }
  if (delivered) persist({ ...checkpoint, pending: checkpoint.pending.slice(delivered) })
}
