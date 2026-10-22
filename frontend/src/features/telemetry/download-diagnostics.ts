/** Fixed categories and bounded counters only. Never spread IPC objects into events. */
export interface DownloadDiagnostics {
  diagnostic_version: 1
  provider: 'tianditu' | 'other' | 'unknown'
  phase: 'prepare' | 'base_download' | 'overlay_download' | 'composite' | 'export' | 'unknown'
  token_source: 'builtin' | 'user'
  configured_tokens: number
  used_tokens: number
  token_switches: number
  recovered_switches: number
  settings_updates: number
  last_rejection_status: number
  tokens_exhausted: boolean
  error_code: string
  http_status: number
}
export const DIAGNOSTIC_ENUMS = {
  provider: ['tianditu', 'other', 'unknown'],
  phase: ['prepare', 'base_download', 'overlay_download', 'composite', 'export', 'unknown'],
  token_source: ['builtin', 'user'],
  error_code: ['none', 'cancelled', 'all_tokens_unavailable', 'access_denied', 'rate_limited', 'invalid_tile', 'tile_too_large', 'storage_failed', 'redirect_denied', 'offline_forbidden', 'missing_tiles', 'network', 'auth', 'permission', 'disk', 'unknown'],
} as const
const COUNTERS = ['configured_tokens', 'used_tokens', 'token_switches', 'recovered_switches', 'settings_updates'] as const

export function sanitizeDownloadDiagnostics(input: unknown): DownloadDiagnostics | undefined {
  if (!input || typeof input !== 'object') return
  const raw = input as Record<string, unknown>
  if (raw.diagnostic_version !== 1) return
  for (const [key, allowed] of Object.entries(DIAGNOSTIC_ENUMS)) {
    if (!(allowed as readonly unknown[]).includes(raw[key])) return
  }
  for (const key of [...COUNTERS, 'http_status', 'last_rejection_status']) {
    if (typeof raw[key] !== 'number' || !Number.isInteger(raw[key]) || (raw[key] as number) < 0 || (raw[key] as number) > (COUNTERS.includes(key as typeof COUNTERS[number]) ? 65535 : 599)) return
  }
  if (![0, 401, 403, 429].includes(raw.last_rejection_status as number) || typeof raw.tokens_exhausted !== 'boolean') return
  return {
    diagnostic_version: 1, provider: raw.provider as DownloadDiagnostics['provider'],
    phase: raw.phase as DownloadDiagnostics['phase'], token_source: raw.token_source as DownloadDiagnostics['token_source'],
    configured_tokens: raw.configured_tokens as number, used_tokens: raw.used_tokens as number,
    token_switches: raw.token_switches as number, recovered_switches: raw.recovered_switches as number,
    settings_updates: raw.settings_updates as number, last_rejection_status: raw.last_rejection_status as number,
    tokens_exhausted: raw.tokens_exhausted, error_code: raw.error_code as string, http_status: raw.http_status as number,
  }
}

export function taskDownloadDiagnostics(raw: unknown, state: string, error?: string, reason = 'unknown'): DownloadDiagnostics | undefined {
  if (!raw || typeof raw !== 'object') return
  const value = raw as Record<string, unknown>
  const codes: [RegExp, string][] = [
    [/\bTILE_TOKENS_EXHAUSTED:/, 'all_tokens_unavailable'], [/\bTILE_ACCESS_DENIED:/, 'access_denied'],
    [/\bTILE_RATE_LIMITED:/, 'rate_limited'], [/\bINVALID_TILE:/, 'invalid_tile'],
    [/\bTILE_TOO_LARGE:/, 'tile_too_large'], [/\bTILE_STORAGE_FAILED:/, 'storage_failed'],
    [/\bTILE_REDIRECT_DENIED:/, 'redirect_denied'], [/\b(?:OSM|CARTO)_OFFLINE_FORBIDDEN:/, 'offline_forbidden'],
  ]
  const failed = state === 'failed' || state === 'completed_with_gaps'
  const code = state === 'cancelled' ? 'cancelled' : failed ? codes.find(([pattern]) => pattern.test(error ?? ''))?.[1] ?? reason : 'none'
  const status = failed ? Number(/(?:HTTP(?:\/[\d.]+)?|status(?: code)?|状态码)[\s:：=]*([1-5]\d{2})\b/i.exec(error ?? '')?.[1] ?? 0) : 0
  return sanitizeDownloadDiagnostics({ ...value, error_code: code,
    http_status: code === 'all_tokens_unavailable' ? value.last_rejection_status : status })
}
