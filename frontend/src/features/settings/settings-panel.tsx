import { useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Code2, Database, ExternalLink, KeyRound, LayoutGrid, Loader2, ShieldAlert, SlidersHorizontal, Wifi, Wrench } from 'lucide-react'
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
import {
  deleteAssistantApiKey,
  getAssistantSecretStatus,
  getSettings,
  getSystemMemory,
  saveSettings,
  setAssistantApiKey,
} from './settings-api'
import { TileCacheSection } from './tile-cache-section'
import { useImageryParamsStore } from '@/store/imagery-params-store'
import type { AppSettings } from '@/types/api'

const FORMAT_OPTIONS = [
  { value: 'geotiff', label: 'GeoTIFF (.tif)' },
  { value: 'tiles', label: '原始瓦片目录' },
  { value: 'mbtiles', label: 'MBTiles (.mbtiles)' },
  { value: 'gpkg', label: 'GeoPackage (.gpkg)' },
] as const

const settingsSchema = z
  .object({
    tianditu_token: z.string().trim(),
    cesium_ion_token: z.string().trim(),
    ai_assistant_enabled: z.boolean(),
    ai_base_url: z.string().trim(),
    ai_model: z.string().trim().min(1, '请输入模型名称'),
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
        message: '请输入有效的 HTTP 或 HTTPS API 地址',
      })
    }
  })

type SettingsFormValues = z.infer<typeof settingsSchema>

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
        throw new Error('开启助手前请配置 DeepSeek API Key')
      }
      if (newApiKey) await setAssistantApiKey(newApiKey)
      await saveSettings(toAppSettings(values, settingsQuery.data))
    },
    onSuccess: (_d, values) => {
      toast.success('设置已保存')
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
      toast.error(`保存失败：${msg}`)
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
      toast.success('DeepSeek API Key 已从系统凭据库移除，请保存以停用助手')
    },
    onError: (err: unknown) => {
      toast.error(`移除失败：${err instanceof Error ? err.message : String(err)}`)
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
    <form
      onSubmit={onSubmit}
      className="space-y-3"
      data-agent-target="settings-panel"
    >
      <PanelSection
        icon={KeyRound}
        title="访问令牌"
        description="天地图 / Cesium Ion"
        dataAgentTarget="settings-tokens"
      >
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
        dataAgentTarget="settings-proxy"
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
        dataAgentTarget="settings-download"
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
            <Label>空白瓦片探测</Label>
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
                <SelectItem value="continue">自动继续（默认）</SelectItem>
                <SelectItem value="ask">每次询问</SelectItem>
                <SelectItem value="cancel">停止创建任务</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              探测仅采样选区中心的一张最高级别瓦片，可能误判。自动继续不会弹窗阻塞下载。
            </p>
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
          {/* Issue #31：自动导出最低成功率阈值 */}
          <div className="space-y-1.5 sm:col-span-2">
            <div className="flex items-center justify-between">
              <Label>自动导出最低成功率</Label>
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
              下载结束时成功率达到此值才自动导出。
              <strong className="text-foreground/80">0%</strong>
              （默认）= 有 1 张成功就导，
              <strong className="text-foreground/80">100%</strong>
              = 必须全成功才导，否则进入待决策状态。
            </p>
          </div>
          {/* Issue #27：流式导出并行流水线缓冲 */}
          <div className="space-y-1.5 sm:col-span-2">
            <div className="flex items-center justify-between">
              <Label>导出流水线缓冲</Label>
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
              跨 strip 并行解码/压缩的总内存上限。越大越能让 IO 与 CPU 重叠，
              大区导出提速，代价是内存峰值上升。默认
              <strong className="text-foreground/80"> 64 MB</strong>，
              瓦片量大、内存充足时可调到 128~256。
            </p>
          </div>
        </div>
      </PanelSection>

      <PanelSection
        icon={Code2}
        title="开发者选项"
        description="实验性功能"
        dataAgentTarget="settings-developer"
      >
        <div className="flex items-center justify-between rounded-md border p-2.5">
          <div className="min-w-0 pr-2">
            <Label className="text-sm">GeoD AI 助手</Label>
            <p className="text-xs text-muted-foreground">默认关闭，开启后显示顶部助手入口</p>
          </div>
          <Switch
            checked={aiAssistantEnabled}
            aria-label="启用 GeoD AI 助手"
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
                    ? '检查中'
                    : secretQuery.data?.configured
                      ? '已安全保存'
                      : '未配置'}
                </span>
              </div>
              <Input
                id="deepseek_api_key"
                type="password"
                placeholder={
                  secretQuery.data?.configured ? '留空则保留现有 Key' : 'sk-...'
                }
                autoComplete="new-password"
                spellCheck={false}
                {...register('deepseek_api_key')}
              />
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs leading-5 text-muted-foreground">
                  Key 保存到操作系统凭据库，不写入 GeoD 设置文件。
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
                    {deleteApiKeyMutation.isPending ? '移除中' : '移除 Key'}
                  </Button>
                )}
              </div>
              {errors.deepseek_api_key && (
                <p className="text-xs text-destructive">{errors.deepseek_api_key.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai_base_url">API 地址</Label>
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
              <Label htmlFor="ai_model">模型</Label>
              <Input
                id="ai_model"
                placeholder="deepseek-v4-flash"
                autoComplete="off"
                spellCheck={false}
                {...register('ai_model')}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                GeoD 在本机检索知识库，并由桌面端直接请求模型；费用由该 Key
                所属账户承担。
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
        title="高级"
        description="调试 / 证书校验"
        dataAgentTarget="settings-advanced"
      >
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

      <PanelSection
        icon={Database}
        title="瓦片缓存"
        description="浏览即缓存 / 离线复用"
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

      <div className="sticky bottom-0 -mx-3 border-t bg-background/95 px-3 py-2 backdrop-blur">
        <Button type="submit" className="w-full" disabled={!isDirty || mutation.isPending}>
          {mutation.isPending && <Loader2 className="mr-1 size-3.5 animate-spin" />}
          保存
        </Button>
      </div>

      <PanelSection
        icon={LayoutGrid}
        title="其他"
        description="图源管理 / 关于"
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
            <DialogTitle>启用 GeoD AI 助手前请确认</DialogTitle>
            <DialogDescription>
              这是开发者实验功能。请阅读以下免责声明与隐私声明，再决定是否启用。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <section className="space-y-1.5 rounded-md border p-3">
              <h3 className="font-medium">免责声明</h3>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                <li>AI 回答可能存在错误、遗漏或过时信息，不构成专业建议或结果保证。</li>
                <li>涉及下载、数据授权、参数修改和文件操作时，请自行核验后再执行。</li>
                <li>模型调用费用由你的 DeepSeek 账户承担，GeoD 不承担额度消耗或损失。</li>
              </ul>
              <a
                href="https://geodownloader.pages.dev/disclaimer.html"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                查看完整使用条款与免责声明
                <ExternalLink className="size-3" />
              </a>
            </section>

            <section className="space-y-1.5 rounded-md border p-3">
              <h3 className="font-medium">隐私声明</h3>
              <ul className="list-disc space-y-1 pl-5 text-xs leading-5 text-muted-foreground">
                <li>DeepSeek API Key 保存在操作系统凭据库，不写入 GeoD 设置文件。</li>
                <li>
                  对话内容和你主动附加的运行环境信息会由 GeoD 桌面端直接发送到所配置的
                  AI 服务。
                </li>
                <li>GeoD 内置知识库检索在本机完成；第三方 AI 服务适用其自身条款和隐私政策。</li>
                <li>请勿输入密码、个人隐私、商业秘密或未经授权的敏感地理数据。</li>
              </ul>
            </section>

            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-3">
              <input
                type="checkbox"
                checked={aiConsentAccepted}
                className="mt-0.5 size-4 shrink-0 accent-primary"
                onChange={(event) => setAiConsentAccepted(event.target.checked)}
              />
              <span className="text-xs leading-5">
                我已阅读、理解并同意上述免责声明与隐私声明，确认使用自己的 DeepSeek
                API Key 启用此实验功能。
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAiConsentOpen(false)}>
              暂不启用
            </Button>
            <Button type="button" disabled={!aiConsentAccepted} onClick={confirmAiAssistant}>
              同意并启用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={apiKeyDeleteOpen} onOpenChange={setApiKeyDeleteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>移除 DeepSeek API Key？</DialogTitle>
            <DialogDescription>
              Key 将从操作系统凭据库中删除，GeoD 助手随即无法继续调用模型。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setApiKeyDeleteOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteApiKeyMutation.isPending}
              onClick={() => deleteApiKeyMutation.mutate()}
            >
              {deleteApiKeyMutation.isPending ? '正在移除' : '确认移除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  )
}
