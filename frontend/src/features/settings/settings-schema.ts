import { z } from 'zod'
import type { TFunction } from 'i18next'
import { warningThresholdSchema } from './warning-threshold-schema.ts'

const boundedInteger = (max: number, error: string) => z.number({ error }).int(error).min(0, error).max(max, error)

export const createSettingsSchema = (t: TFunction) => z.object({
  tianditu_token: z.string().trim(),
  tianditu_backup_tokens: z.string().trim(),
  cesium_ion_token: z.string().trim(),
  ai_assistant_enabled: z.boolean(),
  ai_base_url: z.string().trim(),
  ai_model: z.string().trim(),
  deepseek_api_key: z.string().trim(),
  proxy_enabled: z.boolean(),
  proxy_url: z.string().trim(),
  default_concurrency: z.number().int().min(1).max(100),
  download_rate_limit: boundedInteger(10000, t('settings.scheduling.rateError')),
  download_batch_size: boundedInteger(100000, t('settings.scheduling.batchError')),
  download_batch_pause_ms: boundedInteger(600000, t('settings.scheduling.pauseError')),
  default_zoom: z.number().int().min(0).max(22),
  default_format: z.enum(['geotiff', 'tiles', 'mbtiles', 'gpkg']),
  memory_budget_mb: warningThresholdSchema,
  tile_count_warning: warningThresholdSchema,
  debug_mode: z.boolean(),
  allow_invalid_certs: z.boolean(),
  tile_cache_enabled: z.boolean(),
  tile_cache_max_size_mb: z.number().int().min(0).max(1024 * 1024),
  tile_cache_dir: z.string().trim(),
  min_export_success_ratio: z.number().min(0).max(1),
  export_buffer_mb: z.number().int().min(16).max(512),
  empty_tile_probe_action: z.enum(['continue', 'ask', 'cancel']),
}).superRefine((values, context) => {
  // Disabled AI fields must not prevent saving unrelated settings such as map tokens.
  if (!values.ai_assistant_enabled) return
  if (!values.ai_model) {
    context.addIssue({code: 'custom', path: ['ai_model'], message: t('settings.ai.modelRequired')})
  }
  try {
    const baseUrl = new URL(values.ai_base_url)
    if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error()
  } catch {
    context.addIssue({code: 'custom', path: ['ai_base_url'], message: t('settings.ai.invalidUrl')})
  }
})
