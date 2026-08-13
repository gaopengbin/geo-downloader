import { useEffect, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { AlertTriangle, Code2, Database, ExternalLink, KeyRound, LayoutGrid, Loader2, ShieldAlert, SlidersHorizontal, Wifi, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { PanelSection } from '@/components/layout/panel-section'
import { SourcesDialog } from '@/features/sources/sources-dialog'
import { AboutDialog } from '@/features/about/about-dialog'
import { useAssistantStore } from '@/features/assistant/assistant-store'
import { TelemetrySettingsSection } from '@/features/telemetry/telemetry-settings-section'
import {
  deleteAssistantApiKey,
  getAssistantSecretStatus,
  getSettings,
  getSystemMemory,
  saveSettings,
  setAssistantApiKey,
} from './settings-api'
import { TileCacheSection } from './tile-cache-section'
import { LanguageSection } from './language-section'
import { useImageryParamsStore } from '@/store/imagery-params-store'
import type { AppSettings } from '@/types/api'

const FORMAT_OPTIONS = [
  { value: 'geotiff', labelKey: 'settings.formats.geotiff' },
  { value: 'tiles', labelKey: 'settings.formats.tiles' },
  { value: 'mbtiles', labelKey: 'settings.formats.mbtiles' },
  { value: 'gpkg', labelKey: 'settings.formats.gpkg' },
] as const

const createSettingsSchema = (t: TFunction) => z
  .object({
    tianditu_token: z.string().trim(),
    cesium_ion_token: z.string().trim(),
    ai_assistant_enabled: z.boolean(),
    ai_base_url: z.string().trim(),
    ai_model: z.string().trim().min(1, t('settings.ai.modelRequired')),
    deepseek_api_key: z.string().trim(),
    proxy_enabled: z.boolean(),
    proxy_url: z.string().trim(),
    default_concurrency: z.number().int().min(1).max(100),
    default_zoom: z.number().int().min(0).max(22),
    default_format: z.enum(['geotiff', 'tiles', 'mbtiles', 'gpkg']),
    memory_budget_mb: z.number().int().min(512).max(16384),
    debug_mode: z.boolean(),
    allow_invalid_certs: z.boolean(),
    tile_cache_enabled: z.boolean(),
    tile_cache_max_size_mb: z.number().int().min(0).max(1024 * 1024),
    tile_cache_dir: z.string().trim(),
    min_export_success_ratio: z.number().min(0).max(1),
    export_buffer_mb: z.number().int().min(16).max(512),
    empty_tile_probe_action: z.enum(['continue', 'ask', 'cancel']),
  })
  .superRefine((values, context) => {
    if (!values.ai_assistant_enabled) return
    try {
      const baseUrl = new URL(values.ai_base_url)
      if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error()
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['ai_base_url'],
        message: t('settings.ai.invalidUrl'),
      })
    }
  })

type SettingsFormValues = z.infer<ReturnType<typeof createSettingsSchema>>

const DEFAULT_VALUES: SettingsFormValues = {
  tianditu_token: '',
  cesium_ion_token: '',
  ai_assistant_enabled: false,
  ai_base_url: 'https://api.deepseek.com/v1',
  ai_model: 'deepseek-v4-flash',
  deepseek_api_key: '',
  proxy_enabled: false,
  proxy_url: '',
  default_concurrency: 8,
  default_zoom: 10,
  default_format: 'geotiff',
  memory_budget_mb: 2048,
  debug_mode: false,
  allow_invalid_certs: false,
  tile_cache_enabled: true,
  tile_cache_max_size_mb: 5120,
  tile_cache_dir: '',
  min_export_success_ratio: 0,
  export_buffer_mb: 64,
  empty_tile_probe_action: 'continue',
}

function fromAppSettings(s: AppSettings | undefined): SettingsFormValues {
  if (!s) return DEFAULT_VALUES
  const fmt = (s.default_format ?? 'geotiff') as SettingsFormValues['default_format']
  const safeFmt = (['geotiff', 'tiles', 'mbtiles', 'gpkg'] as const).includes(fmt)
    ? fmt
    : 'geotiff'
  return {
    tianditu_token: s.tianditu_token ?? '',
    cesium_ion_token: s.cesium_ion_token ?? '',
    ai_assistant_enabled: s.ai_assistant_enabled ?? false,
    ai_base_url: s.ai_base_url ?? 'https://api.deepseek.com/v1',
    ai_model: s.ai_model ?? 'deepseek-v4-flash',
    deepseek_api_key: '',
    proxy_enabled: s.proxy_enabled ?? false,
    proxy_url: s.proxy_url ?? '',
    default_concurrency: s.default_concurrency ?? 8,
    default_zoom: s.default_zoom ?? 10,
    default_format: safeFmt,
    memory_budget_mb: s.memory_budget_mb ?? 2048,
    debug_mode: s.debug_mode ?? false,
    allow_invalid_certs: s.allow_invalid_certs ?? false,
    tile_cache_enabled: s.tile_cache_enabled ?? true,
    tile_cache_max_size_mb: s.tile_cache_max_size_mb ?? 5120,
    tile_cache_dir: s.tile_cache_dir ?? '',
    min_export_success_ratio: s.min_export_success_ratio ?? 0,
    export_buffer_mb: s.export_buffer_mb ?? 64,
    empty_tile_probe_action: s.empty_tile_probe_action ?? 'continue',
  }
}

function toAppSettings(values: SettingsFormValues, base: AppSettings | undefined): AppSettings {
  return {
    ...(base ?? {}),
    tianditu_token: values.tianditu_token.trim() || null,
    cesium_ion_token: values.cesium_ion_token.trim() || null,
    ai_assistant_enabled: values.ai_assistant_enabled,
    ai_base_url: values.ai_base_url.trim() || 'https://api.deepseek.com/v1',
    ai_model: values.ai_model.trim() || 'deepseek-v4-flash',
    proxy_enabled: values.proxy_enabled,
    proxy_url: values.proxy_url.trim(),
    default_concurrency: values.default_concurrency,
    default_zoom: values.default_zoom,
    default_format: values.default_format,
    memory_budget_mb: values.memory_budget_mb,
    debug_mode: values.debug_mode,
    allow_invalid_certs: values.allow_invalid_certs,
    tile_cache_enabled: values.tile_cache_enabled,
    tile_cache_max_size_mb: values.tile_cache_max_size_mb,
    tile_cache_dir: values.tile_cache_dir.trim() || null,
    min_export_success_ratio: values.min_export_success_ratio,
    export_buffer_mb: values.export_buffer_mb,
    empty_tile_probe_action: values.empty_tile_probe_action,
  }
}

export function SettingsPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [aiConsentOpen, setAiConsentOpen] = useState(false)
  const [aiConsentAccepted, setAiConsentAccepted] = useState(false)
  const [apiKeyDeleteOpen, setApiKeyDeleteOpen] = useState(false)

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const secretQuery = useQuery({
    queryKey: ['assistant-secret-status'],
    queryFn: getAssistantSecretStatus,
    enabled: settingsQuery.isSuccess,
  })
  const memoryQuery = useQuery({ queryKey: ['system-memory'], queryFn: getSystemMemory })

  const settingsSchema = useMemo(() => createSettingsSchema(t), [t])
  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: DEFAULT_VALUES,
  })

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    control,
    formState: { errors, isDirty },
  } = form

  useEffect(() => {
    if (settingsQuery.data) reset(fromAppSettings(settingsQuery.data))
  }, [settingsQuery.data, reset])

  const proxyEnabled = useWatch({ control, name: 'proxy_enabled' })
  const aiAssistantEnabled = useWatch({ control, name: 'ai_assistant_enabled' })
  const debugMode = useWatch({ control, name: 'debug_mode' })
  const allowInvalidCerts = useWatch({ control, name: 'allow_invalid_certs' })
  const defaultFormat = useWatch({ control, name: 'default_format' })
  const tileCacheEnabled = useWatch({ control, name: 'tile_cache_enabled' })
  const tileCacheMaxSizeMb = useWatch({ control, name: 'tile_cache_max_size_mb' })
  const tileCacheDir = useWatch({ control, name: 'tile_cache_dir' })
  const minExportSuccessRatio = useWatch({ control, name: 'min_export_success_ratio' })
  const exportBufferMb = useWatch({ control, name: 'export_buffer_mb' })
  const emptyTileProbeAction = useWatch({ control, name: 'empty_tile_probe_action' })

  const mutation = useMutation({
    mutationFn: async (values: SettingsFormValues) => {
      const newApiKey = values.deepseek_api_key.trim()
      if (
        values.ai_assistant_enabled &&
        !newApiKey &&
        secretQuery.data?.configured !== true
      ) {
        throw new Error(t('settings.ai.needKey'))
      }
      if (newApiKey) await setAssistantApiKey(newApiKey)
      await saveSettings(toAppSettings(values, settingsQuery.data))
    },
    onSuccess: (_d, values) => {
      toast.success(t('settings.saved'))
      queryClient.setQueryData<AppSettings>(['settings'], (current) =>
        toAppSettings(values, current),
      )
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      queryClient.invalidateQueries({ queryKey: ['assistant-secret-status'] })
      queryClient.invalidateQueries({ queryKey: ['tile-cache-stats'] })
      queryClient.invalidateQueries({ queryKey: ['tile-sources-merged'] })
      queryClient.invalidateQueries({ queryKey: ['builtin-sources'] })
      const prevFormat = settingsQuery.data?.default_format
      if (values.default_format !== prevFormat) {
        useImageryParamsStore.getState().set({ format: values.default_format })
      }
      if (!values.ai_assistant_enabled) {
        useAssistantStore.getState().setOpen(false)
      }
      reset({ ...values, deepseek_api_key: '' })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('DeepSeek API Key')) {
        setError('deepseek_api_key', { type: 'manual', message: msg })
      }
      toast.error(t('settings.saveError', { message: msg }))
    },
  })

  const deleteApiKeyMutation = useMutation({
    mutationFn: deleteAssistantApiKey,
    onSuccess: () => {
      setApiKeyDeleteOpen(false)
      setValue('deepseek_api_key', '', { shouldDirty: false })
      setValue('ai_assistant_enabled', false, { shouldDirty: true })
      queryClient.invalidateQueries({ queryKey: ['assistant-secret-status'] })
      useAssistantStore.getState().setOpen(false)
      toast.success(t('settings.ai.removed'))
    },
    onError: (err: unknown) => {
      toast.error(t('settings.ai.removeError', {
        message: err instanceof Error ? err.message : String(err),
      }))
    },
  })

  const onSubmit = handleSubmit((values) => mutation.mutate(values))

  const requestAiAssistantChange = (enabled: boolean) => {
    if (!enabled) {
      setValue('ai_assistant_enabled', false, { shouldDirty: true })
      return
    }
    setAiConsentAccepted(false)
    setAiConsentOpen(true)
  }

  const confirmAiAssistant = () => {
    if (!aiConsentAccepted) return
    setValue('ai_assistant_enabled', true, {
      shouldDirty: true,
      shouldTouch: true,
    })
    setAiConsentOpen(false)
  }

  if (settingsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t('settings.loading')}
      </div>
    )
  }

  if (settingsQuery.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {t('settings.loadError', {
          message: settingsQuery.error instanceof Error
            ? settingsQuery.error.message
            : String(settingsQuery.error),
        })}
      </div>
    )
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3"
      data-agent-target="settings-panel"
    >
      <LanguageSection />

      <PanelSection
        icon={KeyRound}
        title={t('settings.sections.tokens.title')}
        description={t('settings.sections.tokens.description')}
        dataAgentTarget="settings-tokens"
      >
        <div className="space-y-1.5">
          <Label htmlFor="tianditu_token">{t('settings.fields.tiandituToken')}</Label>
          <Input
            id="tianditu_token"
            placeholder={t('common.optional')}
            autoComplete="off"
            {...register('tianditu_token')}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            {t('settings.fields.tiandituTokenHint')}{' '}
            <a
              href="https://cloudcenter.tianditu.gov.cn/center/development/myApp"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              {t('settings.fields.tiandituApply')}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cesium_ion_token">{t('settings.fields.cesiumToken')}</Label>
          <Input
            id="cesium_ion_token"
            placeholder={t('common.optional')}
            autoComplete="off"
            {...register('cesium_ion_token')}
          />
        </div>
      </PanelSection>

      <PanelSection
        icon={Wifi}
        title={t('settings.sections.network.title')}
        description={t('settings.sections.network.description')}
        dataAgentTarget="settings-proxy"
        action={
          <Switch
            checked={proxyEnabled}
            onCheckedChange={(v) => setValue('proxy_enabled', v, { shouldDirty: true })}
          />
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="proxy_url">{t('settings.fields.proxyAddress')}</Label>
          <Input
            id="proxy_url"
            placeholder="http://127.0.0.1:7890"
            disabled={!proxyEnabled}
            autoComplete="off"
            {...register('proxy_url')}
          />
        </div>
      </PanelSection>

      <PanelSection
        icon={SlidersHorizontal}
        title={t('settings.sections.defaults.title')}
        description={t('settings.sections.defaults.description')}
        dataAgentTarget="settings-download"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="default_concurrency">{t('settings.fields.concurrency')}</Label>
            <Input
              id="default_concurrency"
              type="number"
              min={1}
              max={100}
              {...register('default_concurrency', { valueAsNumber: true })}
            />
            {errors.default_concurrency && (
              <p className="text-xs text-destructive">{errors.default_concurrency.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="default_zoom">{t('settings.fields.zoom')}</Label>
            <Input
              id="default_zoom"
              type="number"
              min={0}
              max={22}
              {...register('default_zoom', { valueAsNumber: true })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('settings.fields.format')}</Label>
            <Select
              value={defaultFormat}
              onValueChange={(v) =>
                setValue('default_format', v as SettingsFormValues['default_format'], {
                  shouldDirty: true,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMAT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>{t('settings.fields.probe')}</Label>
            <Select
              value={emptyTileProbeAction}
              onValueChange={(v) =>
                setValue(
                  'empty_tile_probe_action',
                  v as SettingsFormValues['empty_tile_probe_action'],
                  { shouldDirty: true },
                )
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="continue">{t('settings.probe.continue')}</SelectItem>
                <SelectItem value="ask">{t('settings.probe.ask')}</SelectItem>
                <SelectItem value="cancel">{t('settings.probe.cancel')}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('settings.probe.hint')}
            </p>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="memory_budget_mb">{t('settings.fields.memory')}</Label>
            <Input
              id="memory_budget_mb"
              type="number"
              min={512}
              max={16384}
              step={256}
              {...register('memory_budget_mb', { valueAsNumber: true })}
            />
            {memoryQuery.data && (
              <p className="text-xs text-muted-foreground">
                {t('settings.memorySummary', {
                  total: Math.round(memoryQuery.data.total_mb),
                  available: Math.round(memoryQuery.data.available_mb),
                })}
                {memoryQuery.data.recommended_budget_mb
                  ? ` · ${t('settings.recommendedMemory', { value: Math.round(memoryQuery.data.recommended_budget_mb) })}`
                  : ''}
              </p>
            )}
          </div>
          {/* Issue #31：自动导出最低成功率阈值 */}
          <div className="space-y-1.5 sm:col-span-2">
            <div className="flex items-center justify-between">
              <Label>{t('settings.fields.successRatio')}</Label>
              <span className="text-xs font-medium text-muted-foreground">
                {Math.round((minExportSuccessRatio ?? 0) * 100)}%
              </span>
            </div>
            <Slider
              value={[Math.round((minExportSuccessRatio ?? 0) * 100)]}
              min={0}
              max={100}
              step={5}
              onValueChange={(arr) =>
                setValue('min_export_success_ratio', (arr[0] ?? 0) / 100, {
                  shouldDirty: true,
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.successRatioHint')}
            </p>
          </div>
          {/* Issue #27：流式导出并行流水线缓冲 */}
          <div className="space-y-1.5 sm:col-span-2">
            <div className="flex items-center justify-between">
              <Label>{t('settings.fields.exportBuffer')}</Label>
              <span className="text-xs font-medium text-muted-foreground">
                {exportBufferMb ?? 64} MB
              </span>
            </div>
            <Slider
              value={[exportBufferMb ?? 64]}
              min={16}
              max={512}
              step={16}
              onValueChange={(arr) =>
                setValue('export_buffer_mb', arr[0] ?? 64, { shouldDirty: true })
              }
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.exportBufferHint')}
            </p>
          </div>
        </div>
      </PanelSection>

      <PanelSection
        icon={Code2}
        title={t('settings.sections.developer.title')}
        description={t('settings.sections.developer.description')}
        dataAgentTarget="settings-developer"
      >
        <div className="flex items-center justify-between rounded-md border p-2.5">
          <div className="min-w-0 pr-2">
            <Label className="text-sm">{t('settings.ai.title')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.ai.description')}</p>
          </div>
          <Switch
            checked={aiAssistantEnabled}
            aria-label={t('settings.ai.enable')}
            onCheckedChange={requestAiAssistantChange}
          />
        </div>
        {aiAssistantEnabled && (
          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="deepseek_api_key">DeepSeek API Key</Label>
                <span
                  className={
                    secretQuery.data?.configured
                      ? 'text-xs text-emerald-600 dark:text-emerald-400'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  {secretQuery.isLoading
                    ? t('settings.ai.checking')
                    : secretQuery.data?.configured
                      ? t('settings.ai.savedKey')
                      : t('settings.ai.notConfigured')}
                </span>
              </div>
              <Input
                id="deepseek_api_key"
                type="password"
                placeholder={
                  secretQuery.data?.configured ? t('settings.ai.keepExisting') : 'sk-...'
                }
                autoComplete="new-password"
                spellCheck={false}
                {...register('deepseek_api_key')}
              />
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('settings.ai.keyHint')}
                </p>
                {secretQuery.data?.configured && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-xs text-destructive hover:text-destructive"
                    disabled={deleteApiKeyMutation.isPending}
                    onClick={() => setApiKeyDeleteOpen(true)}
                  >
                    {deleteApiKeyMutation.isPending ? t('settings.ai.removingShort') : t('settings.ai.removeKey')}
                  </Button>
                )}
              </div>
              {errors.deepseek_api_key && (
                <p className="text-xs text-destructive">{errors.deepseek_api_key.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai_base_url">{t('settings.ai.baseUrl')}</Label>
              <Input
                id="ai_base_url"
                type="url"
                placeholder="https://api.deepseek.com/v1"
                autoComplete="off"
                spellCheck={false}
                {...register('ai_base_url')}
              />
              {errors.ai_base_url && (
                <p className="text-xs text-destructive">{errors.ai_base_url.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai_model">{t('settings.ai.model')}</Label>
              <Input
                id="ai_model"
                placeholder="deepseek-v4-flash"
                autoComplete="off"
                spellCheck={false}
                {...register('ai_model')}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {t('settings.ai.serviceHint')}
              </p>
              {errors.ai_model && (
                <p className="text-xs text-destructive">{errors.ai_model.message}</p>
              )}
            </div>
          </div>
        )}
      </PanelSection>

      <PanelSection
        icon={Wrench}
        title={t('settings.sections.advanced.title')}
        description={t('settings.sections.advanced.description')}
        dataAgentTarget="settings-advanced"
      >
        <div className="flex items-center justify-between rounded-md border p-2.5">
          <div className="min-w-0 pr-2">
            <Label className="text-sm">{t('settings.fields.debug')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.fields.debugHint')}</p>
          </div>
          <Switch
            checked={debugMode}
            onCheckedChange={(v) => setValue('debug_mode', v, { shouldDirty: true })}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border p-2.5">
          <div className="min-w-0 pr-2">
            <Label className="text-sm">{t('settings.fields.invalidCerts')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.fields.invalidCertsHint')}</p>
          </div>
          <Switch
            checked={allowInvalidCerts}
            onCheckedChange={(v) => setValue('allow_invalid_certs', v, { shouldDirty: true })}
          />
        </div>
        {allowInvalidCerts && (
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{t('settings.invalidCertsWarning')}</span>
          </div>
        )}
      </PanelSection>

      <PanelSection
        icon={Database}
        title={t('settings.sections.cache.title')}
        description={t('settings.sections.cache.description')}
        dataAgentTarget="settings-cache"
      >
        <TileCacheSection
          enabled={tileCacheEnabled}
          maxSizeMb={tileCacheMaxSizeMb}
          dir={tileCacheDir}
          onEnabledChange={(v) => setValue('tile_cache_enabled', v, { shouldDirty: true })}
          onMaxSizeMbChange={(v) => setValue('tile_cache_max_size_mb', v, { shouldDirty: true })}
          onDirChange={(v) => setValue('tile_cache_dir', v, { shouldDirty: true })}
        />
      </PanelSection>

      <TelemetrySettingsSection />

      <div className="sticky bottom-0 -mx-3 border-t bg-background/95 px-3 py-2 backdrop-blur">
        <Button type="submit" className="w-full" disabled={!isDirty || mutation.isPending}>
          {mutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          {t('common.save')}
        </Button>
      </div>

      <PanelSection
        icon={LayoutGrid}
        title={t('settings.sections.other.title')}
        description={t('settings.sections.other.description')}
        dataAgentTarget="settings-other"
      >
        <div className="flex flex-wrap gap-2">
          <SourcesDialog />
          <AboutDialog />
        </div>
      </PanelSection>

      <Dialog
        open={aiConsentOpen}
        onOpenChange={(open) => {
          setAiConsentOpen(open)
          if (!open) setAiConsentAccepted(false)
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <div className="mb-1 flex size-9 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <ShieldAlert className="size-5" />
            </div>
            <DialogTitle>{t('settings.ai.consentTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.ai.consentDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <section className="space-y-1.5 rounded-md border p-3">
              <h3 className="font-medium">{t('settings.ai.disclaimer')}</h3>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                <li>{t('settings.ai.disclaimerError')}</li>
                <li>{t('settings.ai.disclaimerVerify')}</li>
                <li>{t('settings.ai.disclaimerCost')}</li>
              </ul>
              <a
                href="https://geodownloader.pages.dev/disclaimer.html"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {t('settings.ai.fullTerms')}
                <ExternalLink className="size-3" />
              </a>
            </section>

            <section className="space-y-1.5 rounded-md border p-3">
              <h3 className="font-medium">{t('settings.ai.privacy')}</h3>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                <li>{t('settings.ai.privacyKey')}</li>
                <li>{t('settings.ai.privacyConversation')}</li>
                <li>{t('settings.ai.privacyKnowledge')}</li>
                <li>{t('settings.ai.privacySensitive')}</li>
              </ul>
            </section>

            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-3">
              <input
                type="checkbox"
                checked={aiConsentAccepted}
                className="mt-0.5 size-4 shrink-0 accent-primary"
                onChange={(event) => setAiConsentAccepted(event.target.checked)}
              />
              <span className="text-xs leading-5">{t('settings.ai.consentStatement')}</span>
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAiConsentOpen(false)}>
              {t('settings.ai.notNow')}
            </Button>
            <Button type="button" disabled={!aiConsentAccepted} onClick={confirmAiAssistant}>
              {t('settings.ai.agree')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={apiKeyDeleteOpen} onOpenChange={setApiKeyDeleteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.ai.removeTitle')}</DialogTitle>
            <DialogDescription>
              {t('settings.ai.removeDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setApiKeyDeleteOpen(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteApiKeyMutation.isPending}
              onClick={() => deleteApiKeyMutation.mutate()}
            >
              {deleteApiKeyMutation.isPending
                ? t('settings.ai.removing')
                : t('settings.ai.confirmRemove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  )
}
