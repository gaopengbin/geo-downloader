export interface UpdateTransfer {
  source: 'mirror' | 'github'
  phase: 'downloading' | 'switching' | 'verifying' | 'installing'
  attempt: number
  progress: number
  downloaded: number
  total: number
  bytesPerSecond: number
  reason: 'slow' | 'timeout' | 'unavailable' | 'invalid' | null
}

export function installerIntegrity(asset: { size?: unknown; sha256?: unknown; digest?: unknown }) {
  const raw = typeof asset.sha256 === 'string' && asset.sha256
    ? asset.sha256 : typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : ''
  if (!/^[a-f\d]{64}$/i.test(raw) || typeof asset.size !== 'number'
    || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error('UPDATE_INTEGRITY_MISSING')
  }
  return { expectedSha256: raw.toLowerCase(), expectedSize: asset.size }
}

export function updateSpeed(bytesPerSecond: number) {
  const speed = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0
  return speed >= 1024 * 1024 ? `${(speed / 1024 / 1024).toFixed(1)} MB/s` : `${(speed / 1024).toFixed(1)} KB/s`
}

type UpdateTelemetry = import('../telemetry/feature-events.mjs').FeatureTelemetryEventMap['update_transfer_state']

/** Observe transitions rather than 250 ms progress samples. Installing means
 * verified package ready for handoff, never proof of installation or restart. */
export class UpdateTelemetryTracker {
  private seen = new Set<string>()
  private source: UpdateTelemetry['source'] = 'unknown'
  private attempt = 0
  private reason: UpdateTelemetry['reason'] = 'none'
  started(): UpdateTelemetry { return { state: 'started', source: 'unknown', reason: 'none', attempt: 0 } }
  observe(transfer: UpdateTransfer): UpdateTelemetry | null {
    this.source = ['mirror', 'github'].includes(transfer.source) ? transfer.source : 'unknown'
    this.attempt = Number.isInteger(transfer.attempt) ? Math.min(8, Math.max(0, transfer.attempt)) : 0
    if (transfer.reason && ['slow', 'timeout', 'unavailable', 'invalid'].includes(transfer.reason)) this.reason = transfer.reason
    if (!['switching', 'verifying', 'installing'].includes(transfer.phase)) return null
    const state = transfer.phase as UpdateTelemetry['state']
    const key = `${state}:${this.source}:${this.attempt}`
    if (this.seen.has(key)) return null
    this.seen.add(key)
    return { state, source: this.source, reason: state === 'switching' ? this.reason : 'none', attempt: this.attempt }
  }
  failed(): UpdateTelemetry {
    // A previous switch reason does not describe failure of the final source.
    return { state: 'failed', source: this.source, reason: 'other', attempt: this.attempt }
  }
}
