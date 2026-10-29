import { taskDownloadDiagnostics, type DownloadDiagnostics } from './download-diagnostics.ts'
import {taskAcquisitionFields,type AcquisitionDiagnostic}from './acquisition-diagnostic.ts'

export type DownloadState = 'started' | 'completed' | 'completed_with_gaps' | 'failed' | 'cancelled'
export type DownloadDuration = 'unknown' | 'under_10s' | '10-60s' | '1-5m' | '5-30m' | '30m+'
export type DownloadReason = 'none' | 'cancelled' | 'network' | 'auth' | 'disk' | 'permission' | 'missing_tiles' | 'unknown'
export interface DownloadLifecycleEvent extends Partial<DownloadDiagnostics> { attempt_id: string; state: DownloadState; duration: DownloadDuration; reason: DownloadReason;diagnostic?:AcquisitionDiagnostic|null }
interface TaskObservation { id: string; status: string; error?: string; message?: string; download_diagnostics?: unknown;created_at?:string }
interface Attempt { attemptId: string; status: string; startedAt: number | null }
export type DownloadTrackerState = [string, Attempt][]
const terminal = new Set(['completed','completed_with_gaps','failed','cancelled'])
const active = new Set(['pending','preparing','downloading','paused','pending_decision','merging','processing','exporting','building_pyramid'])
export function durationBucket(ms: number | null): DownloadDuration {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'unknown'
  return ms < 10_000 ? 'under_10s' : ms < 60_000 ? '10-60s' : ms < 300_000 ? '1-5m' : ms < 1_800_000 ? '5-30m' : '30m+'
}
export function reasonBucket(state: string, error?: string): DownloadReason {
  if (state === 'cancelled') return 'cancelled'
  if (state === 'completed_with_gaps') return 'missing_tiles'
  if (state !== 'failed') return 'none'
  const text = error ?? ''
  // Keep the wire schema unchanged. Match stable downloader codes before words
  // such as "denied", "permission" or "network" inside nested error messages.
  if (/\b(?:TILE_ACCESS_DENIED|TILE_TOKENS_EXHAUSTED):/.test(text)) return 'auth'
  if (/\b(?:OSM_OFFLINE_FORBIDDEN|CARTO_OFFLINE_FORBIDDEN|TILE_REDIRECT_DENIED):/.test(text)) return 'permission'
  if (/\b(?:TILE_RATE_LIMITED|INVALID_TILE|TILE_TOO_LARGE):/.test(text)) return 'network'
  if (/\bTILE_STORAGE_FAILED:/.test(text)) {
    return /permission denied|access (?:is )?denied|EACCES|EPERM|拒绝访问|权限|只读|read.only/i.test(text) ? 'permission' : 'disk'
  }
  if (/(?:HTTP(?:\/[\d.]+)?|status(?: code)?|状态码)[\s:：=]*(?:401|403)\b|unauthorized|认证失败|登录|(?:token|api[ _-]?key).*(?:invalid|expired|exhausted|失效|无效|耗尽|额度)|(?:令牌|密钥|额度|配额).*(?:不足|无效|失效|耗尽)/i.test(text)) return 'auth'
  if (/permission|access (?:is )?denied|EACCES|EPERM|权限|拒绝访问|只读|read.only/i.test(text)) return 'permission'
  if (/disk|ENOSPC|no space left|磁盘|空间不足|写入(?:缓存|合成)?瓦片失败|创建.*目录失败/i.test(text)) return 'disk'
  if (/no_data|\b404\b|无可用数据|无覆盖|缺块|瓦片缺失/i.test(text)) return 'missing_tiles'
  if (/timeout|network|connect|DNS|ECONN|ENOTFOUND|\b429\b|超时|网络|连接|限流|请求过于频繁|频率限制/i.test(text)) return 'network'
  return 'unknown'
}

/** IDs remain local except random per-attempt UUIDs. Baseline history is never replayed. */
export class DownloadLifecycleTracker {
  private attempts = new Map<string, Attempt>()
  private initialized = false
  private uuid: () => string
  private now: () => number
  private since?:number
  constructor(uuid: () => string, now: () => number, state?: DownloadTrackerState,since?:number) {
    this.uuid = uuid; this.now = now
    this.since=since
    if (state) { this.attempts = new Map(state); this.initialized = true }
  }
  snapshot(): DownloadTrackerState { return [...this.attempts.entries()] }
  observe(tasks: TaskObservation[]): DownloadLifecycleEvent[] {
    const output: DownloadLifecycleEvent[] = []
    for (const task of tasks) {
      if (!terminal.has(task.status) && !active.has(task.status)) continue
      let attempt = this.attempts.get(task.id)
      if (!attempt) {
        const created=Date.parse(task.created_at??''),current=this.now()
        const postConsent=this.since!==undefined&&Number.isFinite(created)&&created>=this.since&&created<=current+300000
        attempt = { attemptId: this.uuid(), status: task.status, startedAt:postConsent?created:this.initialized ? current : null }
        this.attempts.set(task.id, attempt)
        if (!this.initialized && terminal.has(task.status)&&!postConsent) continue
        output.push({ attempt_id: attempt.attemptId, state: 'started', duration: 'unknown', reason: 'none', ...taskDownloadDiagnostics(task.download_diagnostics, 'started'),...taskAcquisitionFields(task.download_diagnostics) })
        if (!terminal.has(task.status)) continue
      } else {
        if (attempt.status === task.status) continue
        if (terminal.has(attempt.status) && active.has(task.status)) {
          attempt = { attemptId: this.uuid(), status: task.status, startedAt: this.now() }
          this.attempts.set(task.id, attempt)
          output.push({ attempt_id: attempt.attemptId, state: 'started', duration: 'unknown', reason: 'none', ...taskDownloadDiagnostics(task.download_diagnostics, 'started'),...taskAcquisitionFields(task.download_diagnostics) })
          continue
        }
        // Exporting partial results after an already-failed attempt isn't a new download.
        if (terminal.has(attempt.status) && terminal.has(task.status)) { attempt.status = task.status; continue }
        attempt.status = task.status
      }
      if (terminal.has(task.status)) output.push({ attempt_id: attempt.attemptId,
        state: task.status as DownloadState, duration: durationBucket(attempt.startedAt === null ? null : this.now() - attempt.startedAt),
        reason: reasonBucket(task.status, task.error ?? task.message),
        ...taskDownloadDiagnostics(task.download_diagnostics, task.status, task.error ?? task.message, reasonBucket(task.status, task.error ?? task.message)),...taskAcquisitionFields(task.download_diagnostics) })
    }
    this.initialized = true
    // Bound local bookkeeping without treating deleted records as cancellations.
    const currentIds = new Set(tasks.map(task => task.id))
    for (const id of this.attempts.keys()) if (!currentIds.has(id)) this.attempts.delete(id)
    return output
  }
}
