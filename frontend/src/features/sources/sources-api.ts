import { invokeCommand } from '@/lib/tauri'
import type {
  AppSettings,
  CustomTileSource,
  Nullable,
  SourceUrlAnalysis,
  TileSource,
} from '@/types/api'

export function getTileSourcesMerged(tiandituToken: Nullable<string> = null) {
  return invokeCommand<Record<string, TileSource>>('get_tile_sources', { tiandituToken })
}

export function getBuiltinSourcesRaw(tiandituToken: Nullable<string> = null) {
  return invokeCommand<Record<string, TileSource>>('get_builtin_sources', { tiandituToken })
}

export function analyzeTileSourceUrl(rawUrl: string, proxy: Nullable<string> = null) {
  return invokeCommand<SourceUrlAnalysis>('analyze_tile_source_url', { rawUrl, proxy })
}

/** 生成自定义图源 ID（前缀 custom_） */
export function makeCustomSourceId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `custom_${ts}${rand}`
}

/** 创建一个空白自定义图源模板 */
export function blankCustomSource(): CustomTileSource {
  return {
    id: makeCustomSourceId(),
    name: '',
    url: '',
    subdomains: '',
    max_zoom: 18,
  }
}

/** 把 TileSource (合并视图) 转换为可编辑的覆盖项 */
export function builtinToOverrideDraft(s: TileSource): CustomTileSource {
  return {
    id: s.id ?? s.key ?? '',
    name: s.name,
    url: (s.url ?? s.url_template ?? '') as string,
    subdomains: Array.isArray(s.subdomains) ? s.subdomains.join(',') : (s.subdomains ?? ''),
    max_zoom: typeof s.max_zoom === 'number' ? s.max_zoom : 18,
  }
}

/** 在 settings 上 upsert 自定义图源 */
export function upsertCustomSource(
  settings: AppSettings,
  source: CustomTileSource,
): AppSettings {
  const list = [...(settings.custom_sources ?? [])]
  const idx = list.findIndex((s) => s.id === source.id)
  if (idx >= 0) list[idx] = source
  else list.push(source)
  return { ...settings, custom_sources: list }
}

/** 删除自定义图源 */
export function removeCustomSource(settings: AppSettings, id: string): AppSettings {
  return {
    ...settings,
    custom_sources: (settings.custom_sources ?? []).filter((s) => s.id !== id),
  }
}

/** upsert 内置图源覆盖 */
export function upsertSourceOverride(
  settings: AppSettings,
  override: CustomTileSource,
): AppSettings {
  const list = [...(settings.source_overrides ?? [])]
  const idx = list.findIndex((s) => s.id === override.id)
  if (idx >= 0) list[idx] = override
  else list.push(override)
  return { ...settings, source_overrides: list }
}

/** 重置（删除）某个内置图源覆盖 */
export function resetSourceOverride(settings: AppSettings, id: string): AppSettings {
  return {
    ...settings,
    source_overrides: (settings.source_overrides ?? []).filter((s) => s.id !== id),
  }
}
