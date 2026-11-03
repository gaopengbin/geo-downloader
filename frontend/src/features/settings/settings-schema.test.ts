import assert from 'node:assert/strict'
import test from 'node:test'
import type { TFunction } from 'i18next'
import { createSettingsSchema } from './settings-schema.ts'
import { parseTiandituBackups, primaryTiandituToken } from './tianditu-tokens.ts'

const t = ((key: string) => key) as TFunction
const schema = createSettingsSchema(t)
const settings = {
  tianditu_token: '  0123456789abcdef0123456789abcdef  ', cesium_ion_token: '',
  tianditu_backup_tokens: '',
  ai_assistant_enabled: false, ai_base_url: '', ai_model: '', deepseek_api_key: '',
  proxy_enabled: false, proxy_url: '', default_concurrency: 30, default_zoom: 15,
  download_rate_limit: 0, download_batch_size: 0, download_batch_pause_ms: 0,
  default_format: 'geotiff', memory_budget_mb: 0, tile_count_warning: 0,
  debug_mode: false, allow_invalid_certs: false, tile_cache_enabled: true,
  tile_cache_max_size_mb: 5120, tile_cache_dir: '', min_export_success_ratio: 0,
  export_buffer_mb: 64, empty_tile_probe_action: 'continue',
}

test('saving a map token is not blocked by hidden disabled AI fields', () => {
  const parsed = schema.parse(settings)
  assert.equal(parsed.tianditu_token, settings.tianditu_token.trim())
})

test('enabled AI still requires a model and a valid endpoint', () => {
  const result = schema.safeParse({...settings, ai_assistant_enabled: true})
  assert.equal(result.success, false)
  if (!result.success) {
    assert.deepEqual(result.error.issues.map(issue => issue.path[0]).sort(), ['ai_base_url', 'ai_model'])
  }
  assert.equal(schema.safeParse({...settings, ai_assistant_enabled: true,
    ai_model: 'deepseek-v4-flash', ai_base_url: 'https://api.deepseek.com/v1'}).success, true)
})

test('unrelated visible invalid settings are still rejected', () => {
  const result = schema.safeParse({...settings, default_concurrency: 0})
  assert.equal(result.success, false)
  if (!result.success) assert.equal(result.error.issues[0].path[0], 'default_concurrency')
})

test('ordered backup tokens omit empty lines and duplicates including the primary', () => {
  assert.deepEqual(parseTiandituBackups(' primary\n backup-a\r\n\nbackup-b,backup-a；backup-c ', ' primary '), ['backup-a', 'backup-b', 'backup-c'])
  assert.deepEqual(parseTiandituBackups(' \r\n '), [])
  assert.deepEqual(parseTiandituBackups('only-backup'), ['only-backup'])
  assert.equal(primaryTiandituToken({tianditu_token:' primary ', tianditu_backup_tokens:['backup']}), 'primary')
  assert.equal(primaryTiandituToken({tianditu_token:' ', tianditu_backup_tokens:[' ', ' backup ']}), 'backup')
  assert.equal(primaryTiandituToken({}), null)
})

test('download pacing accepts automatic and fixed settings and rejects invalid persisted numbers', () => {
  for (const values of [settings, {...settings, download_rate_limit: 8, download_batch_size: 64, download_batch_pause_ms: 1200},
    {...settings, download_batch_size: 128, download_batch_pause_ms: 0}]) assert.equal(schema.safeParse(values).success, true)
  for (const field of ['download_rate_limit', 'download_batch_size', 'download_batch_pause_ms']) {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = schema.safeParse({...settings, [field]: value})
      assert.equal(result.success, false)
      if (!result.success) assert.equal(result.error.issues[0].path[0], field)
    }
  }
  assert.equal(schema.safeParse({...settings, download_batch_pause_ms: 600001}).success, false)
})
