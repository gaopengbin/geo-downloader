import { useEffect, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, FolderOpen, Info, Loader2, Map as MapIcon, Layers, SlidersHorizontal } from 'lucide-react'
import { ask as askDialog, open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { toast } from 'sonner'
import { z } from 'zod'

import { Badge } from '@/components/ui/badge'
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
import { Slider } from '@/components/ui/slider'
import { createDownloadTask, estimateDownload, probeTile } from '@/features/download/download-api'
import { RegionSelector } from '@/features/region/region-selector'
import { getSettings } from '@/features/settings/settings-api'
import { getTileSourcesMerged } from '@/features/sources/sources-api'
import { useSelectionStore, type MapBounds } from '@/store/selection-store'
import { useAppStore, type AppMode } from '@/store/app-store'
import { useImageryParamsStore } from '@/store/imagery-params-store'
import type { DownloadEstimate, DownloadRequest, OutputFormat } from '@/types/api'
import { StatCard } from '@/components/layout/stat-card'
import { PanelSection } from '@/components/layout/panel-section'

const FORMAT_OPTIONS = [
  { value: 'geotiff', label: 'GeoTIFF (.tif)' },
  { value: 'png', label: 'PNG (.png)' },
  { value: 'jpeg', label: 'JPEG (.jpg)' },
  { value: 'tiles', label: '原始瓦片目录' },
  { value: 'mbtiles', label: 'MBTiles (.mbtiles)' },
  { value: 'gpkg', label: 'GeoPackage (.gpkg)' },
] as const

const COMPRESSION_OPTIONS = [
  { value: 'none', label: '无压缩 (最快导出)' },
  { value: 'lzw', label: 'LZW (通用兼容)' },
  { value: 'deflate', label: 'Deflate (体积最小)' },
] as const

function zoomLevelLabel(z: number): string {
  if (z <= 3) return '全球'
  if (z <= 5) return '大洲'
  if (z <= 7) return '国家'
  if (z <= 9) return '省域'
  if (z <= 11) return '城市'
  if (z <= 13) return '区县'
  if (z <= 15) return '街道'
  if (z <= 17) return '建筑'
  if (z <= 19) return '细节'
  return '超清'
}

// GCJ-02 偏移图源（中国区域）
const GCJ02_SOURCES = new Set(['google_map', 'gaode_map', 'gaode_satellite'])

// DEM 源识别，与后端 dem::is_dem_source 保持一致
function isDemSource(key: string): boolean {
  return key === 'dem_terrarium'
}

// 近似计算选区面积（km²）
function estimateAreaKm2(b: MapBounds): number {
  if (!b) return 0
  const dLat = Math.abs(b.north - b.south)
  const dLng = Math.abs(b.east - b.west)
  const meanLat = (b.north + b.south) / 2
  // 1° lat ≈ 111.32 km, 1° lng ≈ 111.32 * cos(lat) km
  const km = dLat * 111.32 * (dLng * 111.32 * Math.cos((meanLat * Math.PI) / 180))
  return km
}

const downloadSchema = z.object({
  source: z.string().min(1, '请选择图源'),
  zoom: z.number().int().min(1).max(22),
  zoom_max_enabled: z.boolean(),
  zoom_max: z.number().int().min(1).max(22),
  format: z.enum(['geotiff', 'png', 'jpeg', 'tiles', 'mbtiles', 'gpkg']),
  compression: z.enum(['none', 'lzw', 'deflate']),
  build_pyramid: z.boolean(),
  concurrency: z.number().int().min(1).max(100),
  save_path: z.string().min(1, '请填写保存路径'),
  task_name: z.string().optional(),
}).refine((v) => !v.zoom_max_enabled || v.zoom_max >= v.zoom, {
  message: '最大缩放必须 ≥ 起始缩放',
  path: ['zoom_max'],
})

type DownloadFormValues = z.infer<typeof downloadSchema>

const DEFAULT_VALUES: DownloadFormValues = {
  source: '',
  zoom: 15,
  zoom_max_enabled: false,
  zoom_max: 16,
  format: 'geotiff',
  compression: 'none',
  build_pyramid: false,
  concurrency: 30,
  save_path: '',
  task_name: '',
}

function formatBytes(mb?: number | null): string {
  if (mb == null || !Number.isFinite(mb)) return '-'
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(2)} MB`
}

function BoundsInputs() {
  const bounds = useSelectionStore((s) => s.bounds)
  const polygon = useSelectionStore((s) => s.polygon)
  const setBoundsFromInputs = useSelectionStore((s) => s.setBoundsFromInputs)

  const update = (key: keyof MapBounds, raw: string) => {
    const v = Number(raw)
    if (!Number.isFinite(v)) return
    const base: MapBounds = bounds ?? { north: 0, south: 0, east: 0, west: 0 }
    setBoundsFromInputs({ ...base, [key]: v })
  }

  const valid = bounds && bounds.north > bounds.south && bounds.east > bounds.west

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          范围 (WGS-84)
        </h3>
        {polygon && (
          <Badge variant="outline" className="text-xs">
            多边形 {polygon[0]?.length ?? 0} 点
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="b-north" className="text-xs">北 N</Label>
          <Input
            id="b-north"
            type="number"
            step="0.0001"
            value={bounds?.north ?? ''}
            onChange={(e) => update('north', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="b-south" className="text-xs">南 S</Label>
          <Input
            id="b-south"
            type="number"
            step="0.0001"
            value={bounds?.south ?? ''}
            onChange={(e) => update('south', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="b-west" className="text-xs">西 W</Label>
          <Input
            id="b-west"
            type="number"
            step="0.0001"
            value={bounds?.west ?? ''}
            onChange={(e) => update('west', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="b-east" className="text-xs">东 E</Label>
          <Input
            id="b-east"
            type="number"
            step="0.0001"
            value={bounds?.east ?? ''}
            onChange={(e) => update('east', e.target.value)}
          />
        </div>
      </div>
      {!valid && (
        <p className="text-xs text-destructive">范围无效：N 必须大于 S，E 必须大于 W</p>
      )}
    </section>
  )
}

export function ImageryPage({ mode = 'imagery' }: { mode?: 'imagery' | 'dem' } = {}) {
  const isDemMode = mode === 'dem'
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const tiandituToken = settingsQuery.data?.tianditu_token ?? null
  const sourcesQuery = useQuery({
    queryKey: ['tile-sources-merged', tiandituToken],
    queryFn: () => getTileSourcesMerged(tiandituToken),
  })

  const sourceList = useMemo(() => {
    const all = Object.entries(sourcesQuery.data ?? {})
      .map(([k, v]) => ({ key: k, ...v }))
      .filter((s) => isDemSource((s.id as string) ?? s.key) === isDemMode)
    return all.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [sourcesQuery.data, isDemMode])

  const form = useForm<DownloadFormValues>({
    resolver: zodResolver(downloadSchema),
    defaultValues: DEFAULT_VALUES,
  })
  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { errors },
  } = form

  const [initedForMode, setInitedForMode] = useState<AppMode | null>(null)
  useEffect(() => {
    if (initedForMode === mode) return
    if (!settingsQuery.data || !sourcesQuery.data || sourceList.length === 0) return
    const s = settingsQuery.data
    // 优先从 store 中取本 mode 上次选中的图源（切换 tab 后回来要还原）
    const remembered = useAppStore.getState().selectedSourceByMode[mode] ?? null
    const isValidRemembered =
      remembered != null &&
      sourcesQuery.data[remembered] != null &&
      (isDemMode ? isDemSource(remembered) : !isDemSource(remembered))

    let firstSourceId: string
    if (isValidRemembered) {
      firstSourceId = remembered as string
    } else if (isDemMode) {
      firstSourceId =
        sourceList.find((x) => ((x.id as string) ?? x.key) === 'dem_terrarium')?.id ??
        sourceList[0]?.id ??
        sourceList[0]?.key ??
        ''
    } else {
      firstSourceId =
        (s.default_source && sourcesQuery.data[s.default_source] && !isDemSource(s.default_source)
          ? s.default_source
          : null) ??
        sourceList[0]?.id ??
        sourceList[0]?.key ??
        ''
    }
    setValue('source', firstSourceId ?? '')
    if (typeof s.default_concurrency === 'number') setValue('concurrency', s.default_concurrency)
    if (typeof s.default_zoom === 'number') setValue('zoom', s.default_zoom)
    if (isDemMode) {
      setValue('format', 'geotiff')
    } else {
      const fmt = (s.default_format ?? 'geotiff') as OutputFormat
      if (['geotiff', 'png', 'jpeg', 'tiles', 'mbtiles', 'gpkg'].includes(fmt as string)) {
        setValue('format', fmt as DownloadFormValues['format'])
      }
    }
    setInitedForMode(mode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, settingsQuery.data, sourcesQuery.data, sourceList])

  const source = useWatch({ control, name: 'source' })
  const format = useWatch({ control, name: 'format' })
  const zoom = useWatch({ control, name: 'zoom' })
  const zoomMax = useWatch({ control, name: 'zoom_max' })
  const zoomMaxEnabled = useWatch({ control, name: 'zoom_max_enabled' })
  const compression = useWatch({ control, name: 'compression' })
  const buildPyramid = useWatch({ control, name: 'build_pyramid' })
  const concurrency = useWatch({ control, name: 'concurrency' })

  const [estimate, setEstimate] = useState<DownloadEstimate | null>(null)
  const [cropToShape, setCropToShape] = useState(false)
  const qc = useQueryClient()

  const submitMutation = useMutation({
    mutationFn: async (values: DownloadFormValues) => {
      const { bounds, polygon } = useSelectionStore.getState()
      if (!bounds) throw new Error('请先在地图上绘制选区')
      const sourceMeta = sourcesQuery.data?.[values.source]
      // 探测选区中心瓦片是否有数据
      const probeZoom = values.zoom_max_enabled ? values.zoom_max : values.zoom
      const centerLat = (bounds.north + bounds.south) / 2
      const centerLng = (bounds.east + bounds.west) / 2
      try {
        const probe = await probeTile(
          values.source,
          probeZoom,
          centerLat,
          centerLng,
          settingsQuery.data?.tianditu_token ?? null,
          settingsQuery.data?.proxy_enabled && settingsQuery.data.proxy_url
            ? settingsQuery.data.proxy_url
            : null,
        )
        if (!probe.has_data) {
          const maxZoom = sourceMeta?.max_zoom ?? '?'
          const proceed = await askDialog(
            `探测发现该区域在 z${probeZoom} 可能无数据\n${probe.message ?? ''}\n\n该图源最高支持 z${maxZoom}，但部分区域实际覆盖可能低于此级别。\n建议降低缩放级别后重试。\n\n是否仍然继续下载？`,
            { title: '瓦片探测警告', kind: 'warning' },
          )
          if (!proceed) throw new Error('__user_cancelled__')
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        if (m === '__user_cancelled__') throw e
        // 探测本身失败不阻断下载，仅提示
        toast.warning(`瓦片探测失败：${m}`)
      }

      const request: DownloadRequest = {
        bounds,
        zoom: values.zoom,
        zoom_max: values.zoom_max_enabled ? values.zoom_max : null,
        source: values.source,
        format: values.format,
        save_path: values.save_path,
        concurrency: values.concurrency,
        tianditu_token: settingsQuery.data?.tianditu_token ?? null,
        proxy:
          settingsQuery.data?.proxy_enabled && settingsQuery.data.proxy_url
            ? settingsQuery.data.proxy_url
            : null,
        crop_to_shape: cropToShape && polygon != null,
        polygon: cropToShape && polygon ? polygon : null,
        compression: values.format === 'geotiff' ? values.compression : 'none',
        build_pyramid: values.format === 'geotiff' && values.build_pyramid,
      }
      const fallbackName = `${sourceMeta?.name ?? values.source} z${values.zoom}${
        values.zoom_max_enabled && values.zoom_max && values.zoom_max > values.zoom
          ? `~z${values.zoom_max}`
          : ''
      }`
      const finalName = (values.task_name && values.task_name.trim()) || fallbackName
      return createDownloadTask(request, finalName, sourceMeta?.name ?? values.source)
    },
    onSuccess: (res) => {
      toast.success(`任务已创建（${res.task_id.slice(0, 8)}），瓦片 ${res.tile_count}`)
      // 自动跳转到下载中心，刷新任务列表
      useAppStore.getState().setTab('history')
      qc.invalidateQueries({ queryKey: ['active-tasks'] })
      qc.invalidateQueries({ queryKey: ['resumable-tasks'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === '__user_cancelled__') return
      toast.error(`创建任务失败：${msg}`)
    },
  })

  const onSubmit = handleSubmit((v) => submitMutation.mutate(v))

  const pickSavePath = async () => {
    const fmt = (form.getValues('format') ?? 'geotiff') as DownloadFormValues['format']
    const extMap: Record<DownloadFormValues['format'], { ext: string; name: string }> = {
      geotiff: { ext: 'tif', name: 'GeoTIFF' },
      png: { ext: 'png', name: 'PNG' },
      jpeg: { ext: 'jpg', name: 'JPEG' },
      tiles: { ext: '', name: '瓦片目录' },
      mbtiles: { ext: 'mbtiles', name: 'MBTiles' },
      gpkg: { ext: 'gpkg', name: 'GeoPackage' },
    }
    const meta = extMap[fmt]
    try {
      let chosen: string | null = null
      if (fmt === 'tiles') {
        const r = await openDialog({ directory: true, multiple: false })
        chosen = typeof r === 'string' ? r : null
      } else {
        const current = form.getValues('save_path')
        const defaultName = current && current.trim() ? current : `download.${meta.ext}`
        chosen = await saveDialog({
          defaultPath: defaultName,
          filters: meta.ext
            ? [{ name: meta.name, extensions: [meta.ext] }]
            : undefined,
        })
      }
      if (chosen) setValue('save_path', chosen, { shouldValidate: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`选择路径失败：${msg}`)
    }
  }

  const sourcesLoading = sourcesQuery.isLoading || settingsQuery.isLoading
  const polygon = useSelectionStore((s) => s.polygon)
  const bounds = useSelectionStore((s) => s.bounds)

  const showGcj02 = !isDemMode && GCJ02_SOURCES.has(source)
  const areaKm2 = bounds ? estimateAreaKm2(bounds) : 0

  // 自动估算：bounds / zoom / format 等参数变化后 400ms 防抖触发
  useEffect(() => {
    if (!bounds) {
      setEstimate(null)
      return
    }
    const handle = window.setTimeout(() => {
      const zMax = zoomMaxEnabled && typeof zoomMax === 'number' ? zoomMax : null
      estimateDownload(bounds, zoom, format, cropToShape && polygon != null, zMax)
        .then((data) => setEstimate(data))
        .catch(() => {
          /* 自动估算失败不打扰用户 */
        })
    }, 400)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, zoom, zoomMax, zoomMaxEnabled, format, cropToShape, polygon])

  // 同步当前选中的图源到全局 store（按当前 mode 记忆），让地图预览跟随切换
  useEffect(() => {
    if (source) useAppStore.getState().setSelectedSourceForMode(mode, source)
  }, [source, mode])

  // 同步影像下载参数到全局 store，供批量下载对话框读取
  const sourceMetaName =
    sourceList.find((s) => s.key === source)?.name ?? source
  useEffect(() => {
    if (isDemMode) return
    useImageryParamsStore.getState().set({
      source,
      sourceName: sourceMetaName,
      zoom,
      zoomMax: zoomMaxEnabled ? zoomMax : null,
      format: format as OutputFormat,
      compression: compression as 'none' | 'lzw' | 'deflate',
      buildPyramid: !!buildPyramid,
      cropToShape,
      concurrency,
    })
  }, [
    isDemMode,
    source,
    sourceMetaName,
    zoom,
    zoomMax,
    zoomMaxEnabled,
    format,
    compression,
    buildPyramid,
    cropToShape,
    concurrency,
  ])

  return (
    <div className="space-y-3">
      <RegionSelector />

      <PanelSection icon={MapIcon} title="下载选区" description="WGS-84 经纬度 / 多边形裁剪">
        <BoundsInputs />

        {bounds && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Info className="size-3.5" /> 选区面积
            </span>
            <span className="font-mono">
              <span className="font-semibold text-foreground">{areaKm2.toFixed(2)}</span>
              <span className="ml-0.5 text-muted-foreground">km²</span>
              {polygon && polygon.length > 0 && (
                <span className="ml-2 text-muted-foreground">
                  · {polygon[0]?.length ?? 0} 顶点
                </span>
              )}
            </span>
          </div>
        )}

        {showGcj02 && (
          <div className="flex gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span>该图源中国区域使用 GCJ-02 坐标系，与行政边界存在偏移</span>
          </div>
        )}

        {polygon && (
          <label className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
            <input
              type="checkbox"
              checked={cropToShape}
              onChange={(e) => setCropToShape(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            按多边形精确裁剪 (crop_to_shape)
          </label>
        )}
      </PanelSection>

      <form className="space-y-3">
        <PanelSection icon={Layers} title="图源 / 缩放级别" description="选择瓦片源与下载级别">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">图源</Label>
          <Select
            value={source}
            onValueChange={(v) => setValue('source', v, { shouldValidate: true })}
            disabled={sourcesLoading}
          >
            <SelectTrigger>
              <SelectValue placeholder={sourcesLoading ? '加载中...' : '请选择'} />
            </SelectTrigger>
            <SelectContent>
              {sourceList.map((s) => {
                const id = s.id ?? s.key ?? ''
                return (
                  <SelectItem key={id} value={id}>
                    {s.name}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          {errors.source && <p className="text-xs text-destructive">{errors.source.message}</p>}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">缩放级别</Label>
            <Badge variant="secondary" className="text-xs">
              z{zoom}
              {zoomMaxEnabled && zoomMax > zoom ? `~z${zoomMax}` : ''} · {zoomLevelLabel(zoom)}级
            </Badge>
          </div>
          <Slider
            min={1}
            max={22}
            step={1}
            value={[zoom]}
            onValueChange={(v) => setValue('zoom', v[0] ?? 1, { shouldValidate: true })}
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>1</span>
            <span>12</span>
            <span>22</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="zoom_max" className="text-xs">截止级别（多级下载）</Label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                {...register('zoom_max_enabled')}
                className="size-3"
              />
              启用
            </label>
          </div>
          <Input
            id="zoom_max"
            type="number"
            min={1}
            max={22}
            disabled={!zoomMaxEnabled}
            {...register('zoom_max', { valueAsNumber: true })}
          />
          {errors.zoom_max && (
            <p className="text-xs text-destructive">{errors.zoom_max.message}</p>
          )}
          <p className="text-xs text-muted-foreground">填写大于当前级别的数值时，将按 z 起点到截止级别逐级下载。</p>
        </div>

        {/* 自动估算结果 — 紧跟缩放级别 */}
        {bounds && (
          <StatCard>
            {estimate ? (
              <>
                <div className="grid grid-cols-2 gap-y-1">
                  <div>
                    瓦片数：
                    <Badge variant="secondary" className="ml-1">
                      {estimate.tile_count.toLocaleString()}
                    </Badge>
                  </div>
                  <div>
                    网格：{estimate.cols ?? '-'} × {estimate.rows ?? '-'}
                  </div>
                  <div>预估大小：{formatBytes(estimate.estimated_size_mb)}</div>
                  {estimate.raw_size_mb != null && (
                    <div>原始未压缩：{formatBytes(estimate.raw_size_mb)}</div>
                  )}
                </div>
                {estimate.size_note && (
                  <p className="mt-1 text-muted-foreground">{estimate.size_note}</p>
                )}
                {estimate.warning && (
                  <div className="mt-1 flex gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <span>{estimate.warning}</span>
                  </div>
                )}
                {estimate.budget_check && estimate.budget_check.allowed === false && (
                  <div className="mt-1 flex gap-1.5 rounded border border-destructive/40 bg-destructive/10 p-1.5 text-destructive">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <span>{estimate.budget_check.message ?? '内存预算不足'}</span>
                  </div>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">估算中…</span>
            )}
          </StatCard>
        )}
        </PanelSection>

        <PanelSection icon={SlidersHorizontal} title="输出参数" description="格式 / 并发 / 压缩 / 路径">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs">输出格式</Label>
            <Select
              value={format}
              onValueChange={(v) =>
                setValue('format', v as DownloadFormValues['format'], { shouldValidate: true })
              }
              disabled={isDemMode}
            >
              <SelectTrigger title={isDemMode ? 'DEM 仅支持 GeoTIFF Float32 输出' : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMAT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} disabled={isDemMode && opt.value !== 'geotiff'}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isDemMode && (
              <p className="text-xs text-muted-foreground">DEM 仅支持 GeoTIFF Float32 单波段输出</p>
            )}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">并发</Label>
              <Badge variant="outline" className="text-xs">{concurrency}</Badge>
            </div>
            <Slider
              min={10}
              max={100}
              step={5}
              value={[concurrency]}
              onValueChange={(v) => setValue('concurrency', v[0] ?? 30, { shouldValidate: true })}
            />
          </div>
        </div>

        {format === 'geotiff' && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">TIFF 压缩</Label>
              <Select
                value={compression}
                onValueChange={(v) =>
                  setValue('compression', v as DownloadFormValues['compression'], {
                    shouldDirty: true,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPRESSION_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={buildPyramid}
                onChange={(e) =>
                  setValue('build_pyramid', e.target.checked, { shouldDirty: true })
                }
                className="size-3.5"
              />
              构建影像金字塔（加速 GIS 浏览）
            </label>
          </>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="task_name" className="text-xs">
            任务名称 <span className="text-muted-foreground">(可选)</span>
          </Label>
          <Input
            id="task_name"
            placeholder="留空则自动生成，例如 天地图影像 z15"
            {...register('task_name')}
          />
          {errors.task_name && (
            <p className="text-xs text-destructive">{errors.task_name.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="save_path" className="text-xs">保存路径</Label>
          <div className="flex gap-1.5">
            <Input
              id="save_path"
              placeholder="C:\\Downloads\\beijing.tif"
              className="font-mono text-xs"
              {...register('save_path')}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              title="选择保存路径"
              onClick={pickSavePath}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
          {errors.save_path && (
            <p className="text-xs text-destructive">{errors.save_path.message}</p>
          )}
        </div>
        </PanelSection>

        <div className="sticky bottom-0 -mx-3 -mb-3 mt-2 flex items-center gap-2 border-t border-border/60 bg-background/95 px-3 py-2.5 backdrop-blur">
          <Button
            type="button"
            className="flex-1 shadow-sm"
            onClick={onSubmit}
            disabled={submitMutation.isPending || sourcesLoading}
          >
            {submitMutation.isPending ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Download className="mr-1.5 size-4" />
            )}
            创建下载任务
          </Button>
        </div>
      </form>
    </div>
  )
}
