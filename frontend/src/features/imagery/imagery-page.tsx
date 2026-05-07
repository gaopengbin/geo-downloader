import { useEffect, useMemo, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, FolderOpen, Info, Loader2, Layers, SlidersHorizontal } from 'lucide-react'
import { ask as askDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
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

import { createDownloadTask, estimateDownload, probeTile } from '@/features/download/download-api'
import { buildSelectionCropPolygon } from '@/features/download/crop-utils'
import {
  BuildPyramidToggle,
  SelectionCropToggle,
  TiffCompressionSelect,
} from '@/features/download/output-controls'
import { RegionSelector } from '@/features/region/region-selector'
import { getSettings } from '@/features/settings/settings-api'
import { getTileSourcesMerged } from '@/features/sources/sources-api'
import { isMvtUrl } from '@/features/mvt/is-mvt-url'
import { useSelectionStore, type MapBounds } from '@/store/selection-store'
import { useMultiFeatureSubmit } from '@/features/region/use-multi-feature-submit'
import { DispatchModeRadio } from '@/features/region/dispatch-mode-radio'
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

const MVT_FORMAT_OPTIONS = [
  { value: 'pbf', label: 'PBF 瓦片目录 ({z}/{x}/{y}.pbf)' },
  { value: 'mbtiles', label: 'MBTiles (.mbtiles，format=pbf)' },
  { value: 'gpkg', label: 'GeoPackage (.gpkg，format=pbf)' },
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
  zoom_levels: z.array(z.number().int().min(1).max(22)).min(1, '请至少勾选一个缩放级别'),
  format: z.enum(['geotiff', 'png', 'jpeg', 'tiles', 'mbtiles', 'gpkg', 'pbf']),
  compression: z.enum(['none', 'lzw', 'deflate']),
  build_pyramid: z.boolean(),
  concurrency: z.number().int().min(1).max(100),
  save_path: z.string().min(1, '请填写保存路径'),
  task_name: z.string().optional(),
})

type DownloadFormValues = z.infer<typeof downloadSchema>

const DEFAULT_VALUES: DownloadFormValues = {
  source: '',
  zoom_levels: [15],
  format: 'geotiff',
  compression: 'lzw',
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

const FORMAT_EXT: Record<DownloadFormValues['format'], string> = {
  geotiff: 'tif',
  png: 'png',
  jpeg: 'jpg',
  tiles: '',
  mbtiles: 'mbtiles',
  gpkg: 'gpkg',
  pbf: '',
}

// 在文件名扩展名前、或者目录名末尾追加时间戳防重名覆盖
function tsStamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function appendTimestamp(path: string, format: DownloadFormValues['format']): string {
  if (!path) return path
  const ts = tsStamp()
  if (format === 'tiles' || format === 'pbf') {
    const sep = path.includes('\\') ? '\\' : '/'
    const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path
    return `${trimmed}_${ts}`
  }
  const sep = path.includes('\\') ? '\\' : '/'
  const lastSep = path.lastIndexOf(sep)
  const dotIdx = path.lastIndexOf('.')
  if (dotIdx > lastSep && dotIdx !== -1) {
    return `${path.slice(0, dotIdx)}_${ts}${path.slice(dotIdx)}`
  }
  return `${path}_${ts}`
}

function sanitizeFileBase(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'download'
}

// 当用户选择的是目录（多级别 / 多要素拆分），后端仍要求 save_path 为文件路径，
// 此处自动拼接默认文件名。已经是文件路径则原样返回。
function resolveSavePath(
  input: string,
  format: DownloadFormValues['format'],
  defaultBaseName = 'download',
): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return trimmed
  if (format === 'tiles' || format === 'pbf') return trimmed
  const ext = FORMAT_EXT[format] || 'tif'
  const lower = trimmed.toLowerCase()
  // 已含期望扩展名 → 视为文件
  if (ext && lower.endsWith(`.${ext}`)) return trimmed
  // 视为目录，拼接默认文件名
  const sep = trimmed.includes('\\') ? '\\' : '/'
  const base = `${sanitizeFileBase(defaultBaseName)}.${ext}`
  return trimmed.endsWith(sep) ? `${trimmed}${base}` : `${trimmed}${sep}${base}`
}

function BoundsInputs({ showError = true }: { showError?: boolean } = {}) {
  const bounds = useSelectionStore((s) => s.bounds)
  const polygon = useSelectionStore((s) => s.polygon)
  const setBoundsFromInputs = useSelectionStore((s) => s.setBoundsFromInputs)

  // 显示保留 4 位小数；本地输入文本与外部 bounds 解耦，避免破坏正在输入的内容
  const fmt = (n: number | undefined | null) =>
    n == null || !Number.isFinite(n) ? '' : Number(n.toFixed(4)).toString()
  const [text, setText] = useState({
    north: fmt(bounds?.north),
    south: fmt(bounds?.south),
    east: fmt(bounds?.east),
    west: fmt(bounds?.west),
  })
  // 当外部 bounds 变化（地图绘制/上传边界/行政区）时同步显示
  useEffect(() => {
    setText({
      north: fmt(bounds?.north),
      south: fmt(bounds?.south),
      east: fmt(bounds?.east),
      west: fmt(bounds?.west),
    })
  }, [bounds?.north, bounds?.south, bounds?.east, bounds?.west])

  const update = (key: keyof MapBounds, raw: string) => {
    setText((t) => ({ ...t, [key]: raw }))
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
          手动四至 (WGS-84)
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
            value={text.north}
            onChange={(e) => update('north', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="b-south" className="text-xs">南 S</Label>
          <Input
            id="b-south"
            type="number"
            step="0.0001"
            value={text.south}
            onChange={(e) => update('south', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="b-west" className="text-xs">西 W</Label>
          <Input
            id="b-west"
            type="number"
            step="0.0001"
            value={text.west}
            onChange={(e) => update('west', e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="b-east" className="text-xs">东 E</Label>
          <Input
            id="b-east"
            type="number"
            step="0.0001"
            value={text.east}
            onChange={(e) => update('east', e.target.value)}
          />
        </div>
      </div>
      {showError && bounds && !valid && (
        <p className="text-xs text-destructive">范围无效：N 必须大于 S，E 必须大于 W</p>
      )}
    </section>
  )
}

export function ImageryPage({ mode = 'imagery' }: { mode?: 'imagery' | 'dem' | 'mvt' } = {}) {
  const isDemMode = mode === 'dem'
  const isMvtMode = mode === 'mvt'
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const tiandituToken = settingsQuery.data?.tianditu_token ?? null
  const sourcesQuery = useQuery({
    queryKey: ['tile-sources-merged', tiandituToken],
    queryFn: () => getTileSourcesMerged(tiandituToken),
  })

  const sourceList = useMemo(() => {
    const all = Object.entries(sourcesQuery.data ?? {})
      .map(([k, v]) => ({ key: k, ...v }))
      .filter((s) => {
        const id = (s.id as string) ?? s.key
        if (isMvtMode) return isMvtUrl((s as { url?: string }).url)
        if (isDemMode) return isDemSource(id)
        return !isDemSource(id) && !isMvtUrl((s as { url?: string }).url)
      })
    return all.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [sourcesQuery.data, isDemMode, isMvtMode])

  const form = useForm<DownloadFormValues>({
    resolver: zodResolver(downloadSchema),
    defaultValues: DEFAULT_VALUES,
    mode: 'onSubmit',
    reValidateMode: 'onSubmit',
  })
  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { errors, submitCount },
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
    } else if (isMvtMode) {
      firstSourceId = sourceList[0]?.id ?? sourceList[0]?.key ?? ''
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
    if (typeof s.default_zoom === 'number') setValue('zoom_levels', [s.default_zoom])
    // 不再还原上次保存路径——每次默认为空，避免意外覆盖之前的下载。
    if (isDemMode) {
      setValue('format', 'geotiff')
    } else if (isMvtMode) {
      setValue('format', 'pbf')
      setValue('zoom_levels', [10, 11, 12, 13, 14])
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
  const zoomLevels = useWatch({ control, name: 'zoom_levels' }) ?? []
  const sortedLevels = useMemo(() => [...zoomLevels].sort((a, b) => a - b), [zoomLevels])
  const zoom = sortedLevels[0] ?? 15
  const zoomMax = sortedLevels[sortedLevels.length - 1] ?? zoom
  const compression = useWatch({ control, name: 'compression' })
  const buildPyramid = useWatch({ control, name: 'build_pyramid' })
  const concurrency = useWatch({ control, name: 'concurrency' })

  const [estimate, setEstimate] = useState<DownloadEstimate | null>(null)
  const [cropToShape, setCropToShape] = useState(true)
  const qc = useQueryClient()
  const dispatchCtx = useMultiFeatureSubmit()
  const supportsSelectionCrop = (format === 'geotiff' || format === 'png') && !isMvtMode
  const effectiveCropToShape = cropToShape && supportsSelectionCrop

  const submitMutation = useMutation({
    mutationFn: async (values: DownloadFormValues) => {
      const { bounds, polygon } = useSelectionStore.getState()
      if (!bounds) throw new Error('请先在地图上绘制选区')
      const sourceMeta = sourcesQuery.data?.[values.source]
      const levels = [...values.zoom_levels].sort((a, b) => a - b)
      const zMin = levels[0]
      const zMax = levels[levels.length - 1]
      // 探测选区中心瓦片是否有数据（按最高级别探测）
      const probeZoom = zMax
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

      const cropPolygon = buildSelectionCropPolygon(bounds, polygon, effectiveCropToShape)
      const levelLabel = levels.length === 1
        ? `z${zMin}`
        : (levels.length === zMax - zMin + 1 ? `z${zMin}~z${zMax}` : `z${levels.join(',')}`)
      const fallbackName = `${sourceMeta?.name ?? values.source} ${levelLabel}`
      const finalName = (values.task_name && values.task_name.trim()) || fallbackName
      const resolvedSavePath = resolveSavePath(
        values.save_path,
        values.format,
        finalName,
      )
      const request: DownloadRequest = {
        bounds,
        zoom: zMin,
        zoom_max: zMax > zMin ? zMax : null,
        zoom_levels: levels,
        source: values.source,
        format: values.format,
        save_path: appendTimestamp(resolvedSavePath, values.format),
        concurrency: values.concurrency,
        tianditu_token: settingsQuery.data?.tianditu_token ?? null,
        proxy:
          settingsQuery.data?.proxy_enabled && settingsQuery.data.proxy_url
            ? settingsQuery.data.proxy_url
            : null,
        crop_to_shape: cropPolygon != null,
        polygon: cropPolygon,
        compression: values.format === 'geotiff' ? values.compression : 'none',
        build_pyramid: values.format === 'geotiff' && values.build_pyramid,
      }
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

  const onSubmit = handleSubmit(async (v) => {
    try {
      await dispatchCtx.runSubmit(async (perFeatureName) => {
        if (perFeatureName == null) {
          await submitMutation.mutateAsync(v)
          return
        }
        // 拆分模式：把 save_path 视作目录，为每个要素拼接独立文件名
        const safe = perFeatureName.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'feature'
        const ext = FORMAT_EXT[v.format] || 'tif'
        const dir = (v.save_path ?? '').trim()
        let saveOverride = dir
        const isFolderOut = v.format === 'tiles' || v.format === 'pbf'
        if (dir && !isFolderOut) {
          const sep = dir.includes('\\') ? '\\' : '/'
          const fname = `${safe}.${ext}`
          saveOverride = dir.endsWith(sep) ? `${dir}${fname}` : `${dir}${sep}${fname}`
        } else if (dir && isFolderOut) {
          const sep = dir.includes('\\') ? '\\' : '/'
          saveOverride = dir.endsWith(sep) ? `${dir}${safe}` : `${dir}${sep}${safe}`
        }
        const overridden = {
          ...v,
          save_path: saveOverride,
          task_name: `${(v.task_name && v.task_name.trim()) || ''} - ${perFeatureName}`.replace(/^ - /, ''),
        }
        await submitMutation.mutateAsync(overridden)
      })
    } catch {
      /* errors are surfaced by submitMutation.onError */
    }
  })

  const pickSavePath = async () => {
    try {
      const chosen = await openDialog({
        directory: true,
        multiple: false,
        title: '选择保存目录',
      })
      if (chosen) {
        setValue('save_path', chosen as string, { shouldValidate: true })
      }
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
      const zMax = zoomMax > zoom ? zoomMax : null
      estimateDownload(bounds, zoom, format, effectiveCropToShape, zMax, sortedLevels)
        .then((data) => setEstimate(data))
        .catch(() => {
          /* 自动估算失败不打扰用户 */
        })
    }, 400)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, zoom, zoomMax, sortedLevels, format, cropToShape, polygon])

  // 同步当前选中的图源到全局 store（按当前 mode 记忆），让地图预览跟随切换
  useEffect(() => {
    if (source) useAppStore.getState().setSelectedSourceForMode(mode, source)
  }, [source, mode])

  // 同步影像下载参数到全局 store，供批量下载对话框读取
  const sourceMetaName =
    sourceList.find((s) => s.key === source)?.name ?? source
  useEffect(() => {
    if (isDemMode || isMvtMode) return
    useImageryParamsStore.getState().set({
      source,
      sourceName: sourceMetaName,
      zoom,
      zoomMax: zoomMax > zoom ? zoomMax : null,
      format: format as OutputFormat,
      compression: compression as 'none' | 'lzw' | 'deflate',
      buildPyramid: !!buildPyramid,
      cropToShape: effectiveCropToShape,
      concurrency,
    })
  }, [
    isDemMode,
    isMvtMode,
    source,
    sourceMetaName,
    zoom,
    zoomMax,
    format,
    compression,
    buildPyramid,
    effectiveCropToShape,
    concurrency,
  ])

  return (
    <div className="space-y-3">
      <RegionSelector
        extras={
          <div className="space-y-3 border-t border-border/60 pt-3">
            <BoundsInputs showError={submitCount > 0} />

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

            {supportsSelectionCrop && (
              <SelectionCropToggle
                bounds={bounds}
                polygon={polygon}
                checked={cropToShape}
                onChange={setCropToShape}
              />
            )}
          </div>
        }
      />

      <form className="space-y-3">
        <PanelSection icon={Layers} title="图源 / 缩放级别" description="选择瓦片源与下载级别" dataTour="imagery-source-section">
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

        {isMvtMode && (
          <p className="text-xs text-muted-foreground">
            MVT 数据已直接渲染到上方主地图（每个矢量图层随机配色）。仍可框选 bbox 进行下载。
          </p>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs">缩放级别（任意多选）</Label>
            <Badge variant="secondary" className="text-xs">
              已选 {sortedLevels.length} 级
              {sortedLevels.length > 0
                ? ` · ${sortedLevels.length === 1
                    ? `z${sortedLevels[0]} (${zoomLevelLabel(sortedLevels[0])})`
                    : `z${sortedLevels[0]}~z${sortedLevels[sortedLevels.length - 1]}`}`
                : ''}
            </Badge>
          </div>
          <Controller
            control={control}
            name="zoom_levels"
            render={({ field }) => {
              const set = new Set(field.value ?? [])
              const toggle = (z: number) => {
                const next = new Set(set)
                if (next.has(z)) next.delete(z)
                else next.add(z)
                field.onChange(Array.from(next).sort((a, b) => a - b))
              }
              const selectRange = (a: number, b: number) => {
                const arr: number[] = []
                for (let z = a; z <= b; z++) arr.push(z)
                field.onChange(arr)
              }
              const clear = () => field.onChange([])
              return (
                <div className="space-y-2">
                  <div className="grid grid-cols-11 gap-1">
                    {Array.from({ length: 22 }, (_, i) => i + 1).map((z) => {
                      const checked = set.has(z)
                      return (
                        <button
                          key={z}
                          type="button"
                          onClick={() => toggle(z)}
                          className={`h-7 rounded border text-xs transition ${
                            checked
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-background text-foreground hover:bg-muted'
                          }`}
                          title={`z${z} · ${zoomLevelLabel(z)}级`}
                        >
                          {z}
                        </button>
                      )
                    })}
                  </div>
                  <div className="flex flex-wrap gap-1 text-xs">
                    <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted" onClick={() => selectRange(10, 14)}>z10~14</button>
                    <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted" onClick={() => selectRange(14, 18)}>z14~18</button>
                    <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted" onClick={() => selectRange(15, 19)}>z15~19</button>
                    <button type="button" className="rounded border px-2 py-0.5 hover:bg-muted text-muted-foreground" onClick={clear}>清空</button>
                  </div>
                </div>
              )
            }}
          />
          {errors.zoom_levels && (
            <p className="text-xs text-destructive">{errors.zoom_levels.message as string}</p>
          )}
          <p className="text-xs text-muted-foreground">点击数字勾选/取消，可任意离散组合（如 10、15、18 同时下载）。</p>
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

        <PanelSection icon={SlidersHorizontal} title="输出参数" description="格式 / 压缩 / 路径" dataTour="imagery-output-section">
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
              {(isMvtMode ? MVT_FORMAT_OPTIONS : FORMAT_OPTIONS).map((opt) => (
                <SelectItem key={opt.value} value={opt.value} disabled={isDemMode && opt.value !== 'geotiff'}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isDemMode && (
            <p className="text-xs text-muted-foreground">DEM 仅支持 GeoTIFF Float32 单波段输出</p>
          )}
          {isMvtMode && (
            <p className="text-xs text-muted-foreground">矢量瓦片不拼接/不重编码，PBF 原始字节原样保存</p>
          )}
        </div>

        {format === 'geotiff' && (
          <>
            <TiffCompressionSelect
              value={compression as DownloadFormValues['compression']}
              onChange={(v) =>
                setValue('compression', v, {
                  shouldDirty: true,
                })
              }
            />
            <BuildPyramidToggle
              checked={!!buildPyramid}
              onChange={(checked) =>
                setValue('build_pyramid', checked, { shouldDirty: true })
              }
            />
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

        {dispatchCtx.showModeSelector && (
          <DispatchModeRadio
            count={dispatchCtx.features?.length ?? 0}
            mode={dispatchCtx.mode}
            onChange={dispatchCtx.setMode}
          />
        )}

        <div className="space-y-1.5">
          <Label htmlFor="save_path" className="text-xs">
            保存目录
          </Label>
          <div className="flex gap-1.5">
            <Input
              id="save_path"
              className="font-mono text-xs"
              {...register('save_path')}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              title="选择保存目录"
              onClick={pickSavePath}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </div>
          {errors.save_path && (
            <p className="text-xs text-destructive">{errors.save_path.message}</p>
          )}
          <p className="text-[11px] text-muted-foreground">
            选择目录后会自动生成文件名；也可手动输入完整文件路径。
          </p>
        </div>
        </PanelSection>

        <div className="sticky bottom-0 -mx-3 -mb-3 mt-2 flex items-center gap-2 border-t border-border/60 bg-background/95 px-3 py-2.5 backdrop-blur" data-tour="imagery-submit-bar">
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
