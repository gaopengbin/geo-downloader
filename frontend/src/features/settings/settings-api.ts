import { invokeCommand } from '@/lib/tauri'
import type { AppSettings, Nullable, SystemMemoryInfo, TileSource } from '@/types/api'

export function getTileSources(tiandituToken: Nullable<string> = null) {
  return invokeCommand<Record<string, TileSource>>('get_tile_sources', { tiandituToken })
}

export function getBuiltinSources(tiandituToken: Nullable<string> = null) {
  return invokeCommand<Record<string, TileSource>>('get_builtin_sources', { tiandituToken })
}

export function getSettings() {
  return invokeCommand<AppSettings>('get_settings')
}

export function saveSettings(settings: AppSettings) {
  return invokeCommand<void>('save_settings', { settings })
}

export function getAssistantSecretStatus() {
  return invokeCommand<{ configured: boolean }>('assistant_secret_status')
}

export function setAssistantApiKey(apiKey: string) {
  return invokeCommand<void>('assistant_set_api_key', { apiKey })
}

export function deleteAssistantApiKey() {
  return invokeCommand<void>('assistant_delete_api_key')
}

export function getSystemMemory() {
  return invokeCommand<SystemMemoryInfo | null>('get_system_memory')
}
