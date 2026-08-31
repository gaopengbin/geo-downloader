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
  selection_changed: {
    method: 'draw_rectangle' | 'draw_polygon' | 'admin' | 'search' | 'import' | 'bookmark'
    geometry: 'bounds' | 'polygon'
    complexity: TelemetryCountBucket
  }
  region_imported: {
    format: TelemetryImportFormat
    outcome: 'success' | 'no_area' | 'error'
    feature_count: TelemetryCountBucket
  }
  bookmark_action: {
    action: 'created' | 'restored' | 'renamed' | 'deleted'
  }
  download_task_created: {
    workflow: 'raster' | 'wayback' | 'osm' | 'tiles3d'
    output_format: TelemetryOutputFormat
    zoom_count: TelemetryCountBucket
    selection: 'bounds' | 'polygon'
  }
  task_action: {
    action: 'pause_toggle' | 'cancel' | 'delete' | 'resume' | 'discard' | 'export_partial'
  }
  measurement_used: {
    action: 'distance' | 'area' | 'clear'
  }
  onboarding_event: {
    tour: TelemetryTour
    action: 'started' | 'completed' | 'dismissed'
  }
  assistant_setting_changed: {
    action: 'consent_accepted' | 'enabled' | 'disabled' | 'key_saved' | 'key_removed'
  }
  assistant_panel_action: {
    action:
      | 'opened'
      | 'closed'
      | 'cleared'
      | 'suggestion_selected'
      | 'diagnostics_attached'
      | 'diagnostics_removed'
  }
  assistant_request: {
    outcome: 'success' | 'empty' | 'cancelled' | 'error' | 'blocked'
    diagnostics_attached: boolean
    source_count: TelemetryCountBucket
    duration: TelemetryDurationBucket
  }
  assistant_navigation: {
    target: TelemetryAssistantTarget
  }
}

export type TelemetryCountBucket = '0' | '1' | '2-10' | '11-100' | '100+'
export type TelemetryImportFormat = 'geojson' | 'shapefile' | 'kml' | 'kmz' | 'unknown'
export type TelemetryDurationBucket = 'under_3s' | '3-10s' | '10-30s' | '30s+'
export type TelemetryAssistantTarget =
  | 'download'
  | 'download-center'
  | 'settings'
  | 'settings-cache'
  | 'settings-tokens'
  | 'settings-proxy'
  | 'settings-download'
  | 'settings-advanced'
  | 'settings-sources'
  | 'imagery-sources'
  | 'imagery-download'
  | 'imagery-output'
  | 'dem-download'
  | 'wayback-download'
  | 'tiles3d-download'
  | 'mvt-download'
  | 'osm-download'
  | 'map'
type TelemetryOutputFormat =
  | 'geotiff'
  | 'png'
  | 'jpeg'
  | 'tiles'
  | 'mbtiles'
  | 'gpkg'
  | 'pbf'
  | 'unknown'
export type TelemetryTour =
  | 'main'
  | 'region'
  | 'download_center'
  | 'imagery'
  | 'mvt'
  | 'osm'
  | 'tiles3d'
  | 'wayback'

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

export function telemetryCountBucket(value: number): TelemetryCountBucket {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value === 1) return '1'
  if (value <= 10) return '2-10'
  if (value <= 100) return '11-100'
  return '100+'
}

export function telemetryDurationBucket(value: number): TelemetryDurationBucket {
  if (!Number.isFinite(value) || value < 3000) return 'under_3s'
  if (value < 10000) return '3-10s'
  if (value < 30000) return '10-30s'
  return '30s+'
}

export function telemetryImportFormat(filename: string): TelemetryImportFormat {
  const extension = filename.trim().toLowerCase().split('.').pop()
  if (extension === 'json' || extension === 'geojson') return 'geojson'
  if (extension === 'zip' || extension === 'shp') return 'shapefile'
  if (extension === 'kml' || extension === 'kmz') return extension
  return 'unknown'
}

export function telemetryOutputFormat(format: string): TelemetryOutputFormat {
  const normalized = format.trim().toLowerCase()
  const allowed: TelemetryOutputFormat[] = [
    'geotiff', 'png', 'jpeg', 'tiles', 'mbtiles', 'gpkg', 'pbf',
  ]
  return allowed.includes(normalized as TelemetryOutputFormat)
    ? (normalized as TelemetryOutputFormat)
    : 'unknown'
}

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
    case 'selection_changed': {
      const value = properties as TelemetryEventMap['selection_changed']
      return { ...value }
    }
    case 'region_imported': {
      const value = properties as TelemetryEventMap['region_imported']
      return { ...value }
    }
    case 'download_task_created': {
      const value = properties as TelemetryEventMap['download_task_created']
      return { ...value }
    }
    case 'bookmark_action':
    case 'task_action':
    case 'measurement_used': {
      return { action: (properties as { action: string }).action }
    }
    case 'onboarding_event': {
      const value = properties as TelemetryEventMap['onboarding_event']
      return { ...value }
    }
    case 'assistant_setting_changed':
    case 'assistant_panel_action': {
      return { action: (properties as { action: string }).action }
    }
    case 'assistant_request': {
      const value = properties as TelemetryEventMap['assistant_request']
      return { ...value }
    }
    case 'assistant_navigation': {
      const value = properties as TelemetryEventMap['assistant_navigation']
      return { target: value.target }
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
