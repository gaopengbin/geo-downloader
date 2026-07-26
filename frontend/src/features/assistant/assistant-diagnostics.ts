import type { AppMode, SidebarTab } from '@/store/app-store'
import { isTauriRuntime } from '@/lib/tauri'

const MODE_LABELS: Record<AppMode, string> = {
  imagery: 'GeoTIFF',
  dem: 'DEM',
  wayback: 'Wayback',
  tiles3d: '3D Tiles',
  vector: 'OSM',
  mvt: 'MVT',
}

const TAB_LABELS: Record<SidebarTab, string> = {
  download: '资源下载',
  history: '下载中心',
  settings: '设置',
}

export async function collectAssistantDiagnostics(mode: AppMode, tab: SidebarTab) {
  let version = 'unknown'
  if (isTauriRuntime()) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      version = await getVersion()
    } catch {
      version = 'unavailable'
    }
  }

  return [
    'GeoD diagnostic context',
    `app_version: ${version}`,
    `runtime: ${isTauriRuntime() ? 'Tauri WebView2' : 'Web browser preview'}`,
    `module: ${MODE_LABELS[mode]}`,
    `sidebar: ${TAB_LABELS[tab]}`,
    `platform: ${navigator.platform || 'unknown'}`,
    `language: ${navigator.language || 'unknown'}`,
    `online: ${navigator.onLine}`,
  ].join('\n')
}
