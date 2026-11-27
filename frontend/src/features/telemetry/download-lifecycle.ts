import { taskDownloadDiagnostics, type DownloadDiagnostics } from './download-diagnostics.ts'
import {taskAcquisitionFields,type AcquisitionDiagnostic}from './acquisition-diagnostic.ts'
import {validateExecutionDiagnostic,type ExecutionDiagnostic}from './execution-diagnostic.mjs'
export function taskExecutionFields(raw:unknown):{execution?:ExecutionDiagnostic}{
 if(!raw||typeof raw!=='object'||!Object.hasOwn(raw,'execution'))return {};
 try{return {execution:validateExecutionDiagnostic((raw as Record<string,unknown>).execution)}}catch{return {}}
}

export type DownloadState = 'started' | 'completed' | 'completed_with_gaps' | 'failed' | 'cancelled'
export type DownloadDuration = 'unknown' | 'under_10s' | '10-60s' | '1-5m' | '5-30m' | '30m+'
export type DownloadReason = 'none' | 'cancelled' | 'network' | 'auth' | 'disk' | 'permission' | 'missing_tiles' | 'unknown'
export interface DownloadLifecycleEvent extends Partial<DownloadDiagnostics> { task_id?: string; attempt_id: string; state: DownloadState; duration: DownloadDuration; reason: DownloadReason;diagnostic?:AcquisitionDiagnostic|null;execution?:ExecutionDiagnostic }
interface TaskObservation { id: string; status: string; error?: string; message?: string; download_diagnostics?: unknown; created_at?: string; finishedAt?: number; finished_at_ms?: number }
interface Attempt { attemptId: string; status: string; startedAt: number | null; createdAt?: number; recorded?: boolean; recovered?: boolean }
export type DownloadTrackerState = [string, Attempt][]
const terminal = new Set(['completed','completed_with_gaps','failed','cancelled'])
const active = new Set(['pending','preparing','downloading','paused','pending_decision','merging','processing','exporting','building_pyramid'])
const taskUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function durationBucket(ms: number | null): DownloadDuration {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'unknown'
  return ms < 10_000 ? 'under_10s' : ms < 60_000 ? '10-60s' : ms < 300_000 ? '1-5m' : ms < 1_800_000 ? '5-30m' : '30m+'
}
export function reasonBucket(state: string, error?: string): DownloadReason {
  if (state === 'cancelled') return 'cancelled'
  if (state === 'completed_with_gaps') return 'missing_tiles'
  if (state !== 'failed') return 'none'
  const text = error ?? ''
  if (/\bTILE_NETWORK_(?:CONNECT|TIMEOUT|BODY|REQUEST):/.test(text)) return 'network'
  // Keep the wire schema unchanged. Match stable downloader codes before words
  // such as "denied", "permission" or "network" inside nested error messages.
  if (/\b(?:TILE_ACCESS_DENIED|TILE_TOKENS_EXHAUSTED):/.test(text)) return 'auth'
  if (/\b(?:OSM_OFFLINE_FORBIDDEN|CARTO_OFFLINE_FORBIDDEN|TILE_REDIRECT_DENIED):/.test(text)) return 'permission'
  if (/\b(?:TILE_RATE_LIMITED|INVALID_TILE|TILE_TOO_LARGE):/.test(text)) return 'network'
  if (/\b(?:TILE|OSM)_STORAGE_FAILED:/.test(text)) {
    return /permission denied|access (?:is )?denied|EACCES|EPERM|拒绝访问|权限|只读|read.only/i.test(text) ? 'permission' : 'disk'
  }
  if (/(?:HTTP(?:\/[\d.]+)?|status(?: code)?|状态码)[\s:：=]*(?:401|403)\b|unauthorized|认证失败|登录|(?:token|api[ _-]?key).*(?:invalid|expired|exhausted|失效|无效|耗尽|额度)|(?:令牌|密钥|额度|配额).*(?:不足|无效|失效|耗尽)/i.test(text)) return 'auth'
  if (/permission|access (?:is )?denied|EACCES|EPERM|权限|拒绝访问|只读|read.only/i.test(text)) return 'permission'
  if (/disk|ENOSPC|no space left|磁盘|空间不足|写入(?:缓存|合成)?瓦片失败|创建.*目录失败/i.test(text)) return 'disk'
  if (/no_data|\b404\b|无可用数据|无覆盖|缺块|瓦片缺失/i.test(text)) return 'missing_tiles'
  if (/timeout|network|connect|DNS|ECONN|ENOTFOUND|\b429\b|超时|网络|连接|限流|请求过于频繁|频率限制/i.test(text)) return 'network'
  return 'unknown'
}

export interface ObservedDownloadEvent extends DownloadLifecycleEvent {
  /** Local envelope timestamp; the transport keeps this out of event properties. */
  occurredAt: number
}

/** Multiple attempts of a task can await their native completion receipts concurrently. */
export class DownloadLifecycleTracker {
  private attempts = new Map<string, Map<number | undefined, Attempt>>()
  private initialized: boolean
  private uuid: () => string
  private now: () => number
  private since?: number

  constructor(uuid: () => string, now: () => number, state?: DownloadTrackerState, since?: number) {
    this.uuid = uuid
    this.now = now
    this.since = since
    this.initialized = state !== undefined
    // Older checkpoints contain just the latest attempt per task, sometimes without createdAt.
    for (const [id, attempt] of state ?? []) this.forTask(id).set(attempt.createdAt, { ...attempt })
  }

  private forTask(id: string) {
    let attempts = this.attempts.get(id)
    if (!attempts) {
      attempts = new Map<number | undefined, Attempt>()
      this.attempts.set(id, attempts)
    }
    return attempts
  }

  snapshot(): DownloadTrackerState {
    return [...this.attempts].flatMap(([id, attempts]) =>
      [...attempts.values()].map((attempt): [string, Attempt] => [id, { ...attempt }]))
  }

  observe(tasks: TaskObservation[]): ObservedDownloadEvent[] {
    const output: ObservedDownloadEvent[] = []
    const live = new Set<Attempt>()
    const current = this.now()
    // Bind a legacy unversioned snapshot to the current live attempt before applying older receipts.
    for (const task of tasks) {
      if (task.finishedAt !== undefined) continue
      const attempts = this.attempts.get(task.id)
      const legacy = attempts?.get(undefined)
      const created = Date.parse(task.created_at ?? '')
      if (attempts && legacy && Number.isFinite(created) && !attempts.has(created) &&
        (legacy.startedAt === null || created <= legacy.startedAt)) {
        attempts.delete(undefined)
        legacy.createdAt = created
        attempts.set(created, legacy)
      }
    }

    for (const task of tasks) {
      if (!terminal.has(task.status) && !active.has(task.status)) continue
      const parsed = Date.parse(task.created_at ?? '')
      const created = Number.isFinite(parsed) ? parsed : undefined
      const attempts = this.forTask(task.id)
      let attempt = attempts.get(created)
      if (!attempt && created !== undefined) {
        const legacy = attempts.get(undefined)
        if (legacy && (legacy.startedAt === null || created <= legacy.startedAt)) {
          attempts.delete(undefined)
          legacy.createdAt = created
          attempts.set(created, legacy)
          attempt = legacy
        }
      }
      const finishedAt = task.finishedAt ?? task.finished_at_ms ?? current
      const postConsent = this.since !== undefined && created !== undefined && created >= this.since && created <= current + 300_000
      const taskIdentity = taskUuid.test(task.id) ? { task_id: task.id } : {}
      const error = task.error ?? task.message
      const fields = { ...taskAcquisitionFields(task.download_diagnostics), ...taskExecutionFields(task.download_diagnostics) }
      const isTerminal = terminal.has(task.status)
      if (!attempt || (created === undefined && terminal.has(attempt.status) && !isTerminal)) {
        // A legacy checkpoint may have lost the identity of an older start. Its receipt
        // still contributes the terminal outcome without manufacturing another start.
        const olderReceipt = task.finishedAt !== undefined && created !== undefined &&
          [...attempts.keys()].some(time => time !== undefined && time > created)
        attempt = { attemptId: this.uuid(), status: task.status, createdAt: created,
          startedAt: postConsent ? created : this.initialized ? current : null }
        attempts.set(created, attempt)
        if (task.finishedAt !== undefined) attempt.recorded = true
        else live.add(attempt)
        if (isTerminal && !this.initialized && !postConsent) continue
        if (!olderReceipt) output.push({ ...taskIdentity, attempt_id: attempt.attemptId, state: 'started',
          occurredAt: attempt.startedAt ?? current, duration: 'unknown', reason: 'none',
          ...taskDownloadDiagnostics(task.download_diagnostics, 'started'), ...fields })
      } else {
        const finalizedReceipt = attempt.recorded && (attempt.status === 'completed' || attempt.status === 'completed_with_gaps')
        if (task.finishedAt !== undefined) attempt.recorded = true
        else live.add(attempt)
        if (attempt.status === task.status) continue
        // A finalized output can outlive a stale failure in the active task list.
        if (finalizedReceipt || (attempt.recorded && !isTerminal)) continue
        if (attempt.status === 'failed' && (task.status === 'completed' || task.status === 'completed_with_gaps')) {
          attempt.recovered = true
        }
        attempt.status = task.status
      }
      if (isTerminal) {
        const reason = reasonBucket(task.status, error)
        output.push({ ...taskIdentity, attempt_id: attempt.attemptId, state: task.status as DownloadState,
          occurredAt: finishedAt, duration: durationBucket(attempt.startedAt === null ? null : finishedAt - attempt.startedAt),
          reason, ...taskDownloadDiagnostics(task.download_diagnostics, task.status, error, reason), ...fields })
      }
    }
    this.initialized = true
    for (const [id, attempts] of this.attempts) {
      for (const [created, attempt] of attempts) {
        if (live.has(attempt)) continue
        // A later journal entry can correct a failure for the same native attempt.
        const awaitingCorrection = created !== undefined && (attempt.status === 'failed' || attempt.recovered)
        const expired = (created ?? attempt.startedAt ?? 0) < current - 90 * 86400_000
        if ((attempt.recorded && !awaitingCorrection) || expired) attempts.delete(created)
      }
      if (!attempts.size) this.attempts.delete(id)
    }
    return output
  }
}
