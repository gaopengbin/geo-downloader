import type { AppMode, SidebarTab } from '@/store/app-store'
import { isTauriRuntime } from '@/lib/tauri'
import { useTelemetryStore } from './telemetry-store'

interface TelemetryEventMap {
  app_started: Record<string, never>
  mode_changed: { mode: AppMode }
  sidebar_tab_changed: { tab: SidebarTab }
  graticule_changed: {
    enabled: boolean
    interval_mode: 'auto' | 'fixed'
    interval: number
  }
}

type TelemetryEventName = keyof TelemetryEventMap

interface QueuedTelemetryEvent {
  event_id: string
  event: TelemetryEventName
  occurred_at: string
  install_id: string
  session_id: string
  app_version: string
  platform: 'windows' | 'macos' | 'linux' | 'web' | 'unknown'
  properties: Record<string, boolean | number | string>
}

const QUEUE_STORAGE_KEY = 'geo-downloader:telemetry-queue'
const MAX_QUEUED_EVENTS = 50
const sessionId = createEventId()
let flushTimer: number | null = null
let flushPromise: Promise<void> | null = null
let versionPromise: Promise<string> | null = null

function createEventId() {
  return crypto.randomUUID()
}

function getTelemetryEndpoint() {
  const raw = import.meta.env.VITE_TELEMETRY_ENDPOINT?.trim()
  if (!raw) return null

  try {
    const url = new URL(raw)
    const isLocalhost = ['127.0.0.1', 'localhost'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(import.meta.env.DEV && isLocalhost)) return null
    return url.toString()
  } catch {
    return null
  }
}

export function isTelemetryTransportConfigured() {
  return getTelemetryEndpoint() !== null
}

function detectPlatform(): QueuedTelemetryEvent['platform'] {
  if (!isTauriRuntime()) return 'web'
  const userAgent = navigator.userAgent.toLowerCase()
  if (userAgent.includes('windows')) return 'windows'
  if (userAgent.includes('mac os') || userAgent.includes('macintosh')) return 'macos'
  if (userAgent.includes('linux')) return 'linux'
  return 'unknown'
}

async function getAppVersion() {
  if (!isTauriRuntime()) return 'web'
  versionPromise ??= import('@tauri-apps/api/app')
    .then(({ getVersion }) => getVersion())
    .catch(() => 'unknown')
  return versionPromise
}

function sanitizeProperties<TName extends TelemetryEventName>(
  event: TName,
  properties: TelemetryEventMap[TName],
): Record<string, boolean | number | string> {
  switch (event) {
    case 'app_started':
      return {}
    case 'mode_changed': {
      const mode = (properties as TelemetryEventMap['mode_changed']).mode
      const allowed: AppMode[] = ['imagery', 'dem', 'wayback', 'tiles3d', 'vector', 'mvt']
      return { mode: allowed.includes(mode) ? mode : 'imagery' }
    }
    case 'sidebar_tab_changed': {
      const tab = (properties as TelemetryEventMap['sidebar_tab_changed']).tab
      const allowed: SidebarTab[] = ['download', 'history', 'settings']
      return { tab: allowed.includes(tab) ? tab : 'download' }
    }
    case 'graticule_changed': {
      const value = properties as TelemetryEventMap['graticule_changed']
      return {
        enabled: Boolean(value.enabled),
        interval_mode: value.interval_mode === 'fixed' ? 'fixed' : 'auto',
        interval: Number.isFinite(value.interval) ? value.interval : 1,
      }
    }
  }
}

function readQueue(): QueuedTelemetryEvent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as QueuedTelemetryEvent[]).slice(-MAX_QUEUED_EVENTS) : []
  } catch {
    return []
  }
}

function writeQueue(events: QueuedTelemetryEvent[]) {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(events.slice(-MAX_QUEUED_EVENTS)))
  } catch {
    // Telemetry must never interfere with the application.
  }
}

function scheduleFlush() {
  if (flushTimer !== null) return
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    void flushTelemetry()
  }, 800)
}

export async function trackTelemetry<TName extends TelemetryEventName>(
  event: TName,
  properties: TelemetryEventMap[TName],
) {
  const endpoint = getTelemetryEndpoint()
  const state = useTelemetryStore.getState()
  if (!endpoint || state.consent !== 'enabled' || !state.installId) return

  const appVersion = await getAppVersion()
  const latestState = useTelemetryStore.getState()
  if (latestState.consent !== 'enabled' || !latestState.installId) return

  const queued: QueuedTelemetryEvent = {
    event_id: createEventId(),
    event,
    occurred_at: new Date().toISOString(),
    install_id: latestState.installId,
    session_id: sessionId,
    app_version: appVersion,
    platform: detectPlatform(),
    properties: sanitizeProperties(event, properties),
  }
  writeQueue([...readQueue(), queued])
  scheduleFlush()
}

export function clearTelemetryQueue() {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer)
    flushTimer = null
  }
  writeQueue([])
}

export function flushTelemetry() {
  if (flushPromise) return flushPromise

  flushPromise = (async () => {
    const endpoint = getTelemetryEndpoint()
    const state = useTelemetryStore.getState()
    const pending = readQueue()
    if (!endpoint || state.consent !== 'enabled' || pending.length === 0) return

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schema_version: 1, events: pending }),
        signal: controller.signal,
      })
      if (!response.ok) return

      const sentIds = new Set(pending.map((event) => event.event_id))
      writeQueue(readQueue().filter((event) => !sentIds.has(event.event_id)))
    } catch {
      // Keep the bounded queue for a later retry.
    } finally {
      window.clearTimeout(timeout)
    }
  })().finally(() => {
    flushPromise = null
  })

  return flushPromise
}
