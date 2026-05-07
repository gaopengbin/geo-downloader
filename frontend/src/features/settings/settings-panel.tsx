import { useEffect } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Database, KeyRound, LayoutGrid, Loader2, SlidersHorizontal, Wifi, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PanelSection } from '@/components/layout/panel-section'
import { SourcesDialog } from '@/features/sources/sources-dialog'
import { AboutDialog } from '@/features/about/about-dialog'
import { getSettings, getSystemMemory, saveSettings } from './settings-api'
import { TileCacheSection } from './tile-cache-section'
import type { AppSettings } from '@/types/api'

const FORMAT_OPTIONS = [
  { value: 'geotiff', label: 'GeoTIFF (.tif)' },
  { value: 'tiles', label: '原始瓦片目录' },
  { value: 'mbtiles', label: 'MBTiles (.mbtiles)' },
  { value: 'gpkg', label: 'GeoPackage (.gpkg)' },
] as const

const settingsSchema = z.object({
  tianditu_token: z.string().trim(),
  cesium_ion_token: z.string().trim(),
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
})

type SettingsFormValues = z.infer<typeof settingsSchema>

const DEFAULT_VALUES: SettingsFormValues = {
  tianditu_token: '',
  cesium_ion_token: '',
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
  }
}

function toAppSettings(values: SettingsFormValues, base: AppSettings | undefined): AppSettings {
  return {
    ...(base ?? {}),
    tianditu_token: values.tianditu_token.trim() || null,
    cesium_ion_token: values.cesium_ion_token.trim() || null,
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
  }
}

export function SettingsPanel() {
  const queryClient = useQueryClient()

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const memoryQuery = useQuery({ queryKey: ['system-memory'], queryFn: getSystemMemory })

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: DEFAULT_VALUES,
  })

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    control,
    formState: { errors, isDirty },
  } = form

  useEffect(() => {
    if (settingsQuery.data) reset(fromAppSettings(settingsQuery.data))
  }, [settingsQuery.data, reset])

  const proxyEnabled = useWatch({ control, name: 'proxy_enabled' })
  const debugMode = useWatch({ control, name: 'debug_mode' })
  const allowInvalidCerts = useWatch({ control, name: 'allow_invalid_certs' })
  const defaultFormat = useWatch({ control, name: 'default_format' })
  const tileCacheEnabled = useWatch({ control, name: 'tile_cache_enabled' })
  const tileCacheMaxSizeMb = useWatch({ control, name: 'tile_cache_max_size_mb' })
  const tileCacheDir = useWatch({ control, name: 'tile_cache_dir' })

  const mutation = useMutation({
    mutationFn: (values: SettingsFormValues) =>
      saveSettings(toAppSettings(values, settingsQuery.data)),
    onSuccess: (_d, values) => {
      toast.success('设置已保存')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      queryClient.invalidateQueries({ queryKey: ['tile-cache-stats'] })
      reset(values)
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`保存失败：${msg}`)
    },
  })

  const onSubmit = handleSubmit((values) => mutation.mutate(values))

  if (settingsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        加载设置中...
      </div>
    )
  }

  if (settingsQuery.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        读取设置失败：
        {settingsQuery.error instanceof Error
          ? settingsQuery.error.message
          : String(settingsQuery.error)}
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <PanelSection icon={KeyRound} title="访问令牌" description="天地图 / Cesium Ion">
        <div className="space-y-1.5">
          <Label htmlFor="tianditu_token">天地图 Token</Label>
          <Input
            id="tianditu_token"
            placeholder="可选"
            autoComplete="off"
            {...register('tianditu_token')}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cesium_ion_token">Cesium Ion Token</Label>
          <Input
            id="cesium_ion_token"
            placeholder="可选"
            autoComplete="off"
            {...register('cesium_ion_token')}
          />
        </div>
      </PanelSection>

      <PanelSection
        icon={Wifi}
        title="网络代理"
        description="仅代理下载请求"
        action={
          <Switch
            checked={proxyEnabled}
            onCheckedChange={(v) => setValue('proxy_enabled', v, { shouldDirty: true })}
          />
        }
      >
        <div className="space-y-1.5">
          <Label htmlFor="proxy_url">代理地址</Label>
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
        title="默认下载参数"
        description="并发 / 缩放 / 格式 / 内存预算"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="default_concurrency">默认并发 (1-100)</Label>
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
            <Label htmlFor="default_zoom">默认缩放 (0-22)</Label>
            <Input
              id="default_zoom"
              type="number"
              min={0}
              max={22}
              {...register('default_zoom', { valueAsNumber: true })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>默认输出格式</Label>
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
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="memory_budget_mb">内存预算 MB (512-16384)</Label>
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
                系统总计 {Math.round(memoryQuery.data.total_mb)} MB / 可用{' '}
                {Math.round(memoryQuery.data.available_mb)} MB
                {memoryQuery.data.recommended_budget_mb
                  ? ` · 推荐 ${Math.round(memoryQuery.data.recommended_budget_mb)} MB`
                  : ''}
              </p>
            )}
          </div>
        </div>
      </PanelSection>

      <PanelSection icon={Wrench} title="高级" description="调试 / 证书校验">
        <div className="flex items-center justify-between rounded-md border p-2.5">
          <div className="min-w-0 pr-2">
            <Label className="text-sm">调试模式</Label>
            <p className="text-xs text-muted-foreground">保留临时瓦片便于排查</p>
          </div>
          <Switch
            checked={debugMode}
            onCheckedChange={(v) => setValue('debug_mode', v, { shouldDirty: true })}
          />
        </div>
        <div className="flex items-center justify-between rounded-md border p-2.5">
          <div className="min-w-0 pr-2">
            <Label className="text-sm">允许无效 HTTPS 证书</Label>
            <p className="text-xs text-muted-foreground">仅在内网环境开启</p>
          </div>
          <Switch
            checked={allowInvalidCerts}
            onCheckedChange={(v) => setValue('allow_invalid_certs', v, { shouldDirty: true })}
          />
        </div>
        {allowInvalidCerts && (
          <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="size-4 shrink-0" />
            <span>已禁用 HTTPS 证书校验，确认你信任目标服务器。</span>
          </div>
        )}
      </PanelSection>

      <PanelSection icon={Database} title="瓦片缓存" description="浏览即缓存 / 离线复用">
        <TileCacheSection
          enabled={tileCacheEnabled}
          maxSizeMb={tileCacheMaxSizeMb}
          dir={tileCacheDir}
          onEnabledChange={(v) => setValue('tile_cache_enabled', v, { shouldDirty: true })}
          onMaxSizeMbChange={(v) => setValue('tile_cache_max_size_mb', v, { shouldDirty: true })}
          onDirChange={(v) => setValue('tile_cache_dir', v, { shouldDirty: true })}
        />
      </PanelSection>

      <div className="sticky bottom-0 -mx-3 border-t bg-background/95 px-3 py-2 backdrop-blur">
        <Button type="submit" className="w-full" disabled={!isDirty || mutation.isPending}>
          {mutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          保存
        </Button>
      </div>

      <PanelSection icon={LayoutGrid} title="其他" description="图源管理 / 关于">
        <div className="flex flex-wrap gap-2">
          <SourcesDialog />
          <AboutDialog />
        </div>
      </PanelSection>
    </form>
  )
}
